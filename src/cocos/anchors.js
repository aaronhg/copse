// @ts-check
// Cocos's binding of the engine-neutral anchor machinery (src/core/anchors.js).
//
// WHY THIS EXISTS ON COCOS AT ALL. The Pixi lane needs anchors because its refs are unreadable;
// Cocos refs are already `Canvas/Shop/BuyBtn`, so addressing is NOT the problem here. The OTHER half
// of the insight still bites though: a release build mangles component class names to `e`/`t`, so
// `snapshot({components:true})` hands you a node with a script whose type is `t` and no clue what it
// can do — while the component's METHOD names survived minification untouched. `anchors()` reports
// exactly that: which nodes carry a game-authored component, and what is callable on it.
//
// The structural difference from Pixi, stated once: Cocos keeps game logic in COMPONENTS, so a
// node's candidate objects are its components, not the node. `ref` is the node's path, and the
// component is addressed the normal way — `<ref>:<type>.<method>`.
import { makeSurface, findAnchors as findAnchorsCore, anchorInfo, gameApi, namedRefs, LIFECYCLE } from '../core/anchors.js';

export { anchorInfo, gameApi, namedRefs, LIFECYCLE };

// The built-in component classes worth subtracting when the `cc` namespace still exposes them.
const BUILTIN_NAMES = ['Component', 'Renderer', 'RenderComponent', 'UIRenderer', 'Sprite', 'Label', 'RichText', 'Button', 'Toggle', 'ToggleContainer', 'Widget', 'Layout', 'Mask', 'Graphics', 'UITransform', 'UIOpacity', 'ProgressBar', 'Slider', 'ScrollView', 'ScrollBar', 'PageView', 'EditBox', 'Animation', 'Camera', 'Canvas', 'ParticleSystem2D', 'Sprite2D', 'BlockInputEvents'];

const protoNamesOf = (K) => { const out = []; let p = K && K.prototype; while (p && p !== Object.prototype) { for (const k of Object.getOwnPropertyNames(p)) out.push(k); p = Object.getPrototypeOf(p); } return out; };

/**
 * The cc engine surface, in two TIERS — feature-probed, degrading to a floor, reporting which one
 * carried it (the same posture `reachable` and `probe` take).
 *
 *   FLOOR (always): every component is a sample of one kind, so what they all share is
 *     `cc.Component`'s own chain — `onLoad`/`start`/`update`/`schedule`/… That needs no class
 *     identity, so a tree-shaken release build cannot take it away. An earlier version had ONLY an
 *     `instanceof cc.Sprite || …` filter, which matches nothing once those globals are shaken out,
 *     leaving cc.Component's lifecycle reported as game API for every component in the scene.
 *   TIER 1 (when the namespace survives): subtract each built-in class's own chain too, read
 *     straight off `cc` rather than via `instanceof` on instances. This is what separates a built-in
 *     `Sprite` from a game script — both extend cc.Component, so COMPARISON ALONE CANNOT TELL THEM
 *     APART, and the floor on its own will report built-ins as anchors.
 *
 * `degraded:true` says tier 1 found nothing, i.e. expect built-in components among the results.
 * @param {any} cc @param {any} root
 */
export function makeCocosSurface(cc, root) {
  const surface = makeSurface(root, {
    samplesOf: (n) => (n.components || []).map((c) => ({ obj: c, kind: 'component' })),
  });
  let resolved = 0;
  for (const name of BUILTIN_NAMES) {
    const K = cc && cc[name];
    if (!K || !K.prototype) continue;
    resolved++;
    for (const k of protoNamesOf(K)) surface.protoNames.add(k);
  }
  return { ...surface, builtinsResolved: resolved, degraded: resolved === 0 };
}

/**
 * Anchors in a cc tree: a node's COMPONENTS are the candidates. Each hit carries the component's
 * type (mangled on a release build — that's the point) alongside its still-readable methods.
 * @param {any} cc @param {any} root @param {(n:any)=>string|null} refOf
 * @param {{lifecycle?:any[], surface?:any, minScore?:number, namedCap?:number}} [opts]
 */
export function findAnchors(cc, root, refOf, opts = {}) {
  return findAnchorsCore(root, refOf, {
    ...opts,
    candidatesOf: (n) => n.components || [],
    surface: opts.surface || makeCocosSurface(cc, root),
  });
}
