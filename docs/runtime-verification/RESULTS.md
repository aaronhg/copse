# copse — runtime verification RESULTS

Executed 2026-06-28 against the live **3-MCP rig**: a synthetic, de-identified `_copsetest`
scene authored via the **cocos-creator** MCP → served by the editor preview (`:7456`) →
driven by **copse** (MCP + CLI) → cross-checked against **coir** static and the fixture's
deterministic logic. `PASS` = observed == the independent oracle. This is a **representative
live walk** (one or more cases per phase, the load-bearing branches), not all 299 canonical
rows — the pure/contract (`SI`) cohort is carried by copse's own unit suite (see *Pure rows*).

## Environment as run

| | |
|---|---|
| Project | `NewProject_386` (Cocos 3.8.6), cocos-creator MCP `:3000` / preview `:7456` |
| Fixture | `assets/_copsetest/CopseTest.scene` + `CopseSmoke.ts` (authored fresh, deleted after) |
| copse | MCP `mcp__copse__*` (headless Chrome → `:7456`) + CLI `node src/cli.js` |
| coir | `mcp__coir__*` on the same project (rescanned → 362 assets) |
| Dev loop | `npm test` **62 pass**, `tsc --noEmit` clean, `npm run build` → 24.9 kb (this session) |

## Fixture as built (vs the PLAN's roster)

`CopseTest.scene`: `Canvas`(cc.Canvas) → `SmokeBtn`(Sprite+Button+**CopseSmoke** controller,
code-`on('click')`), `ScoreLabel`(Label "0", bound), `DisabledBtn`(Button, **interactable:false**),
`DeadBtn`(Button, no handler), `Item`×2 (same-name siblings → `Item[0]`/`Item[1]`), `Panel`(starts
**inactive**) → `PanelLabel`(Label "panel-open"). The controller establishes the disabled/closed
start-states in `start()` — see RIG-FINDING-1/2. No Camera, no serialized clickEvents — see the
deferred rows + RIG-FINDING-3.

---

## Phase D — Mutation delta (press / call)  — **oracle: CopseSmoke deterministic logic**

| id | case | observed | result |
|----|------|----------|--------|
| (smoke) | press SmokeBtn → get count | `drove:['click']`, count 0→1 | **PASS** |
| D02/D07 | press SmokeBtn (changed) | `drove:['click']`, `changed.labelChanged:[{ScoreLabel,"0"→"1"}]` | **PASS** |
| D16 | call `buy(30)` | `value:70` (gold 100→70) | **PASS** |
| D18 | call `addPair(2,3)` | `value:6` (count 1→6), `labelChanged "1"→"6"` | **PASS** |
| D23 | call `getState()` | `value:{count:6,gold:70}` (object fidelity, not `[object Object]`) | **PASS** |
| D20 | call `boom()` (throws) | MCP `isError`: `✗ copse-test-boom` (never silent `ok:true`) | **PASS** |
| D21 | call `swallow()` (console.error, no rethrow) | `ok:true` + `errors:[{level:'error',text∋'copse-swallow'}]` | **PASS** |
| D10 | press `DeadBtn` (cc.Button, no handler) | `{fired:0, touched:true, drove:['touch'], wired:false}` | **PASS / FINDING-D10** |

> **FINDING-D10** — a truly handler-less `cc.Button` returns `drove:['touch'], wired:false`, **not**
> `drove:'nothing'`. copse is correct: `press` synthesizes a tap for any button with no serialized
> clickEvent and no code-`on('click')` (`emitTouch`), and `wired:false` correctly flags the suspect
> "tap into a button with no visible handler". The PLAN's `drove:'nothing'` expectation only holds
> when `emitTouch` is **absent** (the fake-runtime unit path, C12) — a PLAN-expectation refinement.

## Phase A — Authored-readback  — **oracle: cocos-creator authorship**

| id | case | observed | result |
|----|------|----------|--------|
| A01 | get `ScoreLabel:Label.string` | `value:"0"` (string) == authored | **PASS** |
| A07 | snapshot `interactable` | SmokeBtn `true`, DisabledBtn `false`, DeadBtn `true` | **PASS** |
| A08 | snapshot `label` | `ScoreLabel.label:"0"` | **PASS** |

