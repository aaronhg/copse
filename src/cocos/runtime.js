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

// node → draw-order key (array of sibling indices from the scene root); later = on top.
const orderKey = (node, root) => {
  const chain = []; let n = node;
  while (n && n !== root) { chain.unshift(n); n = n.parent; }
  let cur = root; const k = [];
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
  const { Button, UITransform, BlockInputEvents, Camera, Vec2, Vec3 } = cc;
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
      try { n.emit(CLICK, b); } catch { /* no code-registered listeners — fine */ }
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
    // than risk a false "unreachable". Heuristic draw-order (sibling-index path); does
    // not resolve cross-camera/Layer z-order or alpha hit areas.
    reachable: (n) => {
      if (!UITransform) return { reachable: true, blockedBy: null };
      const root = cc.director.getScene();
      const ui = n.getComponent(UITransform); if (!ui) return { reachable: true, blockedBy: null };
      const box = ui.getBoundingBoxToWorld();
      const cams = []; (function walk(x) { const c = x.getComponent && x.getComponent(Camera); if (c) cams.push(c); (x.children || []).forEach(walk); })(root);
      if (!cams.length) return { reachable: true, blockedBy: null };
      let sp;
      try { const o = new Vec3(); cams[0].worldToScreen(new Vec3(box.x + box.width / 2, box.y + box.height / 2, 0), o); sp = new Vec2(o.x, o.y); }
      catch { return { reachable: true, blockedBy: null }; }
      let top = null, topKey = null;
      (function walk(x) {
        const u = x.activeInHierarchy && x.getComponent && x.getComponent(UITransform);
        if (u && (x.getComponent(Button) || (BlockInputEvents && x.getComponent(BlockInputEvents)))) {
          let hit = false; try { hit = u.hitTest(sp); } catch { /* coord-space mismatch */ }
          if (hit) { const k = orderKey(x, root); if (!top || cmpKey(k, topKey) > 0) { top = x; topKey = k; } }
        }
        (x.children || []).forEach(walk);
      })(root);
      const ok = top && (top === n || isAncestor(n, top) || isAncestor(top, n));
      return { reachable: !!ok, blockedBy: ok ? null : (top ? refOf(top, root) : null) };
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
 * Install the bridge as `target.__copse` (default `globalThis`/`window`). The
 * driver then calls e.g. `__copse.snapshot()` / `__copse.press('Canvas/ShopBtn')`.
 * @param {any} cc @param {any} [target]
 */
export function install(cc, target = globalThis) {
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
    hijack: () => hijack(cc),                             // opt-in live capture (see note above)
    captured: (sel) => { const n = resolve(root(), rt, sel); return n ? readCaptured(n) : null; },
    rt, // exposed for ad-hoc poking from a console
  };
  target.__copse = api;
  return api;
}
