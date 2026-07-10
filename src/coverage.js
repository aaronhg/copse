// @ts-check
// The coir × copse coverage JOIN — pure, engine-free, dependency-free. Given coir's
// STATIC ClickEvent map and copse's RUNTIME click surface (clickSurface()), bucket every
// wired button into covered / blocked / unreached / code-only (+ ambiguous), on the shared
// key `(nodePath, method)`. See docs/COVERAGE.md for the recipe and docs/SELECTORS.md for
// the grammar both sides share.
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
// suffix of a longer path (`btn` ~ `Canvas/SomeUnrelatedPanel/btn`). EXACT (byte-equal) matches
// in coverageJoin bypass this entirely, so a genuinely unique short path still joins.
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
 * @param {string} staticPath @param {string} runtimeRef
 * @returns {{mount:string, dropped:string}|null}
 */
function tailMatch(staticPath, runtimeRef) {
  const s = segs(staticPath), r = segs(runtimeRef);
  const n = Math.min(s.length, r.length);
  if (!n) return null;
  for (let k = 1; k <= n; k++) if (nameOf(s[s.length - k]) !== nameOf(r[r.length - k])) return null;
  // min-overlap: a 1-segment shared tail is too weak UNLESS both paths ARE that one segment
  // (full alignment). `s.length !== r.length` means the match is a partial suffix of a longer path.
  if (n < MIN_FUZZY_TAIL && s.length !== r.length) return null;
  return { mount: r.slice(0, r.length - n).join('/'), dropped: s.slice(0, s.length - n).join('/') };
}

/**
 * Join coir's static ClickEvent map to copse's runtime click surface.
 * @param {Array<{nodePath:string, method:string|null, [k:string]:any}>} staticRows
 *        coir side — one per editor-wired button: `{nodePath, method, ...}` (e.g. handlerClass).
 *        Rows with `method:null` are skipped (no key to join on).
 * @param {Array<{ref:string, method:string|null, interactable?:boolean, reachable?:boolean|'unsure', blockedBy?:string, occludedBy?:string, codeHandlers?:any[], [k:string]:any}>} runtimeRows
 *        copse side — a `clickSurface()` result (its rows carry `codeHandlers` when the node has live node.on() listeners).
 * @returns {{covered:any[], blocked:any[], unreached:any[], ambiguous:any[], uncertain:any[], codeRegistered:any[], codeOnly:any[]}}
 *   covered        = wired + live + reachable/interactable (press & assert) — each `{...static, runtime, via:'exact'|'prefix', mount?}`
 *   blocked        = wired + live but `reachable:false`/`interactable:false` (dead/blocked wiring)
 *   unreached      = wired but not live in this scene (navigate to it) — the raw static row
 *   ambiguous      = can't attribute 1:1 — `{...static, candidates:[ref,…], reason}`. `reason:'fan-out'`
 *                    = one static row tail-matched >1 live row; `reason:'fan-in'` = one live button was
 *                    claimed by >1 static row (e.g. same-named across scenes). Resolve by hand; never guessed.
 *   uncertain      = wired + live but reachable:'unsure' (can't judge) or `occludedBy` set — verify, NOT a confident covered
 *   codeRegistered = no editor clickEvent BUT has live `codeHandlers` (node.on listeners) — a downgraded level: it IS wired
 *                    in code, but registration alone doesn't prove the handler is an action vs a decorator, so NOT `covered`
 *   codeOnly       = live, no editor clickEvent AND no detectable code handler — a bare/unknown button (possibly dead)
 */
