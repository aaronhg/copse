// @ts-check
// The Cocos `cc.*` adapter for copse + the `window.__copse` installer. This is the
// ONLY engine-coupled file; everything in core/ is pure over the Runtime shape.
// Injected into a running Cocos 3.x WebGL game (dev/preview, where `cc` is reachable).
import { snapshot, resolve, press, get, call, reachable, node, diff } from '../core/index.js';

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

// node → its rendering camera: the active camera whose `visibility` mask includes the node's `layer`,
// taking the highest `priority`. Falls back to the first camera. (Cross-camera/Layer z-order — #3.)
const camOf = (node, cams) => {
  let best = null;
  for (const c of cams) {
    if (c.enabled === false || (c.node && c.node.activeInHierarchy === false)) continue; // disabled camera doesn't render
    if (c.visibility === undefined || (node.layer & c.visibility)) { if (!best || (c.priority || 0) > (best.priority || 0)) best = c; }
  }
  return best || cams[0];
};
// Is the node visually present, or collapsed to nothing — `opacity === 0` or `scale === 0` anywhere up
// the chain? A SEPARATE visibility signal (input ignores opacity/scale, so this is NOT folded into
// `reachable`); exact-zero only, so no threshold guesswork. Reported alongside reachable.
const visibleOf = (node, UIOpacity) => {
  let p = node;
  while (p) {
    if (UIOpacity) { const u = p.getComponent && p.getComponent(UIOpacity); if (u && u.opacity === 0) return false; }
    const s = p.scale; if (s && (s.x === 0 || s.y === 0)) return false;
    p = p.parent;
  }
  return true;
};
// node → draw-order key: [camera priority, …sibling indices from the scene root]; later/higher = on top.
// Camera priority leads so a node on a higher-priority camera is on top regardless of sibling order.
const orderKey = (node, root, cams) => {
  const chain = []; let n = node;
  while (n && n !== root) { chain.unshift(n); n = n.parent; }
  let cur = root; const k = [cams ? (camOf(node, cams).priority || 0) : 0];
  for (const ch of chain) { k.push((cur.children || []).indexOf(ch)); cur = ch; }
  return k;
};
const cmpKey = (a, b) => { const L = Math.max(a.length, b.length); for (let i = 0; i < L; i++) { const x = a[i] ?? -1, y = b[i] ?? -1; if (x !== y) return x - y; } return 0; };
const isAncestor = (anc, n) => { let p = n.parent; while (p) { if (p === anc) return true; p = p.parent; } return false; };

// node → copse ref (relative to scene root, `[i]` for same-name siblings) — matches core.
const refOf = (node, root) => {
  const chain = []; let n = node;
  while (n && n !== root) { chain.unshift(n); n = n.parent; }
  if (n !== root) return null;
  let path = '', parent = root;
  for (const ch of chain) {
    const sibs = parent.children || [], name = ch.name;
    if (sibs.filter((s) => s.name === name).length > 1) {
      let i = 0; for (const s of sibs) { if (s === ch) break; if (s.name === name) i++; }
      path = path ? `${path}/${name}[${i}]` : `${name}[${i}]`;
    } else path = path ? `${path}/${name}` : name;
    parent = ch;
  }
  return path;
};

/** Build a copse Runtime over a live `cc`. @param {any} cc @returns {import('../core/index.js').Runtime} */
export function cocosRuntime(cc) {
  const { Button, UITransform, BlockInputEvents, Camera, UIOpacity, Vec2, Vec3 } = cc;
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
    // `node.on(TOUCH_*)` (not `click`) actuate — many real-money slots do this. The touch
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
        const ui = UITransform && n.getComponent(UITransform);
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

    // Best-effort geometric reachability: is `n` the top-most input consumer at its own
    // center, or covered by an overlay / BlockInputEvents / later-drawn panel? When we
    // can't judge (no UITransform / camera / projection) we return reachable:true rather
    // than risk a false "unreachable". Draw-order = [camera priority, …sibling-index] so it resolves
    // cross-camera/Layer z-order (#3). Still geometric — opacity does NOT gate input (a transparent
    // BlockInputEvents still swallows touches) so blockers aren't opacity-filtered; no alpha hit-areas.
    reachable: (n) => {
      const visible = visibleOf(n, UIOpacity); // separate signal (opacity/scale === 0) — never affects `reachable`
      if (!UITransform) return { reachable: true, blockedBy: null, visible };
      const root = cc.director.getScene();
      const ui = n.getComponent(UITransform); if (!ui) return { reachable: true, blockedBy: null, visible };
      const box = ui.getBoundingBoxToWorld();
      const cams = []; (function walk(x) { const c = x.getComponent && x.getComponent(Camera); if (c) cams.push(c); (x.children || []).forEach(walk); })(root);
      if (!cams.length) return { reachable: true, blockedBy: null, visible };
      let sp;
      try { const o = new Vec3(); camOf(n, cams).worldToScreen(new Vec3(box.x + box.width / 2, box.y + box.height / 2, 0), o); sp = new Vec2(o.x, o.y); }
      catch { return { reachable: true, blockedBy: null, visible }; }
      let top = null, topKey = null;
      (function walk(x) {
        const u = x.activeInHierarchy && x.getComponent && x.getComponent(UITransform);
        if (u && (x.getComponent(Button) || (BlockInputEvents && x.getComponent(BlockInputEvents)))) {
          let hit = false; try { hit = u.hitTest(sp); } catch { /* coord-space mismatch */ }
          if (hit) { const k = orderKey(x, root, cams); if (!top || cmpKey(k, topKey) > 0) { top = x; topKey = k; } }
        }
        (x.children || []).forEach(walk);
      })(root);
      const ok = top && (top === n || isAncestor(n, top) || isAncestor(top, n));
      return { reachable: !!ok, blockedBy: ok ? null : (top ? refOf(top, root) : null), visible };
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
      const ui = UITransform ? n.getComponent(UITransform) : null;
      if (ui && ui.contentSize) info.size = { w: ui.contentSize.width, h: ui.contentSize.height };
      return info;
    },
  };
}

