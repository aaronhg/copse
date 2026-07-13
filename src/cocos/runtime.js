// @ts-check
// The Cocos `cc.*` adapter for copse + the `window.__copse` installer. This is the
// ONLY engine-coupled file (plus reachable.js, split out of it); everything in core/
// is pure over the Runtime shape. Injected into a running Cocos 3.x WebGL game
// (dev/preview, where `cc` is reachable).
//
// The runtime comes in two shapes over ONE shared base:
//   • cocosRuntime(cc)     — base + `reachable` (the full QA/coverage surface; inject.js)
//   • cocosRuntimeLite(cc) — base only, NO reachable (the minimal driver a `press`-only caller
//     needs; inject-lite.js). The reachability code (~half the engine layer) lives in reachable.js
//     and is imported ONLY by the full runtime, so esbuild tree-shakes it out of the lite bundle.
import { snapshot, clickSurface, resolve, press, get, call, reachable, node, diff, splitMember } from '../core/index.js';
import { makeReachable } from './reachable.js';
import { makeVisualManifest, frameRectToViewport } from './visual.js';
import { probe } from './probe.js';
import { registerInto, describe, stateWith, callWith, patchTargetWith, notifyWith, retrieveWith } from './framework.js';
import { jsonSafe, parseDur, safeVal, safeBool } from './eval-cond.js';

const stripCc = (t) => (typeof t === 'string' && t.startsWith('cc.') ? t.slice(3) : t);

// Node-structural events the engine itself registers (UITransform/Node internals) —
// filtered out of codeHandlers so only USER node.on() listeners remain. (mouse-* is
// dropped by prefix; Button's own touch-* is dropped by target identity.)
const ENGINE_EVENTS = new Set([
  'transform-changed', 'size-changed', 'anchor-changed', 'parent-changed',
  'active-in-hierarchy-changed', 'child-added', 'child-removed', 'child-reorder',
  'sibling-order-changed', 'childrenSiblingOrderChanged', 'node-destroyed',
  'layer-changed', 'mobility-changed', 'scene-changed-for-persists',
]);

/**
 * The engine-coupled BASE runtime: everything except `reachable`. Pure over `cc` — no reachability
 * (that's reachable.js, attached only by the full `cocosRuntime`). Enough to drive handlers
 * (`press`/`call`), read state (`get`/`nodeInfo`), and surface code handlers (`codeHandlers`).
 * @param {any} cc
 */
