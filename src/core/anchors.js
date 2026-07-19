// @ts-check
// The SEMANTIC SKELETON of a live scene: which objects in it were written by the GAME, rather than
// supplied by the engine — and therefore what is worth addressing (docs/ENGINES.md §3).
//
// ENGINE-FREE, hence core/. The insight it rests on is engine-independent: a minifier mangles
// identifiers in scope (class names) but NOT property/method names, so on a production build a game
// class's METHODS and its named references to other objects survive even though its type name does
// not. Both engines need that, they just look in different places:
//   • Pixi has no component system — the candidate object IS the node.
//   • Cocos keeps game logic in Components — the candidates are a node's components.
// So the caller supplies `candidatesOf(node)` and a `surface` describing what the ENGINE itself
// defines; everything below is shared.
//
// Measured on Pixi: a real scene is 69 (title) to 400+ (gameplay) nodes of which only a HANDFUL carry
// any game-defined API; everything else is a bare Sprite/Text/Graphics. Those few are the anchors:
//
//   GameScreen:Node.pauseButton     ← the game's own word for that child
//   GameScreen:Node.match3.board    ← reaches a logic object that isn't a display object at all
//
// TWO DIFFERENT JOBS, deliberately split by how much precision they need:
//   • isAnchor/findAnchors — LOAD-BEARING (addressing depends on it), so it uses a precise
//     fingerprint: the AppScreen interface. Measured across three screens in two independent
//     official games, the stable intersection is show/hide/resize (`prepare`/`update`/`pause` vary
//     and are NOT reliable). Both `pixijs/open-games` titles and the `create-pixi` templates share it.
//   • gameApi/namedRefs — BEST-EFFORT introspection for `orient`/`probe`. Subtracting "Pixi's own
//     surface" is genuinely fiddly (see the trap list below), so its output is advisory: it may miss
//     a game class that extends Sprite, and may include a stray third-party-attached field.
//
// THE THREE TRAPS (each one cost a spike; all of them fail SILENTLY — they return plausible data,
// not an error, which is why makePixiSurface is unit-tested):
//   1. Subtracting only Container.prototype leaves Graphics' ~50 drawing methods (fill/arc/
//      drawCircle/…) looking like game API. Subtract EVERY Pixi built-in's chain present in the tree.
//   2. Subtracting prototypes but not INSTANCE fields lets _events/uid/_updateFlags/localTransform
//      drown out the real fields — the game's own `_game`/`match3` disappears in the noise.
//   3. Walking fields to find logic objects without cycle detection loops forever-ish: Pixi's
//      ObservablePoint._observer is a BACK-REFERENCE to the owning node, so the walk returns to
//      where it started and emits garbage (`_position._observer: "SPACE MACHINE" → 100`).

const ownNames = (o) => { try { return Object.getOwnPropertyNames(o); } catch { return []; } };

/** An object's prototype chain, leaf-first, stopping before Object.prototype. */
const chainOf = (o) => { const c = []; let p = Object.getPrototypeOf(o); while (p && p !== Object.prototype) { c.push(p); p = Object.getPrototypeOf(p); } return c; };

/**
 * The longest common TAIL of a set of prototype chains — the part they all share. Chains run
 * leaf→root, so the shared ancestry is at the END and is compared from there backwards.
 */
function commonTail(chains) {
  let tail = null;
  for (const c of chains) {
    if (tail === null) { tail = c.slice(); continue; }
    let k = 0; const n = Math.min(tail.length, c.length);
    while (k < n && tail[tail.length - 1 - k] === c[c.length - 1 - k]) k++;
    tail = tail.slice(tail.length - k);
  }
  return tail || [];
}