export function coverageJoin(staticRows, runtimeRows) {
  const covered = [], blocked = [], unreached = [], ambiguous = [], uncertain = [], codeRegistered = [], codeOnly = [];
  const live = (runtimeRows || []).filter(Boolean);
  const exact = new Map(live.filter((r) => r.method != null).map((r) => [`${r.ref} ${r.method}`, r]));
  const consumed = new Set();

  // Pass 1 — resolve each static row to AT MOST ONE runtime row (exact, else a UNIQUE fuzzy tail).
  // >1 fuzzy candidate is `fan-out` ambiguity (one static → many live), reported, never guessed.
  // No live match → `unreached`. Bucketing is DEFERRED to pass 2: a single live button can be
  // claimed by >1 static row (fan-in), which has to be reconciled before anything is `covered`.
  /** @type {Map<any, Array<{s:any, via:string, tail:any}>>} */
  const claims = new Map();
  for (const s of staticRows || []) {
    if (!s || s.method == null) continue; // can't join without a method key
    let hit = exact.get(`${s.nodePath} ${s.method}`);
    let via = 'exact', tail;
    if (!hit) {
      const cands = live.filter((r) => r.method === s.method && tailMatch(s.nodePath, r.ref));
      // >1 tail candidate → ambiguous (never guessed). Mark the candidates consumed so they don't
      // ALSO leak into codeOnly at the end — they have a (ambiguous) static match, they're not code-wired.
      if (cands.length > 1) { ambiguous.push({ ...s, candidates: cands.map((c) => c.ref), reason: 'fan-out' }); cands.forEach((c) => consumed.add(c)); continue; }
      if (cands.length === 1) { hit = cands[0]; via = 'prefix'; tail = tailMatch(s.nodePath, hit.ref); }
    }
    if (!hit) { unreached.push(s); continue; }
    const arr = claims.get(hit); if (arr) arr.push({ s, via, tail }); else claims.set(hit, [{ s, via, tail }]);
  }

  // Pass 2 — reconcile fan-in, then bucket. A live row claimed by exactly ONE static row buckets
  // normally. Claimed by >1 (same-named buttons across scenes/prefabs — only one is actually live,
  // but the dropped scene-root prefix means we can't say WHICH) → all those static rows are `fan-in`
  // ambiguous, never silently double-counted as `covered`. Either way the live row is `consumed`
  // (so it can't leak into codeOnly), which also kills the old exact+prefix double-count.
  for (const [hit, rows] of claims) {
    consumed.add(hit);
    if (rows.length > 1) { for (const { s } of rows) ambiguous.push({ ...s, candidates: [hit.ref], reason: 'fan-in' }); continue; }
    const { s, via, tail } = rows[0];
    const row = via === 'prefix' ? { ...s, runtime: hit, via, mount: tail.mount, dropped: tail.dropped } : { ...s, runtime: hit, via };
    if (hit.reachable === false || hit.interactable === false) blocked.push(row);
    // wired + live but copse can't CONFIRM a player reaches/sees it: reachable:'unsure' (can't judge) or
    // occludedBy (an opaque sprite over it). NOT a confident `covered` — fail-loud uncertainty survives the join.
    else if (hit.reachable === 'unsure' || hit.occludedBy) uncertain.push(row);
    else covered.push(row);
  }

  // The runtime rows with no editor-clickEvent match. A row that carries `codeHandlers` (live node.on()
  // listeners) is CODE-REGISTERED — a downgraded coverage level: it HAS a wired-in-code handler, but copse
  // can't tell from registration alone whether that handler is a real action or just a decorator (e.g. a
  // per-button scaler), so it's NOT promoted to `covered`. A row with none is truly bare `codeOnly`.
  for (const r of live) {
    if (consumed.has(r)) continue;
    if (r.codeHandlers && r.codeHandlers.length) codeRegistered.push(r); else codeOnly.push(r);
  }
  return { covered, blocked, unreached, ambiguous, uncertain, codeRegistered, codeOnly };
}

/**
 * Translate a coir STATIC nodePath → the live copse `ref`, by matching it against a runtime
 * view (a `clickSurface()` or `snapshot()` result — rows must carry `ref`). Reuses the same
 * symmetric tail match as `coverageJoin`, so it absorbs coir's scene/prefab-file root prefix
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
