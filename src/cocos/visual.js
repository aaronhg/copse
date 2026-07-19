// @ts-check
// The IN-PAGE geometry half of the node-anchored visual layer — the companion to reachable.js.
//
// It answers "WHERE on screen is this node, and which sub-regions are dynamic (so the driver should
// MASK them before signing)?" — pure geometry over the live tree, with NO framebuffer read. Cocos's
// WebGL canvas can't be read from page JS (no preserveDrawingBuffer), so grabbing pixels is the
// DRIVER's job (CDP screenshot); this side only projects rects and flags dynamic descendants. The
// driver pairs each rect with a signature (src/sensors/pixel.js) to reach a verdict.
//
// SELF-CONTAINED re: cc CLASS resolution — it re-resolves the cc classes it needs with the same tree-shake-safe
// class-NAME-string fallback (a minified/tree-shaken build may leave `cc.UITransform` undefined while
// getComponent('cc.UITransform') still resolves). Its ONE import is the shared node→ref helper (refpath.js),
// kept in lockstep with reachable.js so both emit the same ref grammar. Imported ONLY by the full inject
// bundle, so esbuild drops it from the lite/probe bundles exactly as it drops reachable.js. `via:'geometric'`
// — this layer never claims pixel truth on its own; only the driver's pixel pass upgrades to 'pixel-confirmed'.
import { refOf } from '../core/refpath.js';

// Descendant component types whose pixels change frame-to-frame — masked out of the anchor so animation/
// particle/text jitter never trips a signature compare. Overridable via makeVisualManifest opts.dynamicTypes.
export const DEFAULT_DYNAMIC = ['cc.ParticleSystem2D', 'cc.ParticleSystem', 'cc.Label', 'cc.RichText', 'sp.Skeleton'];

// All active cc.Camera components in the scene (depth-first). Uses the class-NAME-string fallback (like
// screenRectOf's UITransform) so a tree-shaken/minified release build — where the `cc.Camera` global is
// `undefined` but getComponent('cc.Camera') still resolves — doesn't silently find zero cameras.
const collectCameras = (cc, root) => {
  const Camera = cc.Camera || 'cc.Camera'; const cams = [];
  (function walk(x) { const cam = x.getComponent && x.getComponent(Camera); if (cam) cams.push(cam); (x.children || []).forEach(walk); })(root);
  return cams;
};

// node → its rendering camera: the active camera whose visibility mask includes the node's layer, highest
// priority. The reachable.js `camOf` heuristic (NOT the authoritative getFirstRenderCamera — for an
// anchor rect a few px is tolerable and the driver's pixel pass adjudicates; via stays 'geometric').
const camOf = (node, cams) => {
  let best = null;
  for (const c of cams) {
    if (c.enabled === false || (c.node && c.node.activeInHierarchy === false)) continue;
    if (c.visibility === undefined || (node.layer & c.visibility)) { if (!best || (c.priority || 0) > (best.priority || 0)) best = c; }
  }
  return best || cams[0] || null;
};

// Is the node visually present, or collapsed (opacity/scale === 0 anywhere up the chain)? Same separate
// signal reachable.js exposes — reported alongside so a caller can gate on `visible && drawn`.
const visibleOf = (cc, node) => {
  const { UIOpacity } = cc; let p = node;
  while (p) {
    if (UIOpacity) { const u = p.getComponent && p.getComponent(UIOpacity); if (u && u.opacity === 0) return false; }
    const s = p.scale; if (s && (s.x === 0 || s.y === 0)) return false;
    p = p.parent;
  }
  return true;
};