/**
 * Build the set of member names that belong to the ENGINE, not the game — what gameApi subtracts.
 *
 * Calibrated by COMPARISON, not by recognition. An earlier version asked "is this object an engine
 * class?" (`renderPipeId` on Pixi, `instanceof cc.Sprite` on Cocos) and harvested the whole thing;
 * both tests fail at their boundary, and both fail SILENTLY:
 *   • a game class extending Sprite carries `renderPipeId`, so ITS methods and fields were harvested
 *     into the subtracted surface — globally, wiping every anchor in the scene, not just itself;
 *   • on a tree-shaken Cocos release build the `cc.Sprite`/`cc.Label` globals are undefined, so the
 *     built-in filter matched nothing, cc.Component's chain was never subtracted, and every component
 *     looked game-authored — on exactly the build this feature exists for.
 *
 * So instead: `samplesOf(node)` yields `{obj, kind}` for every candidate-shaped object, and the
 * engine's surface is what all instances of a KIND share — the longest common tail of their
 * prototype chains, plus the field names present on every one of them. A game subclass sits ABOVE
 * the shared tail and holds fields its siblings don't, so it falls out by construction. No globals,
 * no class names, nothing that minification can take away.
 *
 * `singletons` names any kind that had only ONE sample, where there was nothing to compare against.
 * @param {any} root @param {{childrenOf?:(n:any)=>any[], samplesOf:(n:any)=>any[]}} opts
 * @returns {{protoNames:Set<string>, fieldNames:Set<string>, kinds:string[], singletons:string[]}}
 */
export function makeSurface(root, { childrenOf = (n) => n.children || [], samplesOf }) {
  const byKind = new Map();                       // kind → { chains:[proto[]], keys:[Set<string>] }
  (function walk(n, d) {
    if (!n || d > 64) return;
    for (const s of samplesOf(n) || []) {
      const obj = s && s.obj !== undefined ? s.obj : s;
      if (!obj || typeof obj !== 'object') continue;
      const kind = (s && s.kind) || '*';
      let g = byKind.get(kind); if (!g) byKind.set(kind, (g = { chains: [], keys: [] }));
      g.chains.push(chainOf(obj));
      g.keys.push(new Set(ownNames(obj)));
    }
    for (const c of childrenOf(n) || []) walk(c, d + 1);
  })(root, 0);

  const protoNames = new Set(), fieldNames = new Set(), singletons = [];
  for (const [kind, g] of byKind) {
    // PROTOTYPES: the engine's share of the chain is the part EVERY instance of this kind has in
    // common. A game subclass sits above that shared tail, so its own methods are never harvested.
    for (const proto of commonTail(g.chains)) for (const k of ownNames(proto)) protoNames.add(k);
    // FIELDS: an engine field is on every instance of the kind; a game field is on some of them.
    if (g.keys.length) {
      const [first, ...rest] = g.keys;
      for (const k of first) if (rest.every((set) => set.has(k))) fieldNames.add(k);
    }
    // Only ONE sample of a kind → nothing to compare it against, so its whole chain/keys were taken
    // and a game subclass here WOULD be swallowed. Reported rather than hidden.
    if (g.chains.length < 2) singletons.push(kind);
  }
  return { protoNames, fieldNames, kinds: [...byKind.keys()], singletons };
}

/**
 * Lifecycle method CLUSTERS — a CONFIDENCE signal, never the gate.
 *
 * Only the first entry is measured (the AppScreen interface shared by `pixijs/open-games` and the
 * `create-pixi` templates; `show`/`hide`/`resize` is the stable intersection across three screens in
 * two independent codebases — `prepare`/`update`/`pause` vary). The rest are COMMON CONVENTIONS, not
 * findings: they cost nothing when absent and are listed so a game using them gets the higher trust
 * tier. Extend via `opts.lifecycle` rather than editing this list if your game names things its own way.
 */
export const LIFECYCLE = [
  { name: 'AppScreen', members: ['show', 'hide', 'resize'] },   // measured
  { name: 'show/hide', members: ['show', 'hide'] },
  { name: 'open/close', members: ['open', 'close'] },
  { name: 'enter/exit', members: ['enter', 'exit'] },
  { name: 'onShow/onHide', members: ['onShow', 'onHide'] },
  { name: 'init/destroy', members: ['init', 'destroy'] },
];