function baseRuntime(cc) {
  const { Button, UITransform, Camera, Vec3 } = cc;
  const UIT = UITransform || 'cc.UITransform';
  const CLICK = Button?.EventType?.CLICK ?? 'click';
  const typeName = (c) => c?.constructor?.name || 'Unknown';

  return {
    name: (n) => n.name,
    children: (n) => n.children || [],
    isActive: (n) => !!n.activeInHierarchy,
    components: (n) => (n.components || []).map((c) => ({ type: typeName(c), raw: c })),
    // getComponent accepts a class or a registered class-name string across versions;
    // try the name as-given, then the cc-built-in class, then the stripped name.
    getComponent: (n, type) =>
      n.getComponent(type) || (cc[stripCc(type)] && n.getComponent(cc[stripCc(type)])) || n.getComponent(stripCc(type)) || null,
    readProp: (c, p) => c[p],
    callMethod: (c, m, args) => (typeof c[m] === 'function' ? c[m](...args) : undefined),
    asButton: (n) => (Button ? n.getComponent(Button) : n.getComponent('cc.Button')) || null,
    isInteractable: (b) => b.interactable !== false,
    clickHandlers: (b) =>
      (b.clickEvents || []).map((h) => ({
        target: h.target?.name,
        component: h._componentName || h.component,
        handler: h.handler,
        data: h.customEventData,
      })),
    // Run each serialized clickEvent the way the Button does internally.
    fireClickHandlers: (b) => {
      const hs = b.clickEvents || [];
      for (const h of hs) if (typeof h.emit === 'function') h.emit([b]);
      return hs.length;
    },
    emitClick: (n, b) => {
      // Unguarded on purpose: `emit` is a no-op when there are no `on('click')` listeners, but a listener
      // that THROWS must surface (the "doesn't-crash" signal) — matching fireClickHandlers, which also
      // propagates. A swallowed throw here would let `press` return ok:true over a genuinely broken handler.
      n.emit(CLICK, b);
    },

    // Synthesize a tap (touch-start → touch-end) on the node so buttons wired via raw
    // `node.on(TOUCH_*)` (not `click`) actuate — some games do this. The touch
    // is placed at the node's screen centre (same space worldToScreen/hitTest use) so a
    // handler's inside-node check on TOUCH_END passes. Best-effort: returns false if the
    // engine shapes don't line up (older/newer EventTouch signatures, no camera).
    emitTouch: (n) => {
      // EventTouch lives at cc.EventTouch in dev builds but only cc.Event.EventTouch in some
      // (minified) release builds — resolve from either. cc.Touch is consistently top-level.
      const EventTouch = cc.EventTouch || (cc.Event && cc.Event.EventTouch) || (cc.internal && cc.internal.EventTouch);
      if (!EventTouch || !cc.Touch) return false;
      const ET = (cc.Node && cc.Node.EventType) || {};
      const START = ET.TOUCH_START || 'touch-start';
      const END = ET.TOUCH_END || 'touch-end';
      let x = 0, y = 0;
      try {
        const ui = n.getComponent(UIT);
        const root = cc.director.getScene();
        const cams = []; (function walk(z) { const c = z.getComponent && z.getComponent(Camera); if (c) cams.push(c); (z.children || []).forEach(walk); })(root);
        if (ui && cams.length) {
          const box = ui.getBoundingBoxToWorld();
          const o = new Vec3(); cams[0].worldToScreen(new Vec3(box.x + box.width / 2, box.y + box.height / 2, 0), o);
          x = o.x; y = o.y;
        }
      } catch { /* fall back to (0,0) */ }
      try {
        const touch = new cc.Touch(x, y, 0);
        for (const type of [START, END]) {
          const ev = new EventTouch([touch], true, type, [touch]);
          try { ev.touch = touch; } catch { /* read-only in some versions */ }
          try { ev.simulate = true; } catch { /* optional */ }
          if (typeof n.dispatchEvent === 'function') n.dispatchEvent(ev);
          else if (n._eventProcessor && n._eventProcessor.dispatchEvent) n._eventProcessor.dispatchEvent(ev);
          else return false;
        }
        return true;
      } catch { return false; }
    },

    // USER node.on() listeners, read from the engine's NodeEventProcessor. Filters out
    // engine-internal node events + mouse-* + the Button's OWN touch listeners, leaving
    // real handlers (a `click`, or a non-Button `touch-*` like an input-swallowing mask).
    // Identity (target object) survives minification; names (fn/target class) often don't.
    codeHandlers: (n) => {
      const ep = n._eventProcessor; if (!ep) return [];
      const btn = Button ? n.getComponent(Button) : null;
      const out = [];
      for (const key of ['capturingTarget', 'bubblingTarget', '_capturingTarget', '_bubblingTarget']) {
        const inv = ep[key]; if (!inv) continue;
        const table = inv._callbackTable || inv.callbackTable; if (!table) continue;
        for (const type of Object.keys(table)) {
          if (ENGINE_EVENTS.has(type) || type.indexOf('mouse-') === 0) continue;
          const infos = (table[type].callbackInfos || table[type]._callbackInfos) || [];
          for (const ci of infos) {
            if (!ci || (btn && ci.target === btn)) continue;
            out.push({ type, fn: (ci.callback && ci.callback.name) || undefined, target: (ci.target && ci.target.constructor && ci.target.constructor.name) || undefined });
          }
        }
      }
      return out;
    },

    // Node intrinsics that get/snapshot don't expose — the basis for "did this panel
    // open?": read activeInHierarchy/opacity/scale before vs after an action. Only the
    // reliably-readable fields (no flaky on-screen guess; use `reachable` for coverage).
    nodeInfo: (n) => {
      const info = { active: !!n.active, activeInHierarchy: !!n.activeInHierarchy };
      const op = cc.UIOpacity ? n.getComponent(cc.UIOpacity) : null;
      if (op) info.opacity = op.opacity;
      try { const s = n.scale; if (s) info.scale = { x: s.x, y: s.y }; } catch { /* */ }
      try { const wp = n.worldPosition; if (wp) info.worldPos = { x: Math.round(wp.x), y: Math.round(wp.y) }; } catch { /* */ }
      const ui = n.getComponent(UIT);
      if (ui && ui.contentSize) info.size = { w: ui.contentSize.width, h: ui.contentSize.height };
      return info;
    },
  };
}

/**
 * The FULL copse Runtime over a live `cc`: base + best-effort `reachable` (z-order / occlusion).
 * @param {any} cc @returns {import('../core/index.js').Runtime}
 */
export function cocosRuntime(cc) {
  return { ...baseRuntime(cc), reachable: makeReachable(cc) };
}

/**
 * The LITE copse Runtime: base ONLY, no `reachable`. For a caller that just drives handlers
 * (`press`) + reads state (`get`/`node`/`diff`) — e.g. mast's `press:` action stages. Because it
 * never references makeReachable, esbuild drops reachable.js from a bundle built off this path.
 * `core.press`/`core.snapshot` guard on `rt.reachable` before use, so omitting it is safe.
 * @param {any} cc @returns {import('../core/index.js').Runtime}
 */
export function cocosRuntimeLite(cc) {
  return baseRuntime(cc);
}

/**
 * Find the live `cc` engine, walking this window and its **same-origin** (i)frames
 * (games are often inside a nested iframe). Cross-origin frames throw on access and
 * are skipped — for those, inject INTO that frame instead (the puppeteer driver does
 * this via `page.frames()`; a console paste, via the DevTools frame selector).
 * @param {any} [win] @param {number} [depth] @returns {any|null}
 */
export function findCC(win = globalThis, depth = 0) {
  try { if (win.cc && win.cc.director && win.cc.director.getScene) return win.cc; } catch { /* cross-origin */ }
  if (depth > 6) return null;
  let frames; try { frames = win.frames; } catch { return null; }
  for (let i = 0; i < (frames ? frames.length : 0); i++) {
    try { const c = findCC(frames[i], depth + 1); if (c) return c; } catch { /* cross-origin */ }
  }
  return null;
}

/**
 * OPT-IN console capture: patch `console.*` + uncaught errors into a capped ring buffer,
 * readable via `__copse.logs(since?)`. **Not run by default** — patching `console.*` makes it
 * non-native, which can trip `isNative` guards (some builds wipe their own globals when they
 * detect a patched `console`). The puppeteer driver captures console passively over CDP instead;
 * only call this for a console-paste where you want `__copse.logs()`. Idempotent.
 * @param {any} [target] @param {number} [max]
 */