/**
 * Project a node's world AABB to a screen-space rect `{x,y,w,h}` (the AABB of its four projected corners),
 * or null if it has no UITransform / no camera / projection fails. Reuses the same worldToScreen path
 * reachable.js hit-tests through, so "where copse thinks the node is" is one story across both layers.
 * Pass `cams` (from collectCameras) to reuse them across many calls — otherwise it collects per call.
 * @param {any} cc
 * @param {any} node
 * @param {any[]} [cams] pre-collected cameras (a manifest passes them once for all its descendants)
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
export function screenRectOf(cc, node, cams) {
  const { UITransform, Vec3 } = cc;
  const UIT = UITransform || 'cc.UITransform';
  const ut = node.getComponent(UIT); if (!ut) return null;
  let box; try { box = ut.getBoundingBoxToWorld(); } catch { return null; }
  if (!box) return null;
  const cam = camOf(node, cams || collectCameras(cc, cc.director.getScene())); if (!cam) return null;
  const corners = [
    [box.x, box.y], [box.x + box.width, box.y],
    [box.x, box.y + box.height], [box.x + box.width, box.y + box.height],
  ];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [wx, wy] of corners) {
    const o = new Vec3();
    try { cam.worldToScreen(new Vec3(wx, wy, 0), o); } catch { return null; }
    minX = Math.min(minX, o.x); minY = Math.min(minY, o.y);
    maxX = Math.max(maxX, o.x); maxY = Math.max(maxY, o.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Build `visualManifest(node)` over a live `cc`: the geometry a driver needs to sign a node's pixels.
 * Returns `{ ref, rect, maskRects, visible, via }` — `rect` the screen anchor, `maskRects` the screen
 * rects of dynamic descendants to exclude, `via:'geometric'`. `rect:null` (with `reason:'no-rect'`) when
 * the node isn't projectable — the driver then degrades LOUD, never signing a bogus region.
 * @param {any} cc
 * @param {{dynamicTypes?:string[]}} [opts]
 * @returns {(node:any)=>{ref:string|null, rect:{x:number,y:number,w:number,h:number}|null, maskRects:Array<{x:number,y:number,w:number,h:number}>, visible:boolean, via:string, reason?:string}}
 */
export function makeVisualManifest(cc, opts = {}) {
  const dynamic = opts.dynamicTypes || DEFAULT_DYNAMIC;
  return (node) => {
    const root = cc.director.getScene();
    const cams = collectCameras(cc, root); // collect ONCE per manifest, reuse for the anchor + every dynamic descendant
    const ref = refOf(node, root);
    const visible = visibleOf(cc, node);
    const rect = screenRectOf(cc, node, cams);
    if (!rect) return { ref, rect: null, maskRects: [], visible, via: 'geometric', reason: 'no-rect' };
    const maskRects = [];
    (function walk(x) {
      if (x !== node && x.activeInHierarchy !== false) {
        for (const t of dynamic) {
          if (x.getComponent && x.getComponent(t)) { const r = screenRectOf(cc, x, cams); if (r) maskRects.push(r); break; }
        }
      }
      (x.children || []).forEach(walk);
    })(node);
    return { ref, rect, maskRects, visible, via: 'geometric' };
  };
}

/**
 * Map a frame-buffer rect (from screenRectOf — origin bottom-left, x∈[0,fw], y∈[0,fh]) to a VIEWPORT
 * CSS-pixel rect (origin top-left): the space a CDP/puppeteer screenshot `clip` and page coords use.
 * Normalizing by fw/fh (rather than assuming 1:1) absorbs devicePixelRatio AND Cocos's resolution policy,
 * so this one transform holds across builds without a version branch. PURE — the engine glue that reads
 * the canvas metrics (`left/top/cssW/cssH` from the game canvas's getBoundingClientRect, `fw/fh` its
 * backing-store size) lives in runtime.js; this is unit-tested in isolation. Returns null on bad metrics.
 * @param {{x:number,y:number,w:number,h:number}} rect frame-space
 * @param {{fw:number,fh:number,left:number,top:number,cssW:number,cssH:number}} m
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
export function frameRectToViewport(rect, m) {
  if (!m || !m.fw || !m.fh) return null;
  const sx = m.cssW / m.fw, sy = m.cssH / m.fh;
  return {
    x: m.left + rect.x * sx,
    y: m.top + (m.fh - (rect.y + rect.h)) * sy, // y-flip: the frame's TOP edge (y+h) → the smaller css-y
    w: rect.w * sx,
    h: rect.h * sy,
  };
}
