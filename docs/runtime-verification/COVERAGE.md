# copse PLAN — coverage audit

An adversarial 3-lens audit (**completeness**, **ground-truth / verify-level overclaim**,
**executability**) cross-checked the test PLAN against the real source (`src/core/index.js`,
`src/cocos/runtime.js`, `src/harness.js`, `src/mcp/tools.js`) and against the rig it must run on
(cocos-creator MCP authoring → :7456 preview → copse `connect`). This file records the verdict,
the disposition of every critique, the honest remaining-untested backlog, and the findings worth
carrying into RESULTS.

## Verdict

The PLAN is **broad and well-mapped** — every primitive, refusal reason, `press.drove` value,
`reachable` tri-state, `diff`/`coverageJoin` bucket and harness gate appears at least once, the
omit-default/shape contracts are well pinned, and the large `SI` cohort is honestly labelled as
contract-only. Three classes of problem surfaced, none blocking the plan's *intent* but all needing
action before a run is logged as PASS:

1. **Branch holes** — a few load-bearing engine-coupled branches that CLAUDE.md lists as shipped have
   zero specs: the cross-camera/Layer z-order path in `reachable` (every R-row is single-camera
   sibling-order), `hijack`'s `off()`-removal path, and the `logs` primitive's functional readback.
   **Fixed in PLAN** by adding the missing rows.
2. **Verify-level overclaim** — a handful of rows wear a stronger badge than their oracle earns. The
   clearest is C19, labelled `XT` (cross-tool) but comparing `listeners` to snapshot `codeHandlers`,
   which are the *same* `rt.codeHandlers(n)` call — a tautology that can never fail. The reachability
   cluster is labelled `AR` though `reachable`/`blockedBy` are copse-*computed* verdicts, not authored
   values. **Fixed in PLAN** by relabelling and re-anchoring oracles.
3. **Executability** — the rig *can* run the matrix (puppeteer-core + system Chrome present, every
   primitive exists in source, the MCP registry and bucket names check out), but the live matrix sits
   on a fixture-build step the plan over-promises: **there is no cocos-creator MCP tool that wires a
   `Button.clickEvents` EventHandler to a script handler** (`component_set_component_property` stops at
   `stringArray`; `component_attach_script` only attaches). **Deferred to execution** with a chosen
   escape hatch, plus an independence caveat carried as a finding.

## Critique → disposition