export function startLogCapture(target = globalThis, max = 1000) {
  if (target.__copseLogs) return target.__copseLogs;
  const buf = []; target.__copseLogs = buf;
  const safe = (a) => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } };
  const push = (level, text, extra) => { buf.push({ level, text, t: Date.now(), ...extra }); if (buf.length > max) buf.shift(); };
  const c = target.console || (typeof console !== 'undefined' ? console : null);
  if (c) for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = c[k];
    if (typeof orig !== 'function') continue;
    c[k] = (...args) => { try { push(k, args.map(safe).join(' ')); } catch { /* ignore */ } return orig.apply(c, args); };
  }
  try {
    if (target.addEventListener) {
      target.addEventListener('error', (e) => push('error', e.message || String(e.error || 'error'), { stack: e.error && e.error.stack }));
      target.addEventListener('unhandledrejection', (e) => push('error', 'unhandledrejection: ' + safe(e.reason)));
    }
  } catch { /* ignore */ }
  return buf;
}

/**
 * Build the in-page `visualManifest(sel)` — resolve sel→node, project its screen rect + dynamic mask rects
 * to VIEWPORT CSS px (via the game-canvas metrics), the geometry a driver needs to sign a node's pixels.
 * SHARED by install() (the full QA surface) and installProbe() (so mast's `--until drawn:` can read a node's
 * rect for its gated pixel confirm) — one implementation, not two. `rect:null` (+ reason) when unprojectable.
 * @param {any} cc @param {any} rt @returns {(sel:string)=>any}
 */
function makeVisualManifestFn(cc, rt) {
  const manifestOf = makeVisualManifest(cc);
  // Game-canvas metrics for the frame→viewport map (engine/DOM glue — the pure transform is in visual.js).
  const canvasMetrics = () => {
    const canvas = (cc.game && cc.game.canvas) || (typeof document !== 'undefined' && document.querySelector && document.querySelector('canvas')) || null;
    if (!canvas) return null;
    const bcr = (canvas.getBoundingClientRect && canvas.getBoundingClientRect()) || null;
    return { fw: canvas.width, fh: canvas.height, left: bcr ? bcr.left : 0, top: bcr ? bcr.top : 0, cssW: bcr ? bcr.width : canvas.width, cssH: bcr ? bcr.height : canvas.height };
  };
  return (sel) => {
    const n = resolve(cc.director.getScene(), rt, sel);
    if (!n) return null;
    const m = manifestOf(n);
    const cm = canvasMetrics();
    if (!m.rect || !cm) return { ref: m.ref || sel, rect: null, maskRects: [], visible: m.visible, via: m.via, reason: cm ? (m.reason || 'no-rect') : 'no-canvas' };
    // frameRectToViewport still returns null when the canvas momentarily has 0 width/height (resize / scene
    // transition) — canvasMetrics is truthy but fw/fh are 0. Don't return rect:null with no reason.
    const rect = frameRectToViewport(m.rect, cm);
    if (!rect) return { ref: m.ref, rect: null, maskRects: [], visible: m.visible, via: m.via, reason: 'no-canvas-size' };
    return { ref: m.ref, visible: m.visible, via: m.via, rect, maskRects: m.maskRects.map((r) => frameRectToViewport(r, cm)).filter(Boolean) };
  };
}

/**
 * Install the FULL bridge as `target.__copse` (default `globalThis`/`window`). The
 * driver then calls e.g. `__copse.snapshot()` / `__copse.press('Canvas/ShopBtn')`.
 * @param {any} cc @param {any} [target]
 */