const isDisplayObj = (v) => !!(v && typeof v === 'object' && Array.isArray(v.children));   // default: a node-shaped thing

/**
 * Is this node a GAME-AUTHORED class rather than a bare Pixi primitive — and how confident are we?
 *
 * STRUCTURAL, not name-based. Two independent signals, either of which is enough:
 *   • it owns methods Pixi doesn't define  (it has behaviour of its own)
 *   • it owns named fields pointing at display objects  (it holds its children by name — the
 *     addressing payload, since `_playBtn`/`pauseButton` survive minification and paths don't)
 * A lifecycle cluster on top only RAISES the tier; matching none of them never disqualifies a node.
 * That's the fix for the original detector, which gated on `show`/`hide`/`resize` and therefore found
 * nothing at all in a game that names its lifecycle differently or has none.
 *
 * `tier` is reported so a caller can weigh it, the same way `reachable` reports `via` and `framework`
 * reports `capabilities`: 'lifecycle' (a known screen shape) > 'api' (own behaviour) > 'refs' (holds
 * named children only — a layout/holder class).
 *
 * @param {any} n @param {{protoNames:Set<string>, fieldNames:Set<string>}} surface
 * @param {{lifecycle?:{name:string,members:string[]}[]}} [opts]
 */
export function anchorInfo(n, surface, { lifecycle = LIFECYCLE } = {}) {
  if (!n || typeof n !== 'object') return { anchor: false, tier: null, score: 0, methods: [], namedChildren: 0 };
  const { methods, fields } = gameApi(n, surface);
  let named = 0;
  for (const k of fields) { let v; try { v = n[k]; } catch { continue; } if (isDisplayObj(v)) named++; }
  const cluster = lifecycle.find((c) => c.members.every((m) => typeof n[m] === 'function'));
  const tier = cluster ? 'lifecycle' : methods.length ? 'api' : named ? 'refs' : null;
  // `score` ranks WITHIN a depth only — it is NOT the primary order (see findAnchors). Method count
  // is a poor proxy for importance on its own: measured, a @pixi/ui FancyButton exposes ~11 methods
  // while a game's own screen exposes 4, so scoring alone buries the screen under its own buttons.
  const score = (cluster ? 10 : 0) + methods.length + named * 2;
  return { anchor: !!tier, tier, lifecycle: cluster ? cluster.name : undefined, score, methods, namedChildren: named };
}

/**
 * Back-compat boolean. Prefer `anchorInfo` — it tells you WHY, which is what lets a caller decide
 * whether to trust a borderline hit.
 * @param {any} n @param {{protoNames:Set<string>, fieldNames:Set<string>}} [surface]
 */
export function isAnchor(n, surface) {
  if (!surface) return !!(n && typeof n.show === 'function' && typeof n.hide === 'function' && typeof n.resize === 'function');
  return anchorInfo(n, surface).anchor;
}

/**
 * Every game-authored node in the tree, best-addressable first. Descends past a hit: a popup mounted
 * under a screen is an anchor too, and so are @pixi/ui buttons (which really are addressable objects).
 * @param {any} root @param {(n:any)=>string|null} refOf node → ref
 * @param {{lifecycle?:any[], surface?:any, minScore?:number, childrenOf?:(n:any)=>any[], candidatesOf?:(n:any)=>any[]}} [opts]
 *   candidatesOf: which objects on a node might be game-authored — the node itself (Pixi, the
 *   default) or its components (Cocos). This is the whole engine difference.
 * @returns {{node:any, obj:any, ref:string|null, depth:number, tier:string|null, lifecycle?:string, score:number, methods:string[], namedChildren:number}[]}
 */
