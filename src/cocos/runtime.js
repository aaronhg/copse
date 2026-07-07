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
import { snapshot, clickSurface, resolve, press, get, call, reachable, node, diff } from '../core/index.js';
import { makeReachable } from './reachable.js';
import { probe } from './probe.js';

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
    probe: () => probe(cc),                               // engine-coupling self-diagnostic (version + per-capability resolution)
    logs: (since = 0) => (target.__copseLogs || []).filter((l) => l.t > since), // console + uncaught errors
    rt, // exposed for ad-hoc poking from a console
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
    const a = assetsPending(cc); const held = [];
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
      }
    }
    return { held, scene: sceneName, assets: a.known ? { known: true, pending: a.pending } : null };
  } catch { return null; } };
  const api = {
    probe: () => { const scene = root(); const a = assetsPending(cc);
      return { cc: true, scene: (scene && (scene.name || scene._name)) || null, assetsKnown: a.known, assetsPending: a.pending, firstReachable: firstClickable() }; },
    firstClickable,
    find,
    until,   // --until HELD conditions (single source for both the CLI and the extension)
    interactive: (opts) => snapshot(root(), rt, { onlyInteractive: true, reachability: true, ...opts }),
    reachable: (sel) => reachable(root(), rt, sel),
    press: (path, opts) => press(root(), rt, path, opts),   // drive a node past intros (a `--until` press: action)
    assets: () => assetsPending(cc),
    rt,
  };
  target.__copse = api;
  return api;
}
