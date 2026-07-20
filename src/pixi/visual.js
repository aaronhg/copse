// @ts-check
// The in-page geometry half for Pixi — "WHERE on screen is this node, and which sub-regions are
// dynamic (so the driver should MASK them before signing)?" Same contract as src/cocos/visual.js,
// and the driver-side pixel pass (src/sensors/pixel.js) is shared unchanged.
//
// Much simpler than the Cocos side: one canvas, no cameras, no resolution policy to unwind. Pixi's
// `getBounds()` is already world/global space and `renderer.events.resolution` + the canvas's CSS
// box are all that's needed to reach viewport CSS px — the same inverse mapping `press` uses, so
// there is ONE projection in the Pixi layer, not two.
import { refOf } from '../core/refpath.js';
import { pixiName, pixiType, DEFAULT_DYNAMIC } from './pixitype.js';
import { toClient } from './press.js';
import { boundsRectOf, visibleOf } from './geom.js';

/** Bounds → a plain rect, tolerating both v8's Bounds (.rectangle) and a raw Rectangle. */
const rectOf = (node) => {
  const r = boundsRectOf(node);
  if (!r || !(r.width >= 0) || !(r.height >= 0)) return null;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};

/**
 * Project a world-space rect to viewport CSS px via the same inverse map `press` uses.
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
function toViewport(app, r) {
  const tl = toClient(app, r.x, r.y);
  const br = toClient(app, r.x + r.width, r.y + r.height);
  if (!tl || !br) return null;
  return { x: tl.clientX, y: tl.clientY, w: br.clientX - tl.clientX, h: br.clientY - tl.clientY };
}

/**
 * `makeVisualManifest(app, root)` → `(node) => manifest`, the node-anchored visual descriptor:
 * its screen rect plus the rects of descendants whose pixels change frame-to-frame (text, particles)
 * so a signature compare never trips on animation jitter.
 * @param {any} app @param {()=>any} root @param {{dynamicTypes?:string[]}} [opts]
 */
export function makeVisualManifest(app, root, { dynamicTypes = DEFAULT_DYNAMIC } = {}) {
  const dyn = new Set(dynamicTypes);
  return (node) => {
    const stage = root();
    const ref = refOf(node, stage, pixiName, true) || pixiName(node);
    const r = rectOf(node);
    if (!r) return { ref, rect: null, maskRects: [], visible: visibleOf(node), via: 'geometric', reason: 'no-rect' };
    const rect = toViewport(app, r);
    if (!rect) return { ref, rect: null, maskRects: [], visible: visibleOf(node), via: 'geometric', reason: 'no-canvas-size' };
    const maskRects = [];
    (function walk(n, d) {
      if (!n || d > 64) return;
      if (n !== node && dyn.has(pixiType(n))) {
        const cr = rectOf(n); const v = cr && toViewport(app, cr);
        if (v) { maskRects.push(v); return; }                 // mask the whole dynamic subtree
      }
      for (const c of n.children || []) walk(c, d + 1);
    })(node, 0);
    return { ref, rect, maskRects, visible: visibleOf(node), via: 'geometric' };
  };
}