export function findAnchors(root, refOf, opts = {}) {
  const { childrenOf = (n) => n.children || [], candidatesOf = (n) => [n], surface } = opts;
  const minScore = opts.minScore ?? 1;
  const out = [];
  (function walk(n, d) {
    if (!n || d > 64) return;
    if (d > 0) {
      for (const cand of candidatesOf(n) || []) {
        const info = anchorInfo(cand, surface, opts);
        if (info.anchor && info.score >= minScore) out.push({ node: n, obj: cand, ref: refOf(n), depth: d, ...info, anchor: undefined });
      }
    }
    for (const c of childrenOf(n) || []) walk(c, d + 1);
  })(root, 0);
  // TREE ORDER (shallowest first), score only breaking ties within a depth. A screen always mounts
  // above the buttons it contains, so depth puts the containing thing first by construction —
  // predictable, and immune to the "a library button out-scores the game's own screen" failure that
  // a pure score sort produces on a real tree.
  return out.sort((a, b) => a.depth - b.depth || b.score - a.score);
}

/**
 * Best-effort: a node's GAME-defined API, with Pixi's own surface subtracted. Advisory only — used
 * by `orient`/`probe` to show a human/agent what's callable, never for resolution.
 * @param {any} n @param {{protoNames:Set<string>, fieldNames:Set<string>}} surface
 * @returns {{methods:string[], fields:string[]}}
 */
export function gameApi(n, surface) {
  if (!n || typeof n !== 'object') return { methods: [], fields: [] };
  const methods = [];
  let p = Object.getPrototypeOf(n);
  while (p && p !== Object.prototype) {
    for (const k of ownNames(p)) {
      if (k === 'constructor' || surface.protoNames.has(k)) continue;
      let d; try { d = Object.getOwnPropertyDescriptor(p, k); } catch { continue; }
      if (d && typeof d.value === 'function') methods.push(k);
    }
    p = Object.getPrototypeOf(p);
  }
  const fields = ownNames(n).filter((k) => !surface.fieldNames.has(k));
  return { methods: [...new Set(methods)], fields };
}

/**
 * The addressing backbone: an anchor's OWN named references, as `name → what it points at`. These
 * are the game's word for its children (`pauseButton`, `_playBtn`, `txtBalance`) and for its logic
 * objects (`match3`, `_game`) — both minify-proof, unlike any path through the tree.
 *
 * Walks one hop into plain (non-display) objects too, since state usually hangs off a logic object
 * rather than the screen itself (`screen._game.score`). CYCLE-SAFE (trap 3): a WeakSet plus a depth
 * bound, because Pixi hangs back-references (ObservablePoint._observer → the owning node) that
 * otherwise walk straight back into the tree.
 *
 * @param {any} n @param {{protoNames:Set<string>, fieldNames:Set<string>}} surface
 * @param {{maxDepth?:number, isDisplay?:(v:any)=>boolean}} [opts]
 * @returns {{path:string, kind:'display'|'text'|'value', type?:string, text?:string}[]}
 */
export function namedRefs(n, surface, { maxDepth = 2, isDisplay = (v) => v && Array.isArray(v.children) } = {}) {
  const out = [];
  const seen = new WeakSet();
  (function walk(o, prefix, depth) {
    if (!o || typeof o !== 'object' || depth > maxDepth) return;
    if (seen.has(o)) return;                                   // trap 3: back-references
    seen.add(o);
    for (const k of ownNames(o)) {
      if (depth === 0 && surface.fieldNames.has(k)) continue;   // Pixi's own instance fields
      if (k.startsWith('__')) continue;                          // devtools/third-party markers
      let v; try { v = o[k]; } catch { continue; }
      if (v === null || typeof v !== 'object') continue;
      const path = prefix + k;
      if (isDisplay(v)) {
        if (typeof v.text === 'string') out.push({ path, kind: /** @type {const} */ ('text'), text: v.text });
        else out.push({ path, kind: /** @type {const} */ ('display') });
        continue;                                               // don't descend INTO the display tree — that's what refs are for
      }
      if (Array.isArray(v)) continue;
      out.push({ path, kind: /** @type {const} */ ('value') });
      walk(v, path + '.', depth + 1);                           // a logic object: one more hop
    }
  })(n, '', 0);
  return out;
}