export function install(cc, target = globalThis) {
  // NOTE: we deliberately do NOT startLogCapture() here — patching the page's `console.*`
  // makes them non-native, which can trip `isNative` guards (some builds wipe their own globals
  // when they detect a patched `console`). The puppeteer driver captures console passively via CDP
  // (`page.on('console')`) instead — no page-visible patching. For console-paste use
  // where you want `__copse.logs()`, opt in explicitly with `copse.startLogCapture()`.
  const rt = cocosRuntime(cc);
  const root = () => cc.director.getScene();

  const nap = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- watch: a diff-only TIMELINE of exprs/selectors over time (state-machine observation) ----
  // The whole poll loop runs IN-PAGE in one call, so a caller (the puppeteer driver / MCP) makes a
  // single request instead of N per-tick round-trips. Records ONLY changed keys, with relative
  // timestamps {t, dt}. Duration parse + in-page condition eval are the shared eval-cond.js helpers
  // (safeVal/safeBool/parseDur), the same `until` gates through — one condition vocabulary, two tools.
  /** @param {{exprs?:string[], selectors?:string[], interval?:string|number, until?:string, timeout?:string|number, settle?:string|number}} [o] */
  async function watchImpl(o = {}) {
    const { exprs = [], selectors = [], interval, until, timeout, settle } = o;
    const iv = Math.max(50, parseDur(interval, 1000)), to = parseDur(timeout, 40000), st = parseDur(settle, 0);
    const sample = () => {
      const s = {};
      for (const e of exprs) s['{' + e + '}'] = safeVal(e);
      for (const sel of selectors) { try { const r = get(root(), rt, sel); s[sel] = r && r.ok ? jsonSafe(r.value) : ('⚠ ' + ((r && r.reason) || 'err')); } catch (err) { s[sel] = '⚠ ' + ((err && err.message) || err); } }
      return s;
    };
    const hit = () => safeBool(until);
    const t0 = Date.now(); const timeline = []; let last = {}, lastT = t0;
    const rec = () => {
      const cur = sample(); const ch = {};
      for (const k of Object.keys(cur)) if (JSON.stringify(cur[k]) !== JSON.stringify(last[k])) ch[k] = cur[k];
      if (Object.keys(ch).length) { const now = Date.now(); timeline.push({ t: now - t0, dt: now - lastT, changes: ch }); lastT = now; }
      last = cur;
    };
    rec();                                            // t=0 baseline (everything reads as "changed" from nothing)
    let stoppedBy = 'timeout';
    while (true) {
      if (hit()) { stoppedBy = 'until'; break; }
      if (Date.now() - t0 >= to) { stoppedBy = 'timeout'; break; }
      await nap(iv); rec();
    }
    if (stoppedBy === 'until' && st > 0) { const end = Date.now() + st; while (Date.now() < end) { await nap(iv); rec(); } }
    return { timeline, stoppedBy, elapsed: Date.now() - t0, samples: timeline.length };
  }

  // ---- patch: wrap a live component method to verify a fix WITHOUT rebuilding ----
  // Wraps the method on the INSTANCE (scoped, restorable), binds `this` correctly, and runs the
  // before/after hooks under try/catch so a buggy hook can't break the original call — the three
  // things testers kept getting wrong hand-writing monkey-patches on the running game.
  const PATCHES = target.__copsePatches || (target.__copsePatches = new Map());
  const compileHook = (src) => { if (!src) return null; if (typeof src === 'function') return src; return (0, eval)('(' + src + ')'); };
  // Cheap, cycle-safe truncation for traced args/ret — a live component graph is huge/circular.
  const traceVal = (v, d = 0) => {
    if (v === null || typeof v !== 'object') return typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v;
    if (d >= 3) return '…';
    if (Array.isArray(v)) { const h = v.slice(0, 8).map((x) => traceVal(x, d + 1)); if (v.length > 8) h.push(`…(+${v.length - 8})`); return h; }
    const o = {}; let i = 0;
    for (const k of Object.keys(v)) { if (i++ >= 12) { o['…'] = 1; break; } try { o[k] = traceVal(v[k], d + 1); } catch { o[k] = '…'; } }
    return o;
  };

  // ---- framework adapters (SUGGESTIONS #4): the per-session registry (core ships none) ----
  // Populated by registerFramework — the driver auto-injects adapters from copse.frameworks.mjs; probe
  // reads the same store off globalThis. describe/stateWith/callWith are the generic (framework.js) engine.
  const FW = target.__copseFrameworks || (target.__copseFrameworks = []);
  const restore = (sel) => { const p = PATCHES.get(sel); if (!p) return false; try { if (p.hadOwn) p.target[p.member] = p.orig; else delete p.target[p.member]; } catch { /* */ } PATCHES.delete(sel); return true; };
  // Shared wrap machinery for BOTH patch (a cc component instance) and pm_patch (a PureMVC proxy/mediator
  // instance, or a command CLASS prototype) — same before/after/replace hooks, trace, and restore.
  function wrapTarget(sel, tgt, member, hooks) {
    if (typeof tgt[member] !== 'function') return { ok: false, reason: 'not-a-method', ref: sel };
    let before, after, replace;
    try { before = compileHook(hooks.before); after = compileHook(hooks.after); replace = compileHook(hooks.replace); }
    catch (e) { return { ok: false, reason: 'bad-hook', error: (e && e.message) || String(e) }; }
    if (PATCHES.has(sel)) restore(sel);              // re-patching the same selector replaces
    const hadOwn = Object.prototype.hasOwnProperty.call(tgt, member);
    const orig = tgt[member];
    const errors = [];
    // trace:true records each call {t (ms since patch), args, ret[, threw]} into a ring buffer — read
    // via patch_calls. The runtime companion to coir's STATIC command flow: confirm real order + timing live.
    const trace = !!hooks.trace; const traceMax = hooks.traceMax || 200; const calls = []; const t0 = Date.now();
    const wrapper = function (...args) {
      let a = args; const started = Date.now();
      if (before) { try { const r = before(a, this); if (Array.isArray(r)) a = r; } catch (e) { errors.push('before: ' + ((e && e.message) || e)); } }
      let ret, threw = null;
      try { ret = replace ? replace(a, this) : orig.apply(this, a); } catch (e) { threw = e; }   // orig/replace throw still propagates (below)
      if (after && !threw) { try { const r = after(a, ret, this); if (r !== undefined) ret = r; } catch (e) { errors.push('after: ' + ((e && e.message) || e)); } }
      if (trace) { calls.push({ t: started - t0, args: traceVal(a), ...(threw ? { threw: (threw && threw.message) || String(threw) } : { ret: traceVal(ret) }) }); if (calls.length > traceMax) calls.shift(); }
      if (threw) throw threw;
      return ret;
    };
    try { tgt[member] = wrapper; } catch (e) { return { ok: false, reason: 'unwritable', error: (e && e.message) || String(e) }; }
    PATCHES.set(sel, { target: tgt, member, hadOwn, orig, errors, calls });
    return { ok: true, ref: sel, method: member, hooks: ['before', 'after', 'replace'].filter((k) => hooks[k]), ...(trace ? { trace: true } : {}) };
  }
  function patchImpl(sel, hooks = {}) {
    let comp, member;
    try { const p = splitMember(sel); const n = resolve(root(), rt, p.path); if (!n) return { ok: false, reason: 'not-found', ref: sel }; comp = rt.getComponent(n, p.comp); member = p.member; }
    catch (e) { return { ok: false, reason: 'bad-selector', error: (e && e.message) || String(e) }; }
    if (!comp) return { ok: false, reason: 'no-component', ref: sel };
    return wrapTarget(sel, comp, member, hooks);
  }
  // pm_patch: wrap a PureMVC proxy/mediator method (instance) or a command's execute (class prototype),
  // resolved through the registered adapter — so a game's app-layer flow (the 500 command chain) is
  // traceable without rebuilding. Same hooks/trace/restore as patch; fail-loud when unresolvable.
  function pmPatchImpl(sel, hooks = {}) {
    const pt = patchTargetWith(target, FW, sel);
    if (!pt.ok) return pt;
    const r = wrapTarget(sel, pt.target, pt.member, hooks);
    return r.ok ? { ...r, kind: pt.kind } : r;   // kind: 'instance' (proxy/mediator) | 'command' (class prototype)
  }
  // Read a traced patch's recorded calls (empty if the patch wasn't trace:true / doesn't exist).
  function patchCallsImpl(sel) { const p = PATCHES.get(sel); return { ok: !!p, ref: sel, calls: p && p.calls ? p.calls.slice() : [] }; }
  function patchClearImpl(sel) {
    const errsOf = (k) => { const p = PATCHES.get(k); return p && p.errors.length ? p.errors.slice() : null; };
    if (sel) { const he = errsOf(sel); const ok = restore(sel); return { ok: true, cleared: ok ? [sel] : [], ...(he ? { hookErrors: { [sel]: he } } : {}) }; }
    const all = [...PATCHES.keys()]; const hookErrors = {};
    for (const k of all) { const he = errsOf(k); if (he) hookErrors[k] = he; }
    for (const k of all) restore(k);
    return { ok: true, cleared: all, ...(Object.keys(hookErrors).length ? { hookErrors } : {}) };
  }

  // ---- hold: FREEZE the engine loop at a trigger so a transient state can be screenshot/inspected ----
  // A self-running flow passes through intermediate states too fast to screenshot (an intermediate window
  // can be ~1s). `hold` arms a ONE-SHOT patch on a trigger method (a component method, or a
  // framework command/notification via pmMode); when it fires, the engine main loop is paused — the last
  // frame stays on the canvas (screenshot captures it) and reads (get/pm_get/snapshot) still work, since
  // they don't need the loop. `release` resumes. Freeze is version-adaptive (cc.game.pause → director.pause),
  // fails LOUD when neither resolves (copse convention). Boundary: pausing freezes EVERYTHING that runs
  // through the engine loop (scheduler/tween/animation/engine callbacks); a state driven by a bare
  // browser setTimeout won't freeze, and a held game can't be driven further until release.
  const freeze = () => {
    try { if (cc.game && typeof cc.game.pause === 'function') { cc.game.pause(); return 'game'; } } catch { /* */ }
    try { if (cc.director && typeof cc.director.pause === 'function') { cc.director.pause(); return 'director'; } } catch { /* */ }
    return null;
  };
  const unfreeze = () => { let ok = false; try { if (cc.game && cc.game.resume) { cc.game.resume(); ok = true; } } catch { /* */ } try { if (cc.director && cc.director.resume) { cc.director.resume(); ok = true; } } catch { /* */ } return ok; };
  const canFreeze = () => !!((cc.game && cc.game.pause) || (cc.director && cc.director.pause));
  let HOLD = null; // { sel, at, holdMs, active, via, t, timer } — one hold at a time
  // the armed trigger hook (a direct closure — holdImpl runs in-page, so no global lookup needed) fires
  // ONE-SHOT: freeze, record, unpatch the trigger so it can't re-fire.
  function doHold() {
    if (!HOLD || HOLD.active) return;                    // already fired, or released
    const via = freeze();
    HOLD.active = true; HOLD.via = via; HOLD.t = Date.now();
    restore(HOLD.sel);                                    // one-shot: the trigger won't re-fire
    if (HOLD.holdMs) HOLD.timer = setTimeout(() => { try { releaseImpl(); } catch { /* */ } }, HOLD.holdMs); // setTimeout is unaffected by the engine pause
  }
  /** @param {string} triggerSel @param {{at?:'before'|'after', holdMs?:number, pmMode?:boolean}} [opts] */
  function holdImpl(triggerSel, { at = 'after', holdMs, pmMode } = {}) {
    if (!canFreeze()) return { ok: false, reason: 'no-freeze-api', note: 'neither cc.game.pause nor cc.director.pause resolves on this build — cannot freeze the loop' };
    if (HOLD) releaseImpl();                              // replace any prior hold (also unfreezes if held)
    HOLD = { sel: triggerSel, at, holdMs, active: false, via: null, t: 0, timer: null };
    const arm = (pmMode ? pmPatchImpl : patchImpl)(triggerSel, { [at]: () => doHold() });
    if (!arm.ok) { HOLD = null; return arm; }
    const kind = /** @type {any} */ (arm).kind;          // present only for a pmMode (command/instance) trigger
    return { ok: true, armed: true, sel: triggerSel, at, ...(kind ? { kind } : {}), ...(holdMs ? { holdMs } : {}) };
  }
  function releaseImpl() {
    if (!HOLD) return { ok: true, resumed: false, note: 'nothing held' };
    const wasHeld = HOLD.active; const heldMs = wasHeld ? Date.now() - HOLD.t : 0;
    if (HOLD.timer) { try { clearTimeout(HOLD.timer); } catch { /* */ } }
    restore(HOLD.sel);                                    // clear the trigger if it never fired
    const resumed = wasHeld ? unfreeze() : false;
    HOLD = null;
    return { ok: true, resumed, wasHeld, heldMs };
  }
  const holdStatusImpl = () => (HOLD ? { armed: !HOLD.active, held: !!HOLD.active, sel: HOLD.sel, via: HOLD.via, sinceMs: HOLD.active ? Date.now() - HOLD.t : 0 } : { armed: false, held: false });

  // node→screen-rect projection is the shared `visualManifest` (viewport CSS px, resolution-policy
  // correct) — `screenshot` reuses its `.rect` for clipping, so there's ONE projection, not two.
  const visualManifest = makeVisualManifestFn(cc, rt);
  const api = {
    snapshot: (opts) => snapshot(root(), rt, opts),
    interactive: (opts) => snapshot(root(), rt, { onlyInteractive: true, reachability: true, ...opts }), // pressable list, with reachability
    // join-ready click surface: one row per editor-wired clickEvent, keyed (ref, method) — the same
    // key coir emits statically, so an agent can cross-reference static wiring with what's live now.
    clickSurface: (opts) => clickSurface(snapshot(root(), rt, { onlyInteractive: true, reachability: (opts && opts.reachability) !== false, includeInactive: opts && opts.includeInactive })),
    press: (path, opts) => press(root(), rt, path, opts),
    get: (sel) => get(root(), rt, sel),
    call: (sel, ...args) => call(root(), rt, sel, args),
    reachable: (sel) => reachable(root(), rt, sel),       // { reachable, blockedBy }
    node: (sel) => node(root(), rt, sel),                 // node intrinsics (active/opacity/scale/worldPos/size)
    diff: (before, after) => diff(before, after),         // snapshot diff → appeared/activated/labelChanged/…
    listeners: (sel) => { const n = resolve(root(), rt, sel); return n ? rt.codeHandlers(n) : null; },
    // Node-anchored VISUAL manifest (screen rect + dynamic mask rects in viewport CSS px) — the companion to
    // `reachable`; the driver screenshots + downsamples + compares (src/sensors/pixel.js). See makeVisualManifestFn.
    visualManifest,
    // orient: one-call bearings — scene + engine + framework capabilities + a few pressable entry points,
    // so a newcomer/agent doesn't stitch probe + framework + interactive by hand after connect.
    orient: () => {
      const scene = root();
      const inter = snapshot(root(), rt, { onlyInteractive: true, reachability: true });
      const entryPoints = inter.filter((d) => d.reachable !== false && d.interactable !== false).slice(0, 8).map((d) => d.ref);
      return {
        scene: (scene && (scene.name || scene._name)) || null,
        engine: (cc && cc.ENGINE_VERSION) || '?',
        framework: { ...describe(target, FW), registered: FW.length },
        buttons: inter.length,
        entryPoints,
      };
    },
    probe: () => probe(cc, target),                       // engine-coupling self-diagnostic (reads the framework registry off `target`)
    logs: (since = 0) => (target.__copseLogs || []).filter((l) => l.t > since), // console + uncaught errors
    watch: (opts) => watchImpl(opts),                     // diff-only timeline of exprs/selectors over time
    patch: (sel, hooks) => patchImpl(sel, hooks),         // wrap a live method to verify a fix pre-rebuild
    patch_clear: (sel) => patchClearImpl(sel),            // restore patched method(s)
    patch_calls: (sel) => patchCallsImpl(sel),            // read a trace:true patch's recorded calls (order/timing)
    hold: (sel, opts) => holdImpl(sel, opts),             // freeze the loop at a trigger → screenshot/inspect a transient state
    release: () => releaseImpl(),                         // resume the loop (clears the hold/trigger)
    hold_status: () => holdStatusImpl(),                  // { armed?, held?, sel, via, sinceMs }
    registerFramework: (a) => registerInto(FW, a),        // install an adapter for this session (auto-loaded from copse.frameworks.mjs, or ad-hoc)
    framework: () => ({ ...describe(target, FW), registered: FW.length }), // detect via registered adapters + enumerate proxies/mediators
    pmGet: (sel) => stateWith(target, FW, sel, false),    // READ proxy/mediator state (outside the cc tree)
    pmSet: (sel, value) => stateWith(target, FW, sel, true, value), // WRITE a proxy/mediator leaf
    pmCall: (sel, args) => callWith(target, FW, sel, args), // call a proxy/mediator method
    pmPatch: (sel, hooks) => pmPatchImpl(sel, hooks),     // wrap a proxy/mediator/command method (patch_clear/patch_calls apply)
    pmNotify: (name, body, type) => notifyWith(target, FW, name, body, type), // fire a framework notification (direct flow entry)
    rt, // exposed for ad-hoc poking from a console
  };
  // pm.* — the framework surface under a stable, discoverable namespace, ergonomic for `eval`: the snake_case
  // TOOL names (pm_get) don't exist in-page (the members are camelCase), so `__copse.pm_get(...)` throws
  // "is not a function". `pm.get/set/call/notify/patch` alias the camelCase members (ONE implementation, no
  // divergence); `pm.proxy(name)`/`pm.mediator(name)` hand back the RAW live object for ad-hoc poking (no JSON
  // boundary in-page) — what you'd otherwise dig out of puremvc.Facade.instance.retrieveProxy(...) by hand.
  api.pm = {
    get: api.pmGet, set: api.pmSet, call: (sel, ...args) => api.pmCall(sel, args),
    notify: api.pmNotify, patch: api.pmPatch,
    proxy: (name) => retrieveWith(target, FW, name),
    mediator: (name) => retrieveWith(target, FW, name),
  };
  target.__copse = api;
  return api;
}

