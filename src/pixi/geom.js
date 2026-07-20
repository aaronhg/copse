// @ts-check
// Pixi geometry / visibility primitives, shared by reachable.js, visual.js and runtime.js — each of which
// had its own copy of the same two idioms (the v8 Bounds tolerance, and the ancestor `visible` walk).
//
// The duplication was cheap; the INCONSISTENCY it caused was not. `visualManifest` reported
// `visible: node.visible !== false` (own node only) while `reachable` reported the same FIELD NAME from an
// ancestor-aware walk — so a node inside a hidden parent came back `visible:true` from one and
// `visible:false` from the other, and the Cocos side (where both layers call one `visibleOf`) disagreed
// with both. One definition each, so the field means one thing.
//
// Dependency-free and side-effect-free, like cocos/geom.js — the inject bundles pull it in.

/**
 * `node.getBounds()` normalized across Pixi versions: v8 returns a `Bounds` (whose rect is `.rectangle`),
 * earlier versions return a `Rectangle` directly. Returns the raw rect — callers apply their OWN
 * predicate, because they legitimately differ: `reachable` needs a non-degenerate box to aim a click at
 * (`> 0`), while `visual` tolerates a zero-size one (a collapsed anchor is still a rect worth reporting).
 * @param {any} node @returns {{x:number,y:number,width:number,height:number}|null}
 */
export const boundsRectOf = (node) => {
  let b;
  try { b = node.getBounds(); } catch { return null; }
  const r = (b && b.rectangle) || b;
  return (r && typeof r.width === 'number' && typeof r.height === 'number') ? r : null;
};

/**
 * Is every ancestor (and the node) still in the display list — `visible !== false` all the way up?
 * This is the engine's own notion, and the analogue of Cocos's `activeInHierarchy`: it deliberately
 * ignores alpha and scale, because `active` is about being in the tree, not about being perceivable.
 * @param {any} node
 */
export const visibleChain = (node) => {
  let p = node;
  while (p) { if (p.visible === false) return false; p = p.parent; }
  return true;
};

/**
 * Is the node visually PRESENT, or collapsed to nothing — hidden, `alpha === 0`, or `scale === 0`
 * anywhere up the chain? The perceptual signal, kept SEPARATE from `reachable` (input ignores alpha), and
 * the exact counterpart of cocos/geom.js `visibleOf` so the two engines agree on what `visible` reports.
 * Exact-zero only, so there is no threshold guesswork.
 * @param {any} node
 */
export const visibleOf = (node) => {
  let p = node;
  while (p) {
    if (p.visible === false) return false;
    if (typeof p.alpha === 'number' && p.alpha === 0) return false;   // exact-zero only, no threshold guesswork
    const s = p.scale; if (s && (s.x === 0 || s.y === 0)) return false;
    p = p.parent;
  }
  return true;
};
