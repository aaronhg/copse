// @ts-check
// The coir↔copse ref-matching VOCABULARY (`tailMatch`) + the interop ADAPTERS that translate between a
// coir STATIC nodePath and a copse RUNTIME `ref` (resolveCoirPath / resolveCopseRef). These need copse
// because they resolve against a LIVE runtime view (a clickSurface/snapshot result). The coir × copse
// coverage JOIN itself (`coverageJoin` — the bucketing/verdict) MOVED to arbor (src/join.mjs): it's pure
// control-layer reconciliation over the two surfaces, needing neither files nor a live game. See
// docs/SELECTORS.md for the grammar both sides share.
//
// Matching is two-tier so prefab-internal buttons join too:
//   1. EXACT  — runtime `ref` === static `nodePath` (and same method). Scene-level buttons.
//   2. PREFIX — the static path is a path-segment SUFFIX of a runtime `ref` (same method),
//      i.e. the prefab was instantiated under some mount point; the leading runtime segments
//      are the `mount`. coir reports a button's path WITHIN its prefab file; at runtime that
//      prefab sits under a scene parent, so `runtimeRef === mount + '/' + staticPath`.
//      Segment names are compared with their `[i]` stripped (instantiation shifts indices),
//      so this is fuzzy — and bounded BOTH ways so it can't silently guess:
//        • one static → MANY live tail-matches  → `ambiguous` (reason:'fan-out')
//        • one live   → MANY static rows claim it → `ambiguous` (reason:'fan-in', e.g. same-named
//          buttons in different scenes where only one is loaded — we can't say which it is)
//        • a 1-segment partial tail (`btn` ~ `A/B/btn`) is below MIN_FUZZY_TAIL → no match
//      (mirrors coir's "ambiguity always errors").

const segs = (p) => String(p == null ? '' : p).split('/').filter(Boolean);
const nameOf = (seg) => seg.replace(/\[\d+\]$/, ''); // drop a trailing [i] for fuzzy name compare

// Minimum shared-tail length for a FUZZY (suffix) match. A single generic leaf segment (`btn`,
// `close`, `add`) is too weak to claim a match against an unrelated deep ref — so a 1-segment
// tail is allowed ONLY as a full, exact-length alignment (`Btn` ~ `Btn`), never as a partial
// suffix of a longer path (`btn` ~ `Canvas/SomeUnrelatedPanel/btn`). EXACT (byte-equal) matches in the
// join (arbor's coverageJoin) bypass this entirely, so a genuinely unique short path still joins.
const MIN_FUZZY_TAIL = 2;

/**
 * Do `staticPath` and `runtimeRef` share a full tail — i.e. the SHORTER path's segments are a
 * suffix of the longer's (segment-aligned, `[i]` ignored)? The heads that differ are the two
 * tools' different rootings: coir includes the scene/prefab-file root (`dropped`, the leading
 * segments copse omits — copse roots at the scene-root's children), and a prefab instantiated
 * into the scene adds a `mount` prefix coir can't know. Symmetric so BOTH show up: a scene
 * button reads `dropped:'home'`/`mount:''`; a prefab-internal one `mount:'Canvas/…'`/`dropped:''`.
 * Returns null when the shorter isn't a clean suffix of the longer, or when the shared tail is a
 * weak 1-segment PARTIAL (below {@link MIN_FUZZY_TAIL}; see the constant for why).
 * PUBLIC (copse's index): this is the single declared coir↔copse ref contract. arbor keeps a vendored
 * mirror (match.mjs) because it resolves copse dynamically — its match.test.mjs cross-checks against this.
 * @param {string} staticPath @param {string} runtimeRef
 * @returns {{mount:string, dropped:string}|null}
 */
export function tailMatch(staticPath, runtimeRef) {
  const s = segs(staticPath), r = segs(runtimeRef);
  const n = Math.min(s.length, r.length);
  if (!n) return null;
  for (let k = 1; k <= n; k++) if (nameOf(s[s.length - k]) !== nameOf(r[r.length - k])) return null;
  // min-overlap: a 1-segment shared tail is too weak UNLESS both paths ARE that one segment
  // (full alignment). `s.length !== r.length` means the match is a partial suffix of a longer path.
  if (n < MIN_FUZZY_TAIL && s.length !== r.length) return null;
  return { mount: r.slice(0, r.length - n).join('/'), dropped: s.slice(0, s.length - n).join('/') };
}

// NOTE: `coverageJoin` (the coir × copse bucketing/verdict) moved to arbor (src/join.mjs) — it's pure
// control-layer reconciliation over the two surfaces, needing neither project files nor a live game.
// copse keeps `tailMatch` (above) + the resolveCoirPath/resolveCopseRef adapters (below), which resolve
// against a LIVE runtime view. The `copse coverage` CLI verb + MCP tool moved out with the join; copse's
// runtime half stays as `clickSurface` (core) / the `click_surface` MCP tool.

/**
 * Translate a coir STATIC nodePath → the live copse `ref`, by matching it against a runtime
 * view (a `clickSurface()` or `snapshot()` result — rows must carry `ref`). Reuses the same
 * symmetric `tailMatch` (above), so it absorbs coir's scene/prefab-file root prefix
 * (`dropped`) and a prefab's instantiation `mount` — i.e. a raw coir path that wouldn't resolve
 * in `press`/`get` becomes the exact runtime `ref` that does. Path-only (ignores method), so it
 * works for any node, not just buttons.
 * @param {string} coirPath a coir nodePath, e.g. `main/Canvas/Menu/.../ShopBtn`
 * @param {Array<{ref:string,[k:string]:any}>} runtimeRows clickSurface()/snapshot() rows
 * @returns {{ref:string, mount:string, dropped:string} | {ambiguous:string[]} | null}
 */
export function resolveCoirPath(coirPath, runtimeRows) {
  const cands = (runtimeRows || []).filter((r) => r && r.ref && tailMatch(coirPath, r.ref));
  if (cands.length > 1) return { ambiguous: cands.map((r) => r.ref) };
  if (!cands.length) return null;
  const m = tailMatch(coirPath, cands[0].ref);
  return { ref: cands[0].ref, mount: m.mount, dropped: m.dropped };
}

/**
 * Reverse of {@link resolveCoirPath}: a live copse `ref` → the matching coir static `nodePath`,
 * given coir rows (must carry `nodePath`, e.g. a `clickSurface`/`deps` static map). For labelling
 * a runtime node with its coir identity (real handler class, scene path, …).
 * @param {string} copseRef @param {Array<{nodePath:string,[k:string]:any}>} staticRows
 * @returns {{nodePath:string, mount:string, dropped:string} | {ambiguous:string[]} | null}
 */
export function resolveCopseRef(copseRef, staticRows) {
  const cands = (staticRows || []).filter((s) => s && s.nodePath && tailMatch(s.nodePath, copseRef));
  if (cands.length > 1) return { ambiguous: cands.map((s) => s.nodePath) };
  if (!cands.length) return null;
  const m = tailMatch(cands[0].nodePath, copseRef);
  return { nodePath: cands[0].nodePath, mount: m.mount, dropped: m.dropped };
}

// NOTE: `affectedData` (which frozen flow tests a change touches) + its `drivenPaths` helper moved to
// arbor (src/select.mjs). That selection needs neither a live game nor project files, so by the boundary
// rule it's control-layer work, not copse's. copse keeps `tailMatch` above for resolveCoirPath /
// resolveCopseRef (which DO need a live tree). The `copse affected` CLI verb + MCP tool moved with it.