/**
 * Install the LITE bridge as `target.__copse`: the minimal surface a `press`-only caller needs
 * (snapshot/press/get/call/node/diff/listeners) over the reachability-free lite runtime. NO
 * reachable/interactive/clickSurface/probe/logs — so a bundle built off this path carries neither
 * the reachability code nor the console-patch surface (smaller injected surface). Used by
 * inject-lite.js. `__copse.press`/`get`/`call` are byte-for-byte the same as the full bridge's.
 * @param {any} cc @param {any} [target]
 */
export function installLite(cc, target = globalThis) {
  const rt = cocosRuntimeLite(cc);
  const root = () => cc.director.getScene();
  const api = {
    snapshot: (opts) => snapshot(root(), rt, opts),
    press: (path, opts) => press(root(), rt, path, opts),
    get: (sel) => get(root(), rt, sel),
    call: (sel, ...args) => call(root(), rt, sel, args),
    node: (sel) => node(root(), rt, sel),
    diff: (before, after) => diff(before, after),
    listeners: (sel) => { const n = resolve(root(), rt, sel); return n ? rt.codeHandlers(n) : null; },
    rt,
  };
  target.__copse = api;
  return api;
}

/**
 * Pending downloads from the asset manager (best-effort across engine versions) — the "assets-idle"
 * signal (returns to 0 after having been >0). Engine-coupled, so it lives here beside the runtimes.
 * @param {any} cc @returns {{known:boolean, pending:number}}
 */