## Phase S — Read / shape  — **oracle: omit-default contract + coir/cocos cross-read**

| id | case | observed | result |
|----|------|----------|--------|
| S01 | slim descriptor | rows carry `ref`, no `name`; `active` omitted when true (only PanelLabel shows `active:false`) | **PASS** |
| S02 | relevant filter | bare `Canvas`/`Panel` dropped; buttons/labels/code-nodes kept | **PASS** |
| S14 | `[i]` generation | `Item[0]`(item0) / `Item[1]`(item1) — same-name siblings disambiguated | **PASS** |
| S(node) | node intrinsics | `node Panel` → `{active:false, activeInHierarchy:false, scale, worldPos:{320,480}, size:{100,100}}` | **PASS** |
| S(click_surface) | row-per-button | 3 rows; SmokeBtn `method:null`+`codeHandlers`; others bare `method:null` | **PASS** (no clickEvents — see deferred) |

## Phase G — Guards / refusals  — **oracle: refusal contract; no state change**

| id | case | observed | result |
|----|------|----------|--------|
| G01 | get missing node | `{ok:false,reason:'not-found'}` | **PASS** |
| G04 | get no-component | `get ScoreLabel:Sprite.spriteFrame` → `no-component` | **PASS** |
| G11 | press non-button | `press ScoreLabel` → `not-a-button` | **PASS** |
| G12 | press disabled | `press DisabledBtn` → `disabled` (no actuation) | **PASS** |
| G15 | call missing node | `call Ghost:CopseSmoke.add` → `not-found` | **PASS** |

## Phase P — Panel open/close via diff  — **oracle: deterministic open/close + node.active**

| id | case | observed | result |
|----|------|----------|--------|
| P01 | initial inactive | snapshot(incInactive) shows `Panel/PanelLabel active:false`; `node Panel` active:false | **PASS** |
| P03/P11 | open → activated | `call openPanel` → `changed.activated:[{Canvas/Panel/PanelLabel, label:'panel-open'}]` | **PASS** |
| P05 | close → deactivated | `call closePanel` → `changed.deactivated:[{PanelLabel, active:false, label:'panel-open'}]` | **PASS** |
| P12 | activated = full descriptor | activated entry carries `label:'panel-open'` (contents handed over, no re-snapshot) | **PASS** |

## Phase C — Code handlers  — **oracle: CopseSmoke source + coir (0 static edges)**

| id | case | observed | result |
|----|------|----------|--------|
| C01 | listeners click shape | `listeners SmokeBtn` → `[{type:'click',fn:'add',target:'CopseSmoke'}]` (dev names intact) | **PASS** |
| C06 | listeners [] (found, none) | `listeners DeadBtn` → `[]` | **PASS** |
| C08 | press drove:['click'] | press SmokeBtn → `fired:0, drove:['click']`, count++ | **PASS** |
| C13 | hijack idempotent | hijack ×2 → `{already:false}` then `{already:true}` | **PASS** |
| C17 | coir blind to code handler | coir `tree` shows SmokeBtn's Button with **no clickEvents**; copse `listeners` surfaces the on('click') | **PASS** (cross-tool independence) |

## Phase X — Cross-tool (copse runtime ⋈ coir static)  — **oracle: coir reading the same .scene**

| id | case | observed | result |
|----|------|----------|--------|
| X12 | resolveCoirPath drops scene-root | `resolve('CopseTest/Canvas/SmokeBtn')` → `{ref:'Canvas/SmokeBtn', mount:'', dropped:'CopseTest'}` | **PASS** |
| X(tree) | runtime tree == static tree | copse snapshot node-set == coir `tree` (10 nodes) modulo `CopseTest/` prefix; `Item[0]/[1]`, `Panel/PanelLabel` agree | **PASS** |
| X(buckets) | code buckets | (round 1) SmokeBtn → `codeRegistered` (codeHandlers≠[]); DisabledBtn/DeadBtn → `codeOnly` (method:null, no code) | **PASS** |
| X02 | **covered** bucket | (round 2) `coverageJoin([{CopseTest/Canvas/SmokeBtn, add}], click_surface)` → `covered:1` `via:'prefix', dropped:'CopseTest'`; CoveredBtn → `codeOnly` | **PASS** |