// Live-capture registry for the on() hijack (node → recorded registrations).
const _captured = new WeakMap();

/**
 * Hijack `cc.Node.prototype.on` (and `off`): record each registration, then delegate to
 * the original ("先過 inject 的 on,再往下拋"). Idempotent. CAVEAT: only captures
 * registrations made AFTER this runs — install before the engine boots (addInitScript /
 * dev hook) to catch scene-load wiring; for already-registered listeners use `codeHandlers`
 * (it reads the live NodeEventProcessor). Mutates the live engine — test-harness use only.
 * @param {any} cc
 */
export function hijack(cc) {
  const N = cc.Node.prototype;
  if (N.on.__copseHijacked) return { ok: true, already: true };
  const origOn = N.on, origOff = N.off;
  N.on = function (type, cb, target, useCapture) {
    try { let l = _captured.get(this); if (!l) _captured.set(this, l = []); l.push({ type: String(type), cb, target }); } catch { /* ignore */ }
    return origOn.call(this, type, cb, target, useCapture);
  };
  N.on.__copseHijacked = true;
  N.off = function (type, cb, target, useCapture) {
    try { const l = _captured.get(this); if (l) { const i = l.findIndex((e) => e.type === String(type) && e.cb === cb && e.target === target); if (i >= 0) l.splice(i, 1); } } catch { /* ignore */ }
    return origOff.call(this, type, cb, target, useCapture);
  };
  return { ok: true, already: false };
}
const readCaptured = (node) => (_captured.get(node) || []).map((e) => ({ type: e.type, fn: (e.cb && e.cb.name) || undefined, target: (e.target && e.target.constructor && e.target.constructor.name) || undefined }));

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
 * non-native, which trips anti-tamper `isNative` guards (a real slot nuked its globals when it
 * caught our patched console). The puppeteer driver captures console passively over CDP instead;
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
 * Install the bridge as `target.__copse` (default `globalThis`/`window`). The
 * driver then calls e.g. `__copse.snapshot()` / `__copse.press('Canvas/ShopBtn')`.
 * @param {any} cc @param {any} [target]
 */
export function install(cc, target = globalThis) {
  // NOTE: we deliberately do NOT startLogCapture() here — patching the page's `console.*`
  // makes them non-native, which trips anti-tamper `isNative` guards (a real anti-tamper slot nuked
  // its globals when it caught our patched console). The puppeteer driver captures console
  // passively via CDP (`page.on('console')`) instead — undetectable. For console-paste use
  // where you want `__copse.logs()`, opt in explicitly with `copse.startLogCapture()`.
  const rt = cocosRuntime(cc);
  const root = () => cc.director.getScene();
  const api = {
    snapshot: (opts) => snapshot(root(), rt, opts),
    interactive: (opts) => snapshot(root(), rt, { onlyInteractive: true, reachability: true, ...opts }), // pressable list, with reachability
    press: (path, opts) => press(root(), rt, path, opts),
    get: (sel) => get(root(), rt, sel),
    call: (sel, ...args) => call(root(), rt, sel, args),
    reachable: (sel) => reachable(root(), rt, sel),       // { reachable, blockedBy }
    node: (sel) => node(root(), rt, sel),                 // node intrinsics (active/opacity/scale/worldPos/size)
    diff: (before, after) => diff(before, after),         // snapshot diff → appeared/activated/labelChanged/…
    listeners: (sel) => { const n = resolve(root(), rt, sel); return n ? rt.codeHandlers(n) : null; },
    logs: (since = 0) => (target.__copseLogs || []).filter((l) => l.t > since), // console + uncaught errors
    hijack: () => hijack(cc),                             // opt-in live capture (see note above)
    captured: (sel) => { const n = resolve(root(), rt, sel); return n ? readCaptured(n) : null; },
    rt, // exposed for ad-hoc poking from a console
  };
  target.__copse = api;
  return api;
}