function assetsPending(cc) {
  const am = cc && cc.assetManager; let pend = 0, known = false;
  if (am && am.downloader) {
    const dl = am.downloader, dn = dl._downloading;
    if (dn && typeof dn.count === 'number') { pend += dn.count; known = true; }
    else if (dn && dn._map && typeof dn._map.size === 'number') { pend += dn._map.size; known = true; }
    if (dl._queue && typeof dl._queue.length === 'number') { pend += dl._queue.length; known = true; }
  }
  return { known, pending: pend };
}

/**
 * Install the PROBE bridge as `target.__copse`: a load-metrics + drive surface — no snapshot-extras/get/
 * call/diff/clickSurface/logs, so esbuild drops those from a bundle built off this path. It KEEPS the (heavy
 * but essential) reachability layer + `press`, which is what a `--until` playbook driver needs. Used by
 * inject-probe.js.
 *   probe()        → { cc, scene, assetsKnown, assetsPending, firstReachable } — one-call poll for a metrics driver
 *   firstClickable → name of the first ACTIVE clickable (cc.Button OR code/touch-handler node) that is
 *                    reachable at its centre under z-order (broader than interactive(), which is cc.Button only)
 *   find(name,{enabled}) → ref of the first interactive control matching `name` that is reachable [+enabled]
 *                    (a `--until` reachable condition / press finder), or null
 *   interactive()  → the reachable cc.Button list (snapshot with reachability)
 *   reachable(sel) → { reachable, blockedBy } for one selector
 *   press(ref,opts)→ drive a node (a `--until` press: action)
 * @param {any} cc @param {any} [target]
 */
