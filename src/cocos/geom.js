// @ts-check
// Cocos geometry / visibility / synthetic-input primitives, shared by the layers that all need the same
// answers: `reachable` (input z-order), `visual` (the drawn-rect manifest), and the runtime's synthetic
// touch. Each of these was duplicated in 2–4 places, with header comments in reachable.js/visual.js
// promising to keep the copies "in lockstep" by hand — the same situation core/refpath.js was extracted to
// end. The copies had ALREADY drifted: the two synthetic-touch paths projected through different cameras
// (`cams[0]` vs `cams[cams.length - 1]`), so at most one of them was right.
//
// Deliberately dependency-free (imports nothing) and side-effect-free, because the base and probe bundles
// pull `synthTap` in: esbuild must be able to include this module without dragging the bridge/reachable
// layers along with it. Keep it that way — do not import from ../core here.

/**
 * All active cc.Camera components under `root` (depth-first). Uses the class-NAME-string fallback (like
 * screenRectOf's UITransform) so a tree-shaken/minified release build — where the `cc.Camera` global is
 * `undefined` but getComponent('cc.Camera') still resolves — doesn't silently find zero cameras.
 * @param {any} cc @param {any} root @returns {any[]}
 */
export const collectCameras = (cc, root) => {
  const Camera = cc.Camera || 'cc.Camera';
  const cams = [];
  (function walk(x) {
    if (!x) return;
    const cam = x.getComponent && x.getComponent(Camera);
    if (cam) cams.push(cam);
    (x.children || []).forEach(walk);
  })(root);
  return cams;
};

/**
 * node → its rendering camera: the active camera whose `visibility` mask includes the node's `layer`,
 * taking the highest `priority`; falls back to the first camera. A heuristic, NOT the authoritative
 * `getFirstRenderCamera` — for an anchor rect a few px is tolerable and the driver's pixel pass
 * adjudicates (`via` stays 'geometric'). This is also what resolves cross-camera/Layer z-order.
 * @param {any} node @param {any[]} cams
 */
export const camOf = (node, cams) => {
  let best = null;
  for (const c of cams) {
    if (c.enabled === false || (c.node && c.node.activeInHierarchy === false)) continue; // disabled camera doesn't render
    if (c.visibility === undefined || (node.layer & c.visibility)) { if (!best || (c.priority || 0) > (best.priority || 0)) best = c; }
  }
  return best || cams[0] || null;
};

/**
 * Is the node visually present, or collapsed to nothing — `opacity === 0` or `scale === 0` anywhere up
 * the chain? A SEPARATE visibility signal (input ignores opacity/scale, so this is NOT folded into
 * `reachable`); exact-zero only, so no threshold guesswork. Reported alongside `reachable`/`drawn`.
 * @param {any} cc @param {any} node
 */
export const visibleOf = (cc, node) => {
  const UIOpacity = cc && cc.UIOpacity;
  let p = node;
  while (p) {
    if (UIOpacity) { const u = p.getComponent && p.getComponent(UIOpacity); if (u && u.opacity === 0) return false; }
    const s = p.scale; if (s && (s.x === 0 || s.y === 0)) return false;
    p = p.parent;
  }
  return true;
};

/**
 * Dispatch a synthetic two-phase touch at the node's screen centre. The fiddliest engine coupling in the
 * repo (EventTouch lives at three different paths across dev/release builds, and the event has to carry
 * `touch`/`simulate` for a Button's own inside-node check to pass), which is exactly why it must exist
 * once.
 *
 * `endType` is the ONE real difference between the two callers and stays a parameter:
 *   'end'    → START → TOUCH_END, the actuation path (a Button's handler runs; this is a real press).
 *   'cancel' → START → TOUCH_CANCEL, the probe path (reachable's opt-in dispatch): the node observes a
 *              touch so a hit-test can be confirmed, but NO click fires — the point is not to actuate.
 *
 * The camera is chosen by `camOf` (layer/visibility + priority), not by position in the scene walk. The
 * two old copies took `cams[0]` and `cams[cams.length - 1]` respectively; both are arbitrary, and on a
 * scene with a 3D camera plus a UI camera they project a UI node's world box through different matrices.
 * @param {any} cc @param {any} node
 * @param {{endType?:'end'|'cancel', root?:any}} [opts]
 * @returns {boolean} false when the engine shapes don't line up (older/newer EventTouch, no dispatcher)
 */
export const synthTap = (cc, node, { endType = 'end', root } = {}) => {
  // EventTouch is at cc.EventTouch in dev builds but only cc.Event.EventTouch in some (minified) release
  // builds — resolve from either. cc.Touch is consistently top-level.
  const EventTouch = cc.EventTouch || (cc.Event && cc.Event.EventTouch) || (cc.internal && cc.internal.EventTouch);
  if (!EventTouch || !cc.Touch) return false;
  const ET = (cc.Node && cc.Node.EventType) || {};
  const START = ET.TOUCH_START || 'touch-start';
  const SECOND = endType === 'cancel' ? (ET.TOUCH_CANCEL || 'touch-cancel') : (ET.TOUCH_END || 'touch-end');
  let x = 0, y = 0;
  try {
    const scene = root || (cc.director && cc.director.getScene && cc.director.getScene());
    const ui = node.getComponent && node.getComponent(cc.UITransform || 'cc.UITransform');
    const cams = collectCameras(cc, scene);
    const cam = cams.length ? camOf(node, cams) : null;
    if (ui && cam) {
      const box = ui.getBoundingBoxToWorld();
      const Vec3 = cc.Vec3;
      const o = new Vec3();
      cam.worldToScreen(new Vec3(box.x + box.width / 2, box.y + box.height / 2, 0), o);
      x = o.x; y = o.y;
    }
  } catch { /* geometry is best-effort — fall back to (0,0) */ }
  try {
    const touch = new cc.Touch(x, y, 0);
    for (const type of [START, SECOND]) {
      const ev = new EventTouch([touch], true, type, [touch]);
      try { ev.touch = touch; } catch { /* read-only in some versions */ }
      try { ev.simulate = true; } catch { /* optional */ }
      if (typeof node.dispatchEvent === 'function') node.dispatchEvent(ev);
      else if (node._eventProcessor && node._eventProcessor.dispatchEvent) node._eventProcessor.dispatchEvent(ev);
      else return false;
    }
    return true;
  } catch { return false; }
};