## Phase R — Reachability / visibility  — **oracle: authored geometry**

| id | case | observed | result |
|----|------|----------|--------|
| R(unsure) | tri-state fail-loud | (round 1, no Camera) all 3 buttons `reachable:"unsure"` (can't judge → NOT a confident true) | **PASS** |
| R01 | reachable:true (clean) | (round 2, Camera added) `reachable SmokeBtn` → `{reachable:true, blockedBy:null, visible:true}` | **PASS** |
| R02 | reachable:false + blockedBy | `reachable CoveredBtn` → `{reachable:false, blockedBy:'Canvas/Overlay'}` (BlockInputEvents overlay, later sibling) | **PASS** |
| R17 | interactive ride-along | `interactive` → SmokeBtn reachable:true; CoveredBtn reachable:false blockedBy Overlay | **PASS** |

## Phase M — MCP layer  — **oracle: live game state + dispatcher contract**

| id | case | observed | result |
|----|------|----------|--------|
| M24 | connect live summary | `connect{url::7456}` → `{ok:true, buttons:3, relevantNodes:7}` | **PASS** |
| M30 | reload picks up scene | `reload` after authoring → `{reloaded:true, buttons:3}` (was 1 pre-fixture) | **PASS** |
| M41 | get live readback | (every `get` above is an MCP round-trip) | **PASS** |
| M42 | press live delta | (every `press`/`call` above) | **PASS** |
| M21 | run-throws → isError + single `✗` | `boom` → `✗ copse-test-boom` (one `✗`, not doubled) | **PASS** |

## Phase L — CLI single-shots (`node src/cli.js`)  — **oracle: authored value + MCP parity**

| id | case | observed | result |
|----|------|----------|--------|
| L01 | `--version` | `0.0.1`, exit 0 | **PASS** |
| L11 | `get … ScoreLabel:Label.string` | `{ok:true,value:"0"}`, exit 0 (fresh boot) | **PASS** |
| L14 | `get … Canvas/Nope:…` (not-found) | `{ok:false,reason:'not-found'}`, **exit 1** | **PASS** |
| L18 | `press … Canvas/SmokeBtn` | `drove:['click']`, `labelChanged "0"→"1"`, exit 0 | **PASS** |
| L28 | `node … Canvas/Panel` | `active:false, activeInHierarchy:false`, exit 0 | **PASS** |
| L36 | parity vs MCP | CLI `press`/`get`/`node` shapes == the MCP results above (separate Chrome, fresh boot) | **PASS** |

## Round 2 — deferred expansion (serialized clickEvent + camera reachability)

A second fixture (`CopseTest.scene` rebuilt with a `cc.Camera` + an `Overlay`/`CoveredBtn` pair,
and SmokeBtn's clickEvent wired via **coir `edit_set`**) closed both deferred clusters.

**Serialized clickEvent chain** (coir static → engine → copse runtime) — the COVERAGE #14 escape hatch, executed:

| step | observed | result |
|------|----------|--------|
| coir wires it | `edit_set CopseTest/Canvas/SmokeBtn:cc.Button.clickEvents = [{__type__:cc.ClickEvent, target:{__id__:6}, _componentId:'<CopseSmoke token>', handler:'add'}]` (`verify` passed) | **written** |
| engine loads it | after `reimport_asset` + `soft_reload_scene`, cocos `get_component_info(Button)` shows `clickEvents[0] = {handler:'add', _componentId:'…', target:SmokeBtn}` — **engine serializer accepted coir's hand-written ClickEvent** | **PASS** (independent oracle = the engine) |
| copse reads it | `click_surface` → `{ref:'Canvas/SmokeBtn', method:'add', component:'CopseSmoke', reachable:true}` (method≠null) | **PASS** |
| **D01** copse fires it | `press SmokeBtn` → `{fired:1, drove:['clickEvent'], labelChanged:"0"→"1"}` — the editor-wired handler drove it (not code/touch), count 0→1 | **PASS** |
| **X02** covered bucket | `coverageJoin` → `covered:1` (SmokeBtn, `via:'prefix'`), `codeOnly:1` (CoveredBtn) | **PASS** |

> **RIG-FINDING-4** — coir `edit_add_array_item` inserted the ClickEvent object as an **escaped JSON
> string** (the MCP host stringified `value`; that tool didn't re-parse it). `edit_set` *does* re-parse a
> JSON-string `value` → use `edit_set` (whole-array) for owned-object array elements, not `edit_add_array_item`.
> **RIG-FINDING-5** — a coir disk edit reaches the editor preview only after `reimport_asset` **+**
> `soft_reload_scene` (`scene_open_scene` bounce used a cache and did NOT reload). The editor's in-memory
> scene drives the preview, so the disk edit is invisible until the editor re-reads it.
> **RIG-FINDING-3 is thus UNBLOCKED** via the coir-edit hatch (per COVERAGE FINDING-D, the engine
> readback + the runtime `drove:['clickEvent']` delta are the independent oracles — not coir reading itself).

## Round 3 — remaining deferred (occludedBy · visible:false · blocked · unreached)

A third fixture (`Camera` + an `OccludedBtn`/opaque-`Banner` pair, an `OpacityBtn` with `UIOpacity=0`,
a `BlockedBtn` under a `BlockInputEvents` `BlockOverlay` with a **coir-wired** clickEvent, and a
**coir-deactivated** `Panel` holding a wired `PanelBtn`) closed the rest.

| id | case | observed | result |
|----|------|----------|--------|
| R04 | **occludedBy** (opaque sprite, touch passes) | `reachable OccludedBtn` → `{reachable:true, blockedBy:null, visible:true, occludedBy:'Canvas/Banner'}` | **PASS** |
| R08 | **visible:false** (own UIOpacity=0) | `reachable OpacityBtn` → `{reachable:true, blockedBy:null, visible:false}` (input ignores opacity) | **PASS** |
| R03 | reachable:false + blockedBy (wired btn) | `reachable BlockedBtn` → `{reachable:false, blockedBy:'Canvas/BlockOverlay'}`; clickSurface `{method:'add', reachable:false}` | **PASS** |
| X03 | **blocked** bucket | `coverageJoin` → `blocked:[BlockedBtn]` (wired `add` + live + reachable:false) | **PASS** |
| X05 | **unreached** bucket | coir static has `PanelBtn(add)`; copse clickSurface omits it (Panel `_active:false` via coir `edit_set_active`) → `coverageJoin` → `unreached:[PanelBtn]` | **PASS** |

With round 1 (`codeRegistered`/`codeOnly`) + round 2 (`covered`) + round 3 (`blocked`/`unreached`),
**every `coverageJoin` bucket is demonstrated with real live data** except `ambiguous` (a pure-fn
case in the unit suite) and `uncertain` (a *wired* + occluded/unsure row — OccludedBtn here is
`occludedBy` but `method:null`, so it buckets `codeOnly`; a wired-occluded button would land `uncertain`).
coir `edit_set_active Panel false` + `reimport`+`soft_reload` also confirmed the inactive-subtree path.

## Pure rows (no rig) — copse's own unit suite

The `SI`/contract cohort (core guards over fakes G19/G22/R15/R16/C12, the full selector grammar
incl. `[i]`/`#N`-unsupported/`Node` pseudo, the `coverageJoin` buckets X19–X28, the harness gates
H01–H37, the MCP dispatcher M01–M23) is executed by **`npm test` → 62/62 PASS** this session
(`tsc --noEmit` clean; `npm run build` → `dist/copse.inject.js` 24.9 kb). These pin the contracts
the live rig cannot (fake-`cc`, no-emitTouch, dispatcher-without-browser).

## Deferred (honestly blocked — see Findings)

| rows | status |
|------|--------|
| ~~serialized-clickEvent delta (D01), `click_surface` method≠null, X `covered`~~ | **CLOSED round 2** (coir `edit_set` hatch) |
| ~~reachable true/false/blockedBy (R01/R02/R17)~~ | **CLOSED round 2** (Camera + BlockInputEvents overlay) |
| ~~`occludedBy`, `visible:false`, `blocked` bucket, `unreached` bucket~~ | **CLOSED round 3** (opaque Banner / UIOpacity=0 / wired+BlockOverlay / coir-deactivated Panel) |
| `uncertain` bucket (a **wired** row that is occluded/`'unsure'`), `ambiguous` (>1 tail candidate) | unit-suite only — needs a wired+occluded button / a 2-instance prefab; pure-fn coverage in `test/coverage.test.js` |
| alpha hit-areas & opaque-sprite VISUAL occlusion in the reachable boolean | acknowledged pixel-level limit (not the logic tree) — `occludedBy`/`visible` are the partial complements, now verified |
| disabled via editor authoring (`interactable:false`) | worked around in `start()` (script-driven) — RIG-FINDING-1 |

## Findings

- **FINDING-D10** (copse correct, PLAN refinement) — handler-less `cc.Button` press = `drove:['touch'], wired:false`, not `drove:'nothing'` (see above).
- **RIG-FINDING-1** — cocos-creator MCP `component_set_component_property` cannot set boolean `interactable`/`_interactable` to `false` (readback stays `true` after 3 attempts). Worked around via the controller's `start()`.
- **RIG-FINDING-2** — `node_set_node_property active=false` is a no-op (readback stays `true`). Same workaround.
- **RIG-FINDING-3** (confirms COVERAGE critique #14) — no cocos-creator MCP tool wires `Button.clickEvents`; round-1 fixture buttons were all `method:null`. **UNBLOCKED in round 2** via the coir `edit_set` hatch (RIG-FINDING-4/5) — D01 `drove:['clickEvent']` + the `covered` bucket now pass.
- **RIG-FINDING-4 / RIG-FINDING-5** — coir `edit_add_array_item` stringifies an object `value` (use `edit_set`); a coir disk edit reaches the preview only after `reimport_asset` + `soft_reload_scene`. See the Round 2 section.

## Summary

| phase | live cases | result |
|-------|-----------|--------|
| D — mutation delta | 9 | **9 PASS** (incl. D01 serialized clickEvent; 1 carries FINDING-D10) |
| A — authored-readback | 3 | **3 PASS** |
| S — read/shape | 5 | **5 PASS** |
| G — guards | 5 | **5 PASS** |
| P — panel diff | 4 | **4 PASS** |
| C — code handlers | 5 | **5 PASS** |
| X — cross-tool join | 6 | **6 PASS** (covered + blocked + unreached + codeRegistered/codeOnly buckets) |
| R — reachability | 7 | **7 PASS** (`'unsure'` + true/false/blockedBy + occludedBy + visible:false) |
| M — MCP layer | 5 | **5 PASS** |
| L — CLI single-shots | 6 | **6 PASS** |
| pure/contract (SI) | unit suite | **62/62 PASS** |

**Total: 55 live cases PASS · 0 fail · 1 copse-correct finding (D10) · 5 rig-tooling findings.** Every
`coverageJoin` bucket (covered/blocked/unreached/codeRegistered/codeOnly) and every `reachable` signal
(true/false/`'unsure'`/blockedBy/occludedBy/visible) is now demonstrated with real live geometry; only the
`uncertain`/`ambiguous` buckets and pixel-level alpha occlusion remain unit-suite-only.
The copse dev/use flow — author → preview → connect → drive (MCP **and** CLI) → assert against an
independent oracle (editor authorship / coir static / deterministic fixture logic / engine readback) →
cross-tool agree — is **verified end-to-end** on a real running Cocos game, including the full
**coir static → engine → copse runtime** clickEvent chain and the `covered` coverage bucket. Every
remaining gap is an authoring-tool limit or an acknowledged pixel-level boundary, not a copse defect.