| # | Lens | Critique | Disposition |
|---|---|---|---|
| 1 | completeness | Cross-camera / Layer z-order in `reachable` untested — `camOf()` (priority + visibility-mask + disabled/inactive-camera skip) and `orderKey()` (key leads with camera priority) are a shipped headline, but every R-row (R01–R19) is single-camera sibling-order. | **Fixed-in-PLAN** — add a two-camera R-row: button under the higher-priority camera reads `blockedBy` a node that is *earlier* in sibling order but on the higher-priority camera (priority overrides sibling z); + one row for the `c.enabled===false` disabled-camera skip. |
| 2 | completeness | `hijack()` patches both `on()` and `off()`, but only the `on()`/capture path is tested; the `off()`-removal branch (recorded registration dropped) is unverified. | **Fixed-in-PLAN** — add a C-row: hijack → fixture `node.on()`s (captured shows it) → fixture `node.off()`s the same `(type,cb,target)` → `captured()` no longer lists it. |
| 3 | completeness | `logs` primitive (`__copse.logs` / MCP `logs` / `startLogCapture()`) has no functional readback; only the harness `errorGate` consuming driver-side errors is exercised. The `since`-index filter and console.*/error capture are untested. | **Fixed-in-PLAN** — add a live row: fixture `console.error`/`warn`s a known string → `logs` returns it with correct `level`/`text`; `logs since=N` trims already-seen lines (label `SI` for the since arithmetic, `D` for the captured text). |
| 4 | completeness | `clickSurface` keeps/drops the clickEvent `data` (customEventData) field with no spec. | **Fixed-in-PLAN** — author a button whose ClickEvent has customEventData; assert the `click_surface` row carries `data:'<value>'`, and a sibling with empty customEventData omits the key (omit-default contract). |
| 5 | completeness / ground-truth | `get`-vs-`call` Node-pseudo asymmetry unpinned — `get()` has a `comp==='Node'` branch, `call()` does not, so `call …:Node.foo` falls through to `getComponent('Node')` → no-component. | **Fixed-in-PLAN** — add a row: `call Canvas/Mgr:Node.active` → `{ok:false,reason:'no-component'}`, contrasting the `get` Node row. Also carried as a **finding** (documented divergence). |
| 6 | completeness | `emitClick`'s deliberate un-guarded throw propagation isn't isolated from the serialized-clickEvent throw path — both D-throw rows are clickEvent-wired (`fireClickHandlers`), not the code-`on('click')` → `emitClick` branch. | **Fixed-in-PLAN** — add a D-row pressing a code-`on('click')`-only button whose listener throws a known string → `result.errors`/`isError` contains it (`drove:['click']`, not silent `ok:true`). |
| 7 | completeness | Tree-shaken-class name-string fallbacks (`UIT/UIR/BIE/BTN = Class \|\| 'cc.ClassName'`) guard a documented real-build regression (`cc.UITransform` undefined → `reachable` returned `'unsure'`), but nothing verifies resolution when a `cc.*` global is absent (preview always has them). | **Fixed-in-PLAN** (as `SI` unit row, out of live rig) — fake `cc` whose `UITransform` global is undefined yet `getComponent('cc.UITransform')` resolves → `reachable` returns true/false, not `'unsure'`. Carried as a **finding** (regression guard). |
| 8 | completeness / ground-truth | `localDriver.interactive` omits `reachability:true`; `install`/MCP `interactive` includes it — so `interactive`'s `reachable`/`blockedBy` are MCP-only, and the harness reach-gate uses the *separate* `driver.reachable`. The divergence is unpinned. | **Fixed-in-PLAN** — add an `SI` note/row pinning that `__copse.interactive` carries reachability while `localDriver.interactive` does not. Carried as a **finding**. |
| 9 | ground-truth | **C19 mislabelled `XT`** — compares copse `listeners` to copse snapshot `codeHandlers`, both the *same* `rt.codeHandlers(n)`; the deep-equal is tautological, zero independent signal. | **Fixed-in-PLAN** — relabel C19 `SI` (internal API/MCP-parity consistency). Real cross-tool code-handler independence stays on C17 (copse `listeners` vs coir = 0 edges) + script-source oracle (C01/C14). |
| 10 | ground-truth | **Reachability cluster (R01–R14, L30/L31, R17) mislabelled `AR`** — `reachable`/`blockedBy`/`occludedBy` are copse-derived occlusion *verdicts*; authored geometry is only the input. Draw-order rows (R13, R03, R04/R05) risk testing copse's ordering against an assumption that restates copse's own rule. | **Fixed-in-PLAN** — relabel these `XT`/derived-prediction. In RESULTS log the *independently* computed oracle from cocos geometry (each candidate's world rect + draw order derived by hand from sibling index + camera priority). Reserve `AR` for true geometry readbacks (A10/A12/A13 size/scale/worldPos). |
| 11 | ground-truth | P13 (standalone `diff`) labelled `D` but only checks `diff(before,after)` equals the auto-attached `press.changed` — same core `diff` fn, internal consistency. | **Fixed-in-PLAN** — relabel P13 `SI`; delta semantics already pinned by P03/P05/P08 against fixture logic. |
| 12 | ground-truth | D22 (`call` getter `== get`, "both ===4") compares two copse read paths agreeing; labelled `D` but it's internal consistency unless `4` is editor-authored. | **Fixed-in-PLAN** — pin `4` to a cocos-authored count and assert both paths `==` that authored value (`AR` anchor); else relabel `SI`. |
| 13 | ground-truth | C07's "`codeHandlers == listeners`" leg is copse-vs-copse (same source); only "Mask kept despite no button" is genuine `AR` against script source. | **Fixed-in-PLAN** — scope the `AR` claim to "Mask retained + `codeHandlers` field present (oracle = CopseMask script source)"; drop the equality leg (same note as C19). |
| 14 | executability | **Fixture backbone not authorable via cocos-creator MCP** — wiring `Button.clickEvents` to a script method needs a serialized `cc.ClickEvent` `{target,_componentId,handler}`; `component_set_component_property`'s enum stops at `stringArray`, `component_attach_script` only attaches. Every "editor-wired clickEvent" spec (S06/S07, D01/D04/D07, P04, X02/X05/X06/X17, the covered/blocked/unreached join inputs) cannot be built as claimed. | **Deferred-to-execution** — author clickEvents via an escape hatch (`sceneAdvanced_execute_scene_script` calling the editor EventHandler API, direct `.scene` JSON write, or `mcp__coir__edit_*`); state the chosen mechanism in RESULTS. Independence caveat carried as a **finding**. |
| 15 | executability | coir's static graph is stale immediately after fixtures are authored; the whole X-phase + every `XT` row joins against coir's view of `CopseTest`, which won't exist until coir re-reads the saved `.scene`. Execution order never calls rescan. | **Deferred-to-execution** — add an explicit `mcp__coir__rescan` after `scene_save_scene` (and after the X06 activate-and-resave); assert coir `find` returns the CopseTest buttons before any `XT` join. |
| 16 | executability | Scripts made with `project_create_asset` must be imported + TS-compiled before `component_attach_script` resolves the class and before the preview bundle includes their logic. The plan's "build scripts, then attach" has no compile/refresh/wait → attach + wiring + preview can race the import to an unresolved component. | **Deferred-to-execution** — insert `project_refresh_assets` (or poll `assetAdvanced_query_asset_db_ready`) and wait for compile after create, before attach; after wiring, reload the preview and assert snapshot finds the wired handler (`click_surface` method != null) before D/X rows. |
| 17 | executability | Connection target unstated — `connect(:7456)` serves whatever scene the preview is configured to load; the rig's start scene is `home`, not CopseTest. A misrouted preview is a silent mass-fail, not a clear error. | **Deferred-to-execution** — pin Preview → "Current Scene" (or `scene_open_scene CopseTest` then `mcp__copse__reload`); add a guard row asserting snapshot contains `AddBtn`/`ScoreLabel` before phase S, so a misroute fails loudly first. |
| 18 | executability | `emitTouch` returns true on dispatch regardless of whether a listener fired, and computes coords from `cams[0]`. Works because `dispatchEvent` invokes the node's own touch-end listeners directly — but a CopseTouch fixture that self-filters by hit-area/position would break the `count 0→1` delta. | **Deferred-to-execution** (fixture-authoring constraint) — make CopseTouch's `TOUCH_END` listener unconditional (bump on event, no coordinate gating); keep geometric reachability tested separately in phase R. |
| 19 | executability | Throughput/cost (not correctness) — phase L runs ~37 single-shot CLI rows, each a full Chrome boot+navigate+inject+close; serially against one preview the live portion is heavy and boot-timeout flake-prone. | **Accepted-limitation** — where parity is the only goal (L36) assert against captured MCP outputs instead of re-booting; raise per-connect timeout; note expected runtime so a slow boot isn't misread as FAIL. |

## Remaining untested (lower value; honest backlog)

Not blocking — narrow branches with indirect or unit coverage, or out of the live rig's reach:

- **Alpha hit-areas & opaque-sprite visual occlusion** in `reachable` — the documented capability
  boundary (input ignores opacity; a button covered by an opaque image with no input-consumer reads
  `reachable:true`). Not a regression, an acknowledged limit; `visible` is the partial complement.
- **Synthetic `TOUCH_*` beyond `emitTouch`'s click bump** — `press` still doesn't fire raw
  `on(TOUCH_MOVE/START)` listeners; only `TOUCH_END`/CLICK-shaped paths are exercised.
- **`hijack` post-install-only semantics** under a reload (capture buffer across `cp.reload()`).
- **Multi-session MCP** and the browser-use custom-actions example (open MCP-v2 step).
- **Adaptive re-planning within a round** (open harness step 5) — only cross-round target appearance
  is covered.
- **`call` on a minified component class** by mangled `constructor.name` (release-build name mangling
  vs `getComponent('Label')` resolution) — preview isn't minified, so unguarded on this rig.
- **`findCC()` cross-origin / nested-iframe walk** — the preview is same-origin single-frame; the
  puppeteer `page.frames()` cross-origin path has no rig oracle here.

## Findings worth carrying (into RESULTS)

- **FINDING-A (verification hygiene)** — `listeners` and snapshot `codeHandlers` are the **same**
  `rt.codeHandlers(n)` source (runtime.js:338 and :158). Any row comparing them (C19, the C07
  equality leg, P13 vs `press.changed`) is internal-consistency (`SI`), not cross-tool. Independent
  code-handler signal comes only from C17 (vs coir = 0 edges) + the fixture script source (C01/C14).
- **FINDING-B (documented product divergence)** — the `Node` pseudo-component is **get-only**:
  `get …:Node.prop` resolves the intrinsic, but `call …:Node.method` falls through to
  `getComponent('Node')` → `no-component`. Pin it; matches SELECTORS.md's read-only framing.
- **FINDING-C (surface divergence)** — `localDriver.interactive` omits `reachability:true` while
  `install`/MCP `interactive` includes it; the harness reach-gate therefore relies on the *separate*
  `driver.reachable`, not on `interactive`'s annotation. Either align the two or pin the divergence so
  a future spec doesn't assume `interactive` always annotates reachability.
- **FINDING-D (independence threat)** — if the clickEvents fixtures are authored by coir (the likely
  escape hatch for critique #14), **coir can no longer be the independent edge-count oracle** for
  `XT` rows (D04 "coir shows 2 edges", X02, X17). Switch those to cocos `get_component_info(Button)`
  `.clickEvents` readback; copse's *runtime* read stays independent, coir-wrote→coir-confirms does not.
- **FINDING-E (oracle discipline)** — `reachable`/`blockedBy`/`occludedBy` are copse-computed
  occlusion verdicts. To avoid circular `AR`, RESULTS must log the draw order recomputed by hand from
  cocos geometry (world rects + sibling index + camera priority), independent of copse's `orderKey()`.
- **FINDING-F (shipped-regression guard)** — the `UIT/UIR/BIE/BTN = Class || 'cc.ClassName'` fallbacks
  exist because `cc.UITransform` being undefined once made `reachable` return `'unsure'` for every
  button (a real build regression). No live rig reproduces it (preview has the globals); a fake-`cc`
  unit row (critique #7) is the only available regression guard — keep it.
