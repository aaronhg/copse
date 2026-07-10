# Coverage: cross-referencing coir (static) with copse (runtime)

copse and coir are siblings that read the **same** Cocos UI from two sides:

- **coir** reads the *static* project — every button's `cc.Button` ClickEvent wiring, across
  **every scene and prefab**, even ones not currently loaded. It knows the **real handler-class
  name** (resolved from the script asset), which a minified runtime has thrown away.
- **copse** reads the *running* scene — what is **live and pressable right now**, with
  best-effort `reachable`/`interactable`/`visible`.

Neither one alone answers *"is every wired button actually reachable and working?"* Joined, they
do. This doc is the recipe. There is **no code coupling** between the two tools — the join lives in
the agent (or a small script); both just have to speak the same key.

## The join key: `(nodePath, method)`

Both tools emit, per editor-wired button, its **node path** and the **handler method name**. The
method name is a *serialized string* in the scene/prefab, so it **survives minification** — unlike
the component/handler **class** name, which a release build mangles to `t`/`e`/`n`. That's the whole
trick: **join on the method name, let coir supply the real class name copse can't see.** (The shared
selector grammar — what transfers between the tools, and copse's divergences — is in
[`docs/SELECTORS.md`](SELECTORS.md).)

| | copse (runtime) | coir (static) |
| --- | --- | --- |
| node path | `clickSurface()` row `.ref` | ClickEvent edge `loc.nodePath` |
| method | `.method` (serialized handler) | the method inside `click → method()` |
| handler class | `.component` — **minified** on release | resolved real name, e.g. `ShopController` |
| reachable / interactable | `.reachable` / `.interactable` / `.visible` | — (static can't know) |

## The copse side

`click_surface` (MCP tool) / `cp.clickSurface()` (Driver) / `__copse.clickSurface()` (in-page)
returns one **join-ready row per clickEvent**:

```jsonc
[
  { "ref": "Canvas/ShopBtn", "method": "openShop", "component": "t", "interactable": true, "reachable": true },
  { "ref": "Canvas/CoveredBtn", "method": "claim", "component": "n", "interactable": true,
    "reachable": false, "blockedBy": "Canvas/Popup/mask" },
  { "ref": "Canvas/TouchBtn", "method": null, "interactable": true }   // touch-/code-wired
]
```

It's `interactive()` (buttons + reachability) flattened to one row per clickEvent. Pass
`reachability:false` to skip the `O(buttons×nodes)` reachable pass when you only need the wiring.
A button wired via raw `touch-start/end` or `node.on()` (no serialized clickEvent) emits one row
with `method:null` — it's a button, but outside coir's static ClickEvent surface.

## The coir side

Assemble the static map of `{ nodePath, method, handlerClass }` for the buttons you care about.
coir's ClickEvent wiring shows up as edges of kind `script` whose location `property` is
`click → method()` (see `coir/src/core/refs.js`). Practically, per scene/prefab:

- `tree` → the node hierarchy with a paste-able `nodePath:Comp` selector for every component
  (find the `cc.Button` nodes).
- `deps` / `info` on a button (or `analyze`) → its outgoing `script` edges, whose locations carry
  `click → method()` and point at the handler script (→ the real class name).

The exact calls don't matter to the join — only that you end up with `(nodePath, method)` + the
real class name. `scripts/coverage-demo.js` uses a fixture standing in for this assembled result.

## The buckets

Join copse's `click_surface` against coir's static map on `(nodePath, method)`. The pure helper
**`coverageJoin(staticRows, runtimeRows)`** (`copse/src/coverage.js`, exported from the barrel)
does it — no engine, no deps — bucketing every wired button into **seven** buckets:

| Bucket | Condition | What it means / do next |
| --- | --- | --- |
| ✅ **covered** | in both, `reachable` & `interactable` | press it, assert the state delta. `via:'exact'` (scene-level) or `via:'prefix'` (prefab-internal, with the inferred `mount`) |
| ⛔ **blocked** | in both, but `reachable:false` / `interactable:false` | wired & live but a player can't reach it — verify it's intended |
| ⚠️ **uncertain** | in both, but `reachable:'unsure'` or `occludedBy` set | copse can't confirm a player reaches/sees it — verify, NOT a confident covered |
| 🧭 **unreached** | coir only (not in the runtime rows) | statically wired but not live in this scene (panel closed / other scene) — navigate to it, re-snapshot |
| ❓ **ambiguous** | can't attribute 1:1 — `reason:'fan-out'` (one static row tail-matched >1 live row) or `reason:'fan-in'` (one live button claimed by >1 static row, e.g. same-named across scenes) | resolve by hand; never silently guessed OR double-counted |
| 🧩 **codeRegistered** | copse only — `method:null` but has live `codeHandlers` | wired in code (`node.on`); registration alone ≠ an action, so NOT covered — `listeners` is the lens |
| 👻 **codeOnly** | copse only — `method:null`, no detectable code handler | live but bare/unknown (touch-wired or possibly dead) |

`coverageJoin` matches in two tiers: **exact** (`runtimeRef === nodePath`), then a **symmetric tail** match
(the shorter path is a segment-suffix of the longer, `[i]` ignored) with a **min-overlap floor** — a lone
generic leaf (`btn`/`close`) won't fuzzy-match an unrelated deep ref; only a tail ≥2 segments, or a full
exact-length 1-segment alignment, passes. It absorbs the two tools' different rootings: coir's path can be
*longer* (it includes the scene/prefab-file root copse omits → reported as `dropped`) or *shorter* (a prefab
instantiated under a scene parent adds a `mount` copse sees but coir can't know). Bounded BOTH ways: >1 live
row tail-matches one static row → `ambiguous` (`fan-out`); one live button claimed by >1 static row →
`ambiguous` (`fan-in`, never a silent double-count). See the caveats below.

## Run it

**One call, live** — the whole join is a first-class entry (no barrel-wiring by hand):

```bash
copse coverage <url> coir-rows.json     # connect → clickSurface(live) → coverageJoin → buckets JSON
```

`coir-rows.json` is coir's static ClickEvent rows (`[{nodePath, method}]`, a file path or inline JSON — get
it from coir's CLI/MCP). The MCP edge exposes the same op as the **`coverage`** tool (`{staticRows}` →
buckets), so an MCP client runs the cross-reference in one step. `--no-reachable` skips the reachable pass.

**Offline demo** (no browser/coir/deps — proves the join end-to-end):

```bash
node scripts/coverage-demo.js
```

It builds a fake live scene (real copse `snapshot` + `clickSurface`) + a coir static fixture, joins them,
and prints the buckets — the same logic the `coverage` tool/CLI run against a real game.

## Caveats (be honest)

- **Different rootings (scene-root prefix & prefab mount).** coir includes the scene/prefab-file root
  in its path (e.g. `main/Canvas/Menu/ShopBtn`); copse roots at the scene-root's *children*
  (`Canvas/Menu/ShopBtn`). And a prefab instantiated into the scene gains a `mount` prefix coir can't
  know. `coverageJoin`'s symmetric tail match absorbs both: after an exact miss it matches when the
  shorter path is a clean segment-suffix of the longer, reporting `dropped` (coir's extra head, e.g.
  `home`) and/or `mount` (the runtime's extra head). It infers these from the live tree, so if the same
  tail matches more than one runtime button the row is **ambiguous** (see below), never a wrong covered.
  *(This is the case the first live-game run exposed — without symmetric matching, real scenes covered 0.)*
- **`[i]` disambiguation can drift.** Both tools append `[i]` to same-name siblings, but they compute
  it independently (copse: child-order among same-name siblings at runtime; coir: from the prefab/scene
  JSON). `coverageJoin`'s suffix match therefore compares segment names with `[i]` **stripped** (fuzzy),
  so an index shift from instantiation doesn't break the join — but if that fuzziness matches more than
  one runtime button, the row lands in **`ambiguous`** rather than being guessed. The exact tier still
  requires a byte-equal path (including `[i]`), so unique scene-level paths are never fuzzy.
- **ClickEvent surface only.** This join covers editor-wired `cc.Button` clickEvents — exactly coir's
  static surface. Buttons wired by raw touch or `node.on()` are `method:null` here and invisible to
  coir; reconcile those with copse's `listeners`/`codeHandlers`, not this join.
- **`reachable` is a geometric heuristic** (z-order / `BlockInputEvents` / a later-drawn panel at the
  button's center — no alpha hit-areas, no opaque-sprite occlusion). Treat `reachable:false` as a
  strong signal to verify, not gospel. See the README capability boundary.