export function installProbe(cc, target = globalThis) {
  const rt = cocosRuntime(cc);            // base + reachable (reachable.js) — reachability is the reused core
  const root = () => cc.director.getScene();
  const firstClickable = () => {
    const scene = root(); if (!scene) return null;
    let hit = null;
    const walk = (n) => {
      if (hit || !n || !rt.isActive(n)) return;
      const clickable = !!rt.asButton(n) || !!(rt.codeHandlers && (rt.codeHandlers(n) || []).length);
      if (clickable) { const r = rt.reachable(n); if (r && r.reachable === true) { hit = n.name || '?'; return; } }
      const kids = rt.children(n); for (let i = 0; i < kids.length; i++) walk(kids[i]);
    };
    const top = rt.children(scene); for (let i = 0; i < top.length; i++) walk(top[i]);
    return hit;
  };
  // Resolve a NAME (substring, case-insensitive) to the first interactive control whose ref matches AND is
  // reachable [and, when enabled, interactable] — returns its ref (for a `--until` reachable/press-finder).
  const find = (name, opts) => {
    const q = (name || '').toLowerCase(); const wantEnabled = !!(opts && opts.enabled);
    const list = snapshot(root(), rt, { onlyInteractive: true, reachability: true });
    for (const d of list) {
      if (q && (d.ref || '').toLowerCase().indexOf(q) < 0) continue;
      if (wantEnabled && d.interactable === false) continue;
      if (d.reachable === true) return { ref: d.ref, interactable: d.interactable !== false };
    }
    return null;
  };
  const visualManifest = makeVisualManifestFn(cc, rt); // node → viewport rect, for the `drawn` prearm below
  // --- `--until` HELD conditions — moved here from mast until.js's pageEvalSource so copse is the SINGLE
  // cc-eval source: the CLI (forage.js) and the extension (plugin.bg.js) both call __copse.until(specs).
  // Baselines persist across ticks in this frame's closure (was window.__copseUntil). Reuses find/assets/rt.
  let _boot = null, _seen = false, _lblBase = null;
  const meaningful = (s) => s != null && String(s).trim() !== '' && String(s).trim() !== '0';
  // synthetic touch (opt-in via reachable.dispatch): START → CANCEL at the node's screen centre, no click.
  const synthTouch = (n) => { try {
    const ET = cc.EventTouch || (cc.Event && cc.Event.EventTouch) || (cc.internal && cc.internal.EventTouch); if (!ET || !cc.Touch) return false;
    const TET = (cc.Node && cc.Node.EventType) || {}; const START = TET.TOUCH_START || 'touch-start', CANCEL = TET.TOUCH_CANCEL || 'touch-cancel';
    let x = 0, y = 0;
    try { const ut = rt.getComponent(n, 'cc.UITransform'); const cams = []; (function w(z) { const c = z && rt.getComponent(z, 'cc.Camera'); if (c) cams.push(c); (rt.children(z) || []).forEach(w); })(root());
      if (ut && cams.length) { const bb = ut.getBoundingBoxToWorld(); const o = new cc.Vec3(); cams[cams.length - 1].worldToScreen(new cc.Vec3(bb.x + bb.width / 2, bb.y + bb.height / 2, 0), o); x = o.x; y = o.y; } } catch { /* geometry best-effort */ }
    const touch = new cc.Touch(x, y, 0);
    for (let ti = 0; ti < 2; ti++) { const ev = new ET([touch], true, ti === 0 ? START : CANCEL, [touch]); try { ev.touch = touch; } catch { /* */ } try { ev.simulate = true; } catch { /* */ }
      if (typeof n.dispatchEvent === 'function') n.dispatchEvent(ev); else if (n._eventProcessor && n._eventProcessor.dispatchEvent) n._eventProcessor.dispatchEvent(ev); else return false; }
    return true; } catch { return false; } };
  // Evaluate the selected PAGE conditions → { held:[{id,node,detail}], scene, assets } for a --until composer.
  const until = (specs) => { try {
    const scene = root(); const sceneName = (scene && (scene.name || scene._name)) || null;
    const a = assetsPending(cc); const held = [], pixelPending = [];
    for (const cs of (specs || [])) {
      const id = cs.id, mods = cs.mods || [], arg = (cs.arg || '').toLowerCase(), KEY = cs.key || id;
      if (id === 'scene-switch') {
        if (_boot == null && sceneName) _boot = sceneName;
        if (sceneName && _boot && sceneName !== _boot) held.push({ id: KEY, node: null, detail: { from: _boot, to: sceneName } });
      } else if (id === 'assets-idle') {
        if (a.known) { if (a.pending > 0) _seen = true; if (_seen && a.pending === 0) held.push({ id: KEY, node: null, detail: { pending: 0 } }); }
      } else if (id === 'label-filled') {
        if (!_lblBase) _lblBase = {}; let hit = null;
        (function w(n) { if (hit || !n) return; const l = rt.getComponent(n, 'cc.Label');
          if (l && n.uuid) { if (meaningful(l.string)) { if (_lblBase[n.uuid]) hit = { name: n.name || '?', str: ('' + l.string).slice(0, 40) }; } else { _lblBase[n.uuid] = true; } }
          const ch = rt.children(n) || []; for (let j = 0; j < ch.length; j++) w(ch[j]); })(scene);
        if (hit) held.push({ id: KEY, node: hit.name, detail: hit });
      } else if (id === 'reachable') {
        const en = mods.indexOf('enabled') >= 0, disp = mods.indexOf('dispatch') >= 0;
        const hit = find(arg, { enabled: en });
        if (hit) { let ok = true; if (disp) { const nd2 = resolve(root(), rt, hit.ref); ok = nd2 ? synthTouch(nd2) : false; } if (ok) held.push({ id: KEY, node: hit.ref, detail: { ref: hit.ref, enabled: en, dispatched: disp } }); }
      } else if (id === 'drawn') {
        // PREARM ONLY (cheap, in-page): find the reachable [+enabled] control + project its viewport rect. The
        // "did it ACTUALLY render on screen" pixel confirm is the DRIVER's job (screenshot that rect) — a WebGL
        // canvas can't be read in-page. Reported as pixelPending, NOT held; the driver gates the screenshot on this.
        const den = mods.indexOf('enabled') >= 0;
        const dhit = find(arg, { enabled: den });
        if (dhit) { const m = visualManifest(dhit.ref); if (m && m.rect) pixelPending.push({ key: KEY, ref: dhit.ref, rect: m.rect }); }
      } else if (id === 'expr') {
        // an arbitrary in-page boolean condition — the SAME safeBool path watch's `until:` gates through,
        // so a --until playbook and a watch stop share one condition vocabulary (eval-cond.js).
        if (safeBool(cs.arg)) held.push({ id: KEY, node: null, detail: { expr: cs.arg } });
      }
    }
    return { held, scene: sceneName, assets: a.known ? { known: true, pending: a.pending } : null, pixelPending };
  } catch { return null; } };
  const api = {
    probe: () => { const scene = root(); const a = assetsPending(cc);
      return { cc: true, scene: (scene && (scene.name || scene._name)) || null, assetsKnown: a.known, assetsPending: a.pending, firstReachable: firstClickable() }; },
    firstClickable,
    find,
    until,   // --until HELD conditions (single source for both the CLI and the extension); returns pixelPending for `drawn`
    visualManifest, // node → viewport rect + mask rects, for the driver's `drawn` pixel confirm
    interactive: (opts) => snapshot(root(), rt, { onlyInteractive: true, reachability: true, ...opts }),
    reachable: (sel) => reachable(root(), rt, sel),
    press: (path, opts) => press(root(), rt, path, opts),   // drive a node past intros (a `--until` press: action)
    assets: () => assetsPending(cc),
    rt,
  };
  target.__copse = api;
  return api;
}
