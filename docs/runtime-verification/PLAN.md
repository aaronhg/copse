# copse — runtime verification PLAN

Curated, ordered, executable matrix. Derived from a multi-agent design pass (11 lens
agents → **388 candidate specs** in `_design_raw.json`), de-duplicated here into the
canonical set actually executed. Every copse **primitive** (`snapshot` / `interactive` /
`clickSurface` / `resolve` / `press` / `get` / `call` / `reachable` / `node` / `diff` +
the `coverage.js` library fns), every **guard reason**, every **`press.drove`** value, every
**`reachable` tri-state**, every **`diff` bucket**, every **`coverageJoin` bucket**, and every
**harness hard-fail gate** appears ≥ once.

`_design_raw.json` (the 388-candidate superset) is the completeness backstop for the
audit; this file is the canonical run. **`RESULTS.md` is the per-test log** (one row per id:
verify-level, oracle value, observed, PASS/FAIL/FLAG).

## Ground-truth discipline

copse reading back its OWN snapshot and asserting on it is **circular**. Every spec pins
copse output to an **independent oracle**: a value authored via cocos-creator MCP, a
deterministic fixture-script delta, a cross-tool agreement with coir (static) / cocos-creator
(editor), or a pure shape/contract assertion. A spec whose only check is "copse said X, copse
still says X" is the cardinal sin — flagged, never run.

## Verify levels (label honestly in RESULTS)

- **AR — authored-readback**: copse reads a value the editor authored (`Label.string`,
  component field, `node.active`, geometry) → assert `==` the cocos-creator readback. The WRITE
  path is the editor, the READ path is copse. Strongest for reads.
- **D — delta**: copse `press`/`call` mutates; copse reads the **predicted** logical delta; the
  oracle is the deterministic fixture-script source (not a copse self-echo). A control press
  proves the instrument moves the needle.
- **XT — cross-tool**: copse's view agrees with **coir** (static node/ClickEvent graph) and/or
  **cocos-creator** (editor hierarchy/component readback / `execute_component_method`) on the same scene.
- **SI — structural-invariant**: shape/contract assertion over copse's documented behaviour
  (refusal envelope, omit-default fields, gate wiring, pure-fn over fakes). No external oracle —
  labelled as such.

## Fixtures (`assets/_copsetest/`, de-identified, deleted after the run)

ONE master scene `CopseTest.scene` carries every lens's nodes (rosters per cluster below); a
tiny companion `CopseTestB.scene` exists only for the reload-scene-switch spec. Scripts:
`CopseCtrl` (the Mgr controller/counter/panel/throw oracle), `CopseClick` / `CopseTouch` /
`CopseMulti` (code `node.on` wiring), `CopseMask` / `CopseEngineEvt` (non-button + filtered
events), `CopseLazyWire` (post-hijack registration), plus `CopseRow.prefab`. `_xtool-join.mjs`
is a throwaway runner for the library `coverageJoin`/`resolve*` (not MCP tools). See the
fixture objects for concrete cocos-creator MCP author steps. copse refs are **scene-root-relative**
(`Canvas/…`); coir prepends the scene-file head (`CopseTest/Canvas/…`) → the join's symmetric
tail match absorbs it (`dropped:'CopseTest'`).

> **Audit amendments folded in** (see `COVERAGE.md`): added rows G25, S15–S17, D26, R22–R24, C21–C22;
> relabelled C19/P13/D22 from cross-tool/delta to `SI` (internal-consistency, FINDING-A); added the
> Phase-R/-C oracle notes (FINDING-E/-A). Live-execution prerequisites are under *Execution order* below.

---

## Phase G — Guards & refusals (engine-level {ok:false,reason} + boundaries)

Pure-core/library + fake-tree, plus one live no-op anchor. Covers every refusal reason:
`not-found` · `no-component` · `not-a-button` · `disabled` · `unsupported`, the `splitMember`
throw, and the deliberate **boundaries** (missing member ≠ no-component; force scope; Node pseudo).

| id | case | action | ground truth | verify | expect |
|----|------|--------|--------------|--------|--------|
| G01 | get missing node | `get Canvas/Ghost:Label.string` | resolve→null | SI | `{ok:false,reason:'not-found'}` |
| G02 | get out-of-range `[i]` | `get Canvas/Item[9]:Label.string` | `same[9]` undef | SI | `{ok:false,reason:'not-found'}` |
| G03 | empty path → root → null | `node ''` | `cur===root?null` | SI | `not-found` (root not addressable) |
| G04 | get no-component | `get Canvas/ScoreLabel:Sprite.spriteFrame` | no Sprite (cocos comp list) | XT | `{ok:false,reason:'no-component'}` |
| G05 | **boundary** missing member | `get Canvas/ScoreLabel:Label.notAProp` | `readProp`→undefined | SI | `{ok:true,value:undefined}` (NOT no-component) |
| G06 | **boundary** Node pseudo missing intrinsic | `get Canvas/PlainNode:Node.bogus` | Node branch bypasses getComponent | SI | `{ok:true,value:undefined}` (never no-component) |
| G07 | Node pseudo honors not-found | `get Canvas/Ghost:Node.active` | resolve before Node branch | SI | `not-found` |
| G08 | splitMember no `:` | `get Canvas/ScoreLabel` | throw `:Comp.member` | SI | throws (→ MCP isError, L17 non-zero) |
| G09 | splitMember no `.` | `get Canvas/ScoreLabel:Label` | throw `Comp.member` | SI | throws |
| G10 | press missing node | `press Canvas/Ghost` | resolve→null | SI | `{ok:false,reason:'not-found'}`, no `fired`/`drove` |
| G11 | press non-button | `press Canvas/ScoreLabel` | asButton→null | XT | `{ok:false,reason:'not-a-button'}`; Label unchanged |
| G12 | press disabled | `press Canvas/DisabledBtn` | `interactable:false` (cocos) | AR | `{ok:false,reason:'disabled'}`, no actuation |
| G13 | force ⊄ not-a-button | `press Canvas/ScoreLabel {force}` | force check after asButton | SI | still `not-a-button` |
| G14 | force ⊄ not-found | `press Canvas/Ghost {force}` | force check after resolve | SI | still `not-found` |
| G15 | call missing node | `call Canvas/Ghost:CopseCtrl.add` | resolve→null | SI | `not-found` |
| G16 | call no-component | `call Canvas/ScoreLabel:CopseCtrl.add` | no CopseCtrl (cocos) | XT | `no-component` |
| G17 | **boundary** call non-method member | `call Canvas/Mgr:CopseCtrl.count` | `typeof!=='function'`→undef | D | `{ok:true,value:undefined}`; count unchanged |
| G18 | reachable missing node | `reachable Canvas/Ghost` | resolve→null | SI | `not-found` (no geometry) |
| G19 | reachable **unsupported** (core) | `reachable(scene, fakeRt∅, …)` | `!rt.reachable` | SI | `{ok:false,reason:'unsupported'}` |
| G20 | **boundary** reachable has no not-a-button guard | `reachable Canvas/CountLabel` | delegates any node | SI | `ok:true` + reachable/visible (covered≠refusal) |
| G21 | node missing | `node Canvas/Ghost` | resolve→null | SI | `not-found` |
| G22 | node **unsupported** (core) | `node(scene, fakeRt∅, …)` | `!rt.nodeInfo` | SI | `{ok:false,reason:'unsupported'}` |
| G23 | harness refusal passthrough | `runHarness` plan press DisabledBtn | `disabled` not in a gate bucket | SI | result reaches judge verbatim; no `undriven`/`errored` |
| G24 | **umbrella** asset untouched | cocos readback before/after whole G suite | copse never writes the source | XT | hierarchy + count(0) + label('0') + interactable flags byte-identical |
| G25 | **boundary** call Node pseudo → no-component | `call Canvas/Mgr:Node.active` | `call` has NO `comp==='Node'` branch (core) | SI | `{ok:false,reason:'no-component'}` — Node pseudo is **get-only** (FINDING-B) |

## Phase S — Read / shape (snapshot · interactive · clickSurface · node · listeners)

| id | case | action | ground truth | verify | expect |
|----|------|--------|--------------|--------|--------|
| S01 | slim descriptor shape | `snapshot{}` AddBtn/ScoreLabel | omit-default contract | SI | has `ref`, no `name`; active omitted when true; no `components` |
| S02 | relevant filter | `snapshot{relevant}` vs `{relevant:false}` | keep iff btn\|label\|code | SI | keeps AddBtn/ScoreLabel; drops bare Canvas/plain Item; subset |
| S03 | includeInactive delta | B\A of `{includeInactive}` vs default | authored inactive subtree (cocos) | XT | B\A == Panel subtree exactly |
| S04 | reachability opt-in | `snapshot{}` vs `interactive{}` | reachability gate | SI | default has no `reachable`; interactive does |
| S05 | interactive = buttons only | `interactive{}` vs coir `cc.Button` count | coir static button set | XT | ref set == coir buttons; every row `button:true` |
| S06 | clickSurface row-per-clickEvent | `click_surface{}` AddBtn/TwoEventBtn | coir ClickEvent handlers | XT | AddBtn 1 row `add`; TwoEventBtn 2 rows `add`,`reset` |
| S07 | clickSurface method:null | `click_surface{}` TouchBtn | empty clickEvents (cocos) | XT | one row `method:null`, no extras |
| S08 | clickSurface code ride-along | `click_surface{}` CodeBtn | `node.on('click')` (script src) | AR | `method:null` + non-empty `codeHandlers` |
| S09 | clickSurface drops non-button | `click_surface{}` | `if(!d.button)continue` | SI | no ScoreLabel/Item rows |
| S10 | node intrinsic shape | `node Canvas/Sized` / `Canvas/Item[0]` | conditional emission | SI | Sized has size+opacity; bare node omits opacity; never `onScreen` |
| S11 | active vs activeInHierarchy | `node Canvas/Panel/PanelChild` | active child / inactive parent (cocos) | AR | `active:true, activeInHierarchy:false` |
| S12 | listeners shape + filter | `listeners Canvas/CodeClickBtn` | script wires one click (src) | AR | `[{type:'click',fn:'onClick',target:'CopseClick'}]`; Button-own dropped |
| S13 | listeners [] vs null | `listeners AddBtn` / `listeners Ghost` | resolve guard | SI | `[]` (found, none) vs `null` (missing) |
| S14 | ref `[i]` generation | `snapshot{includeInactive}` Item* | 3 'Item' siblings (cocos) | XT | `Item[0..2]` present; unique names bare |
| S15 | logs functional readback + since | fixture `console.error('copse-log-x')` → `logs` / `logs{since:N}` | known string the fixture emits | D | `logs` row `{level:'error',text∋'copse-log-x'}`; `since:N` trims already-seen (SI for the index math) |
| S16 | clickSurface `data` (customEventData) | `click_surface{}` DataBtn vs AddBtn | authored customEventData (cocos Button readback) | XT | DataBtn row carries `data:'<v>'`; AddBtn omits `data` (omit-default) |
| S17 | interactive reachability divergence | `__copse.interactive` vs `localDriver.interactive` | source: `install` adds `reachability:true`, `localDriver` does not | SI | MCP/install row has `reachable`; localDriver row does not (FINDING-C) |

## Phase A — Authored-readback (values & intrinsics from the editor)

| id | case | action | ground truth | verify | expect |
|----|------|--------|--------------|--------|--------|
| A01 | get Label.string | `get Canvas/ScoreLabel:Label.string` | authored "0" (cocos) | AR | `{ok:true,value:"0"}` (string) |
| A02 | get numeric field | `get Canvas/Counter:CopseCtrl.count` | authored 5 | AR | `value:5` (number, not "5") |
| A03 | get Node.active | `get Canvas/Panel:Node.active` | authored false | AR | `value:false` (bool) |
| A04 | type fidelity bool/num/str | get string / fontSize / Node.active | authored "0"/40/false | AR | string/number/boolean preserved over bridge |
| A05 | `[i]` sibling readback | `get Canvas/Item[1]:Label.string` | 2nd Item authored 'item1' | AR | distinct from `Item[2]`='item2' |
| A06 | snapshot active:false | `snapshot{includeInactive}` Panel | authored false | AR | `active:false`; active sibling omits key |
| A07 | button interactable | `snapshot{}` AddBtn/DisabledBtn | authored true/false | AR | `interactable:true` / `false` |
| A08 | snapshot label field | `snapshot{}` ScoreLabel | authored '0' | AR | `label:'0'` |
| A09 | components opt-in vs cocos | `snapshot{components}` ScoreLabel | editor comp list | XT | type set == cocos (Label+UITransform); default omits |
| A10 | node size | `node Canvas/Sized` | UITransform 200×100 | AR | `size:{w:200,h:100}` |
| A11 | node opacity (conditional) | `node Sized` / `node ScoreLabel` | UIOpacity 128 / none | AR | `128` / no `opacity` key |
| A12 | node scale | `node Canvas/Sized` | scale (2,3) | AR | `scale:{x:2,y:3}` |
| A13 | node worldPos | `node Canvas/Sized` | cocos worldPosition | XT | `worldPos == round(editor)` |
| A14 | get Node.name | `get Canvas/ScoreLabel:Node.name` | cocos node name | XT | `'ScoreLabel'` |
| A15 | zero baseline anchor | get count & label vs cocos | preview built from saved scene | AR | copse 0/'0' == editor 0/'0' |
| A16 | snapshot nodeset vs coir+cocos | `snapshot{includeInactive}` refs | coir tree + cocos hierarchy | XT | ref set == both (modulo scene-root prefix) |

## Phase D — Mutation delta (`press` / `call` effects; `drove` matrix)

| id | case | action | ground truth | verify | expect |
|----|------|--------|--------------|--------|--------|
| D01 | press clickEvent | setCount0→press AddBtn→get count | `add()`+1 | D | `fired:1, drove:['clickEvent']`; count 0→1 |
| D02 | bound label lockstep | press AddBtn→get count & label | add sets both | D | count===1 AND label==='1' (two surfaces agree) |
| D03 | presses accumulate | press AddBtn ×2 | +1 each | D | both `fired:1`; count===2 |
| D04 | two clickEvents fired:2 | press Add2Btn (+coir 2 edges) | `clickEvents.length` | XT | `fired:2`; count+=2; coir shows 2 edges |
| D05 | disabled no-op | baseline→press DisabledBtn→count | handler not fired | D | `reason:'disabled'`; count unchanged |
| D06 | force overrides disabled | press DisabledBtn {force} | force skips gate | D | `ok:true,fired:1`; count 0→1 |
| D07 | changed.labelChanged | press AddBtn (inspect changed) | ScoreLabel '0'→'1' | D | `changed.labelChanged:[{ref,from:'0',to:'1'}]` |
| D08 | **drove:['click']** code-on-click | press CodeClickBtn→get count | on('click') bump | D | `fired:0, drove:['click']`, no `touched`; count 0→1 |
| D09 | **drove:['touch']** emitTouch | press TouchCodeBtn→get count | TOUCH_END bump | D | `fired:0, touched:true, drove:['touch'], wired:true`; count 0→1 |
| D10 | **drove:'nothing'** dead btn | press DeadBtn (+coir 0 edges) | no handlers | XT | `drove:'nothing', wired:false`; count unchanged; `listeners==[]` |
| D11 | **drove:['clickEvent','click']** both | press BothBtn | both effects | D | `drove==['clickEvent','click'], fired:1`; count+1 AND codeCount+1 |
| D12 | throwing handler | press ThrowBtn + logs | `boom()` throws known msg | D | isError OR `result.errors` ∋ 'copse-test-boom' (never silent ok:true) |
| D13 | swallowed throw surfaced | press SwallowBtn | console.error, no rethrow | D | `ok:true,fired:1` AND `result.errors` ∋ 'copse-swallow' |
| D14 | press refusals no mutation | press Ghost / ScoreLabel | resolve/asButton guards | SI | not-found / not-a-button; state untouched |
| D15 | happy press shape | press AddBtn | omit-default contract | SI | keys = `{ok,ref,fired,drove}(+changed)`; no `wired`/`touched` |
| D16 | call buy(30) return+effect | get gold→call buy 30→get gold | `gold-=n;return gold` | D+XT | `value:70`; gold 100→70; editor `execute_component_method` replicates |
| D17 | call args marshalling | call setCount 9→get count & label | sets both to 9 | D | `value:undefined`; count===9, label==='9' |
| D18 | call multi-arg | call add2 3 4→get count | `count+=a+b` | D | `value:7`; count 0→7 |
| D19 | call non-method member | call CopseCtrl.count | typeof guard | D | `ok:true,value:undefined`; no mutation |
| D20 | call throwing | call boom | propagated throw | D | isError / `result.errors` ∋ 'copse-test-boom' |
| D21 | call swallowed throw | call swallow | console.error captured | D | `ok:true,value:undefined` + `result.errors` ∋ 'copse-swallow' |
| D22 | call getter == get (internal parity) | call getCount vs get count | two copse read paths (same source) | SI | both equal; pin the value to an authored count for an `AR` anchor, else `SI` only |
| D23 | call object fidelity | call getState | `{count,gold}` | D | `value:{count,gold}` round-trips (not `[object Object]`) |
| D24 | cross-runtime replication | editor `add` vs preview press | same authored `add()` | XT | both deltas == +1 |
| D25 | no touch when on('click') | press CodeClickBtn (inspect touched) | `fired===0 && !droveClick` gate | D | no `touched`; codeCount===1 (not 2) |
| D26 | code-on('click') throw via emitClick | press ClickThrowBtn (its `on('click')` throws a known str) | `emitClick` un-guarded throw branch (NOT `fireClickHandlers`) | D | `drove:['click']`; isError OR `result.errors` ∋ 'copse-click-boom' (never silent `ok:true`) |

## Phase R — Reachability / visibility (`reachable` tri-state, blockedBy/occludedBy/visible)

> **Oracle discipline (FINDING-E):** `reachable`/`blockedBy`/`occludedBy` are copse-*computed* occlusion
> verdicts, not authored values — the `AR`-tagged rows here are really *derived-prediction* (treat as `XT`).
> In RESULTS the oracle is the draw order **recomputed by hand** from cocos geometry (each candidate's world
> rect + sibling index + camera priority), independent of copse's `orderKey()`. Reserve pure `AR` for the
> geometry readbacks (A10/A12/A13 size/scale/worldPos).

| id | case | action | ground truth | verify | expect |
|----|------|--------|--------------|--------|--------|
| R01 | **reachable:true** clean | `reachable Canvas/AddBtn` | nothing over center (cocos) | AR | `reachable:true, blockedBy:null, visible:true`, no occludedBy |
| R02 | **reachable:false** BIE | `reachable Canvas/CoveredBtn` | BlockInputEvents later sibling | AR | `false, blockedBy:'Canvas/Overlay'` |
| R03 | blocked by Button | `reachable Canvas/CoveredBtn2` | OverlayBtn (cc.Button) over it | AR | `false, blockedBy:'Canvas/OverlayBtn'` (consumer set ∋ Button) |
| R04 | **occludedBy** opaque sprite | `reachable Canvas/OccludedBtn` | Banner (Sprite-only, op255) | AR | `reachable:true, occludedBy:'Canvas/Banner', blockedBy:null` |
| R05 | renderer-only never blocks | same Banner fixture | no consumer on Banner | AR | blockedBy:null while occludedBy set |
| R06 | own-child not occluder | `reachable Canvas/SelfBgBtn` | Bg is a child (isAncestor guard) | AR | `reachable:true`, no occludedBy |
| R07 | invisible occluder skipped | `reachable Canvas/InvisOccBtn` | InvisBanner UIOpacity 0 | AR | `reachable:true`, no occludedBy |
| R08 | **visible:false** own opacity | `reachable Canvas/OpacityBtn` | own UIOpacity 0 | AR | `reachable:true, visible:false` |
| R09 | visible:false ancestor opacity | `reachable Canvas/HiddenPanel/PanelBtn` | ancestor UIOpacity 0 | AR | `visible:false` (own op 255) |
| R10 | visible:false ancestor scale | `reachable Canvas/ScalePanel/ScaleBtn` | ancestor scale (0,0) | AR | `visible:false` (reachable may be 'unsure') |
| R11 | **reachable:'unsure'** inactive | `reachable Canvas/ClosedPanel/ClosedBtn` | panel active:false | AR | `reachable:"unsure"` (literal, not true/false) |
| R12 | unsure⊄blocker; false→blocker | ClosedBtn vs CoveredBtn | branch contract | SI | unsure→blockedBy:null; false→non-null ref always |
| R13 | top-most of stack | `reachable Canvas/StackBtn` | Mask2 above Mask1 | AR | `blockedBy:'Canvas/Mask2'` (cmpKey top) |
| R14 | occludedBy ≠ blockedBy | `interactive{}` OccludedBtn+CoveredBtn | distinct authored comp sets | AR | one occludedBy(reach:true), one blockedBy(reach:false) |
| R15 | core unsupported | `reachable(scene,fakeRt∅,…)` | `!rt.reachable` | SI | `reason:'unsupported'` |
| R16 | core default visible:true | fakeRt `=>({reachable:true})` | `r.visible ?? true` | SI | `{reachable:true,blockedBy:null,visible:true}` |
| R17 | interactive ride-along blocked | `interactive{}` CoveredBtn | overlay geometry | AR | row `reachable:false, blockedBy:'Canvas/Overlay'` |
| R18 | interactive excludes inactive | `interactive{}` | default includeInactive:false | AR | no ClosedBtn row |
| R19 | omit-default reach fields | `interactive{}` AddBtn vs Covered/Opacity | desc assembly contract | SI | blockedBy/visible only when false; occludedBy whenever present |
| R20 | clickSurface ride-along + off | `click_surface{reachability:true}` / `:false` | reachable pass opt-out | SI+AR | flags present (Covered:false/Opacity:visible:false/Occluded:occludedBy) vs all stripped |
| R21 | reachable guard not-found | `reachable Canvas/GhostBtn` | resolve→null | SI | `not-found` (cross-ref G18) |
| R22 | **cross-camera z-order** priority override | `reachable Canvas/HiCamBtn` | hi-priority-camera sprite EARLIER in sibling order (cocos camera priority) | XT | `blockedBy` the hi-cam node — camera priority overrides sibling z (`camOf`/`orderKey`) |
| R23 | disabled-camera skip | `reachable Canvas/DisCamBtn` | covering node's camera `enabled:false` (cocos) | XT | NOT blocked by the disabled-camera node (`c.enabled===false` skip) |
| R24 | tree-shake fallback (no live rig) | `reachable` over fake `cc` (UITransform global undefined, getComponent resolves) | `UIT = Class \|\| 'cc.UITransform'` fallback | SI | returns true/false, NOT `'unsure'` (FINDING-F regression guard) |

## Phase P — Panel open/close via `diff` (every diff bucket)

| id | case | action | ground truth | verify | expect |
|----|------|--------|--------------|--------|--------|
| P01 | initial inactive readback | snapshot{incInactive}+node+get Node.active | authored active:false | AR | Panel `active:false`; node both false; get false |
| P02 | default omits closed subtree | `snapshot{}` vs `{includeInactive}` | recursion guard | AR | Title/CountLabel/PanelCloseBtn only in includeInactive |
| P03 | open via call → **activated** | call open; diff incInactive before/after | `open()` sets active true | D | subtree in `activated`, NOT `appeared`; node activeInHierarchy flips |
| P04 | open via press → changed | press OpenBtn | wired→open (coir confirms) | D | `fired≥1,drove∋clickEvent`; `changed.activated` ∋ Title |
| P05 | close → **deactivated** | press CloseBtn | `close()` active false | D | `changed.deactivated` ∋ subtree; node.active false |
| P06 | **appeared** vs activated | default-before vs incInactive-before, same open | diff semantics | SI | appeared from default-before; activated from incInactive-before |
| P07 | **disappeared** vs deactivated | default-after vs incInactive-after, same close | diff semantics | SI | disappeared from default-after; deactivated from incInactive-after |
| P08 | **labelChanged** bound | open; diff + get openCount | open sets count '0'→'1' | D | `labelChanged:{ref:CountLabel,from:'0',to:'1'}`; get openCount===1 |
| P09 | labelChanged-not-activated | open; diff StatusLabel | always-active, string only | D | StatusLabel in labelChanged only (not activated/appeared) |
| P10 | omitted-active = active | inspect StatusLabel descriptors | `active!==false` coercion | SI | no `active` key; not in activated/deactivated |
| P11 | whole subtree activates | open; diff + node per child | activeInHierarchy inherits | D | all descendants in activated; each node true after |
| P12 | activated = full descriptors | open; inspect activated entries | push `da` not bare ref | AR | Title entry `.label==='Shop'`; PanelCloseBtn `.button===true` |
| P13 | standalone diff == press.changed (internal) | snapshot×2 + `diff{before,after}` | same core `diff` fn | SI | equals auto-attached press.changed (internal consistency; delta semantics pinned by P03/P05/P08) |
| P14 | relevant drops bare container | open; diff relevant vs relevant:false | relevant filter | SI | bare `Canvas/Panel` only in relevant:false activated |
| P15 | noop press → no changed | press NoopBtn | empty diff → omit `changed` | SI | `drove∋clickEvent`, no `changed`, no `errors` |
| P16 | empty diff | snapshot×2 identical | pure fn | SI | all five buckets `[]` |
| P17 | idempotent reopen | open already-open; diff + get openCount | active stays, count++ | D | `activated:[]`; labelChanged '1'→'2'; openCount===2 |
| P18 | toggle state machine | toggle ×3 + node.active | closed→open→closed→open | D | activated/deactivated/activated; active true/false/true |
| P19 | **appeared/disappeared** spawn | spawn then despawn; diff each | addChild/destroy Toast | D | diff1.appeared ∋ Toast(label'Saved'); diff2.disappeared ∋ Toast |
| P20 | labelChanged shape | inspect a labelChanged entry | `{ref,from,to}` | SI | exactly ref/from/to; distinct from descriptor buckets |
| P21 | diff null/empty inputs | `diff([],[])` / `diff(null,null)` | `(x||[])` guards | SI | all buckets `[]`, no throw |
| P22 | CloseBtn reachable only-when-open | reachable closed then open | inactive→active panel | SI | closed false/'unsure'; open true,blockedBy:null (best-effort) |
| P23 | cross-tool structure | snapshot vs coir tree vs cocos | two non-copse oracles | XT | Panel subtree refs == coir + editor (modulo root) |

## Phase C — Code handlers (`listeners` · `codeHandlers` · `hijack` · `captured` · emitTouch)

> **FINDING-A:** `listeners` and snapshot `codeHandlers` are the *same* `rt.codeHandlers(n)` call — any row
> comparing them (C19/C22, the C07 equality leg) is internal-consistency (`SI`), never cross-tool. Independent
> code-handler signal comes only from C17 (vs coir = 0 edges) + the fixture script source (C01/C14).

| id | case | action | ground truth | verify | expect |
|----|------|--------|--------------|--------|--------|
| C01 | listeners click shape | `listeners CodeClickBtn` | script wires one click (src) | AR | `[{type:'click',fn:'onClick',target:'CopseClick'}]` |
| C02 | listeners filters Button-own | `listeners TouchCodeBtn` | script touch-end; Button touch internal | SI | `[{type:'touch-end',…}]` only; no Button touch-* |
| C03 | listeners multi | `listeners MultiCodeBtn` | click+touch-start (src) | SI | two entries onClick/onDown, no dup |
| C04 | listeners filters engine/mouse | `listeners EngineEvtNode` | transform-changed+mouse-down wired | SI | `[]` (both filtered) |
| C05 | listeners non-button mask | `listeners Canvas/Mask` | TOUCH_START on plain Node | AR | `[{type:'touch-start',…}]` (not button-gated) |
| C06 | listeners [] vs null | `listeners DeadBtn` / `Ghost` | resolve guard | SI | `[]` vs `null` |
| C07 | snapshot codeHandlers keeps code-only | `snapshot{relevant,includeInactive}` | hasCode keep + field | AR | Mask kept (no button) w/ codeHandlers == listeners |
| C08 | press drove:['click'] | press CodeClickBtn | emitClick reaches on('click') | D | `fired:0,drove:['click']`, count++ (cross-ref D08) |
| C09 | press drove:['touch'] emitTouch | press TouchCodeBtn | synthetic TOUCH_END | D | `touched:true,drove:['touch'],wired:true`, count++ |
| C10 | droveClick skips touch | press MultiCodeBtn | gate | D | `drove:['click']`; clickCount 0→1, touchCount stays 0 |
| C11 | interactable guard + force | press GuardedBtn then {force} | interactable:false (cocos) | D | `disabled` (count 0); force→`drove:['click']` count 1 |
| C12 | drove:'nothing' core contract | `press(fakeRt no emitTouch, empty btn)` | core branch | SI | `{fired:0,drove:'nothing',wired:false}` |
| C13 | hijack idempotent | `hijack{}` ×2 | `__copseHijacked` flag | SI | `already:false` then `already:true` |
| C14 | captured after hijack | captured→hijack→call wireNow→captured | post-hijack registration (src) | AR | `[]` then `[{type:'click',fn:'onLate',target:'CopseLazyWire'}]`; listeners agrees |
| C15 | captured pre-hijack empty | hijack after load; captured vs listeners ClickCodeBtn | temporal boundary | SI | captured `[]` while listeners shows the click |
| C16 | captured miss → null | `captured Canvas/Ghost` | resolve guard | SI | `null` |
| C17 | coir blind to code handler | listeners + click_surface vs coir | empty clickEvents, code-wired | XT | coir 0 edges; copse listeners shows it; row method:null + codeHandlers |
| C18 | minification caveat | `listeners ClickCodeBtn` (preview) | dev build names | SI | fn/target human-readable; release-strip documented (untested here) |
| C19 | listeners↔codeHandlers parity (internal) | `listeners` vs snapshot codeHandlers | SAME `rt.codeHandlers(n)` source | SI | deep-equal set — internal consistency only, NOT cross-tool (FINDING-A) |
| C20 | MCP hijack+captured roundtrip | hijack→call wireNow→captured | same temporal contract via tools | AR | `[{…onLate…}]`; without hijack first → `[]` |
| C21 | hijack `off()` removal branch | hijack → fixture `node.on()` (captured shows) → fixture `node.off()` same (type,cb,target) → captured | hijack patches `off()` too (runtime.js) | AR | captured DROPS the entry after `off()` (oracle = CopseLazyWire source) |
| C22 | codeHandlers field == listeners is internal | snapshot codeHandlers vs listeners (CodeBtn) | same `rt.codeHandlers(n)` source | SI | equal — same as C19/FINDING-A; independent signal is C17 + script source |

## Phase X — Cross-tool coverage join (copse × coir; every `coverageJoin` bucket)

Library-unit rows run via `_xtool-join.mjs` (pure node, no rig); live rows capture
`click_surface` + coir `find`/`deps` and join. Buckets: **covered · blocked · unreached ·
ambiguous · uncertain · codeRegistered · codeOnly**.

| id | case | action | ground truth | verify | expect |
|----|------|--------|--------------|--------|--------|
| X01 | join key integrity | click_surface(method≠null) vs coir ClickEvents | serialized handler string (both read same JSON) | XT | aligned `(tail,method)` sets identical |
| X02 | **covered** exact/prefix | join AddBtn | coir wired+reachable | XT | covered `via:'prefix',dropped:'CopseTest',mount:''`,handlerClass'CopseCtrl' |
| X03 | **blocked** overlay | reachable CoveredBtn + join | coir wired, copse reachable:false | XT | `blocked`, runtime.blockedBy='Canvas/Overlay'; in no other bucket |
| X04 | **uncertain** occluder | reachable OccludedBtn + join | coir wired, occludedBy set | XT | `uncertain`; not covered/blocked |
| X05 | **unreached** inactive panel | click_surface (CloseBtn absent) + join | coir tree ∋ CloseBtn, copse omits | XT | `unreached` raw static row |
| X06 | unreached→covered delta | activate Panel, re-join | authored active flip (cocos) | XT | CloseBtn moves to covered; only Panel.active changed |
| X07 | **codeOnly** TouchBtn | join (coir no edge) | empty clickEvents both tools | XT | `codeOnly{method:null}`; not codeRegistered |
| X08 | **codeRegistered** vs codeOnly | join CodeBtn vs TouchBtn | code-wired vs bare | XT | CodeBtn codeRegistered (codeHandlers≠[]); TouchBtn codeOnly; neither covered |
| X09 | prefix **mount** prefab | join CopseRow/Btn (1 instance) | within-prefab path (coir) | XT | covered `via:'prefix',mount:'Canvas/List',dropped:''` |
| X10 | **ambiguous** 2 instances | join CopseRow/Btn (2 instances) | 1 static ↦ 2 live | XT | `ambiguous.candidates==[ref,ref[1]]`; covered∅; consumed (no codeOnly leak) |
| X11 | `[i]` agree-or-drift | snapshot vs coir [i]; re-join | independent sibling order | XT | indices equal OR differ-but-prefix-tier still covers |
| X12 | resolveCoirPath scene-root | `resolve CopseTest/Canvas/AddBtn` + get | coir path in, copse ref out | XT | `{ref:'Canvas/AddBtn',mount:'',dropped:'CopseTest'}`; get reads '0' |
| X13 | resolve→press round-trip | raw coir path press (fails) → resolve → press | deterministic addScore (+1) | XT+D | raw `not-found`; resolved press `fired:1`; label '0'→'1' |
| X14 | resolve sees inactive | click_surface (no CloseBtn) vs `resolve …Panel/CloseBtn` | resolve uses includeInactive:true | XT | resolve non-null while click_surface omits |
| X15 | resolve ambiguous live | `resolve CopseRow/Btn` | 2 live instances | XT | `{ambiguous:[ref,ref[1]]}` |
| X16 | resolve null foreign path | `resolve home/Canvas/…` | path from another scene | XT | `null` (no cross-scene false match) |
| X17 | mcp click_surface method | `click_surface` AddBtn vs cocos handler | authored clickEvents[0].handler | AR | `method==='addScore'`,component'CopseCtrl',interactable/reachable true |
| X18 | click_surface reachability:false | `click_surface{reachability:false}` vs true | opt-out contract | SI | reach/visibility fields stripped; (ref,method) set identical |
| X19 | join method:null skipped | `join([{method:null}],[])` | line 64 guard | SI | `[[],[],[]]` |
| X20 | covered requires reach&&interact | join ok/reach:false/interact:false | branch 77-81 | SI | covered=[Ok]; blocked=[Rf,If] |
| X21 | unsure/occluded → uncertain | join unsure + occludedBy rows | branch 80 | SI | both in uncertain; blocked=0 |
| X22 | ambiguous no codeOnly leak | join 1 static ↦ 2 runtime | consumed set | SI | candidates set; covered 0; codeOnly 0 |
| X23 | `[i]` fuzzy vs exact | join `Row/Cell[0]/Btn` ↦ `…Row[3]/Cell[1]/Btn` | nameOf strips [i] | SI | covered via:'prefix',mount inferred (exact would miss) |
| X24 | scene-root dropped (coir longer) | join `home/Canvas/…` ↦ `Canvas/…` | symmetric tail | SI | `{via:'prefix',mount:'',dropped:'home'}` |
| X25 | tailMatch empty/non-suffix | join `''` & `Foo/Bar` ↦ `Canvas/Baz/Qux` | n=0 / mismatch | SI | both unreached; runtime→codeOnly; no false covered |
| X26 | resolveCoirPath branches | unique / >1 / none | unit | SI | `{ref,mount,dropped}` / `{ambiguous}` / `null` |
| X27 | resolveCopseRef reverse | live ref → coir nodePath | unit | SI | `{nodePath,mount:'',dropped:'home'}`; handlerClass on row |
| X28 | join codeRegistered vs codeOnly | method:null +codeHandlers vs bare | sweep 88-91 | SI | cr=[Code], co=[Bare], cov=0; handler info rides along |
| X29 | consumed double-count probe | join exact + shorter-prefix static, 1 runtime | prefix tier skips consumed | SI | **FLAG**: pin whether the live row is double-counted (exact+prefix) |

## Phase M — MCP layer (dispatcher · registry · tools · stdio)

Pure dispatcher/registry rows via `createDispatcher`/imports (no browser); live rows over a
real `connect()`. Covers the **engine-error→isError** contract and the `--debug` gate.

| id | case | action | ground truth | verify | expect |
|----|------|--------|--------------|--------|--------|
| M01 | registry well-formed | import TOOLS | @type contract | SI | every entry name/desc str, inputSchema object, run fn |
| M02 | tool counts 24/17/7 | import TOOLS | source registry | SI | total 24, core 17, debug 7 (flag stale 14/16 docs) |
| M03 | names 1:1 Driver | TOOLS vs cp methods | snake→camel | SI | only connect/resolve non-Driver; click_surface↔clickSurface |
| M04 | debug tag set | filter debug | break_*/wait_pause/eval_frame/debug_step/clear | SI | exactly the 7 |
| M05 | inputSchema.required | per-tool required vs run body | source | SI | press[ref],get/call[sel],diff[before,after]… match |
| M06 | initialize serverInfo | `initialize` | package.json version | AR | `{name:'copse',version:'0.0.1'}`, capabilities.tools |
| M07 | protocol echo/default | initialize w/ & w/o pv | source | SI | echoes client; default '2025-06-18' |
| M08 | ping | `ping` | contract | SI | `{result:{}}` |
| M09 | notifications no reply | initialized/cancelled | JSON-RPC | SI | `null` both |
| M10 | unknown method | `frobnicate` w/ & w/o id | default case | SI | `-32601` / `null` |
| M11 | list hides debug default | `tools/list` (cp:null) | filter | SI | 17, no break_in |
| M12 | list shows debug w/ flag | `tools/list` ({debug}) | filter branch | SI | 24, break_in present |
| M13 | list projection | map entries | only 3 keys | SI | no run/debug leak |
| M14 | call data roundtrip | press fake (changed) | toolResult(JSON) | SI | content text JSON intact; isError undefined |
| M15 | arg default + snapshot relevant | call snapshot no args | `args={}`, `relevant??true` | SI | recorded `{relevant:true,…}` |
| M16 | force passthrough | press force / bare | `a.force?{force:true}:{}` | SI | `[['X',{force:true}],['Y',{}]]` |
| M17 | args spread | call w/ & w/o args | `...(a.args||[])` | SI | `[sel,[30]]` / `[sel,[]]` |
| M18 | call unknown tool | `tools/call name:nope` | !tool branch | SI | `-32602` env (not isError) |
| M19 | call no params | `tools/call` no params | `params||{}` | SI | `-32602` unknown tool: undefined |
| M20 | needCp isError | press w/ cp:null | needCp throw | SI | isError, /no open game/ |
| M21 | run-throws isError + ✗ | snapshot throws (plain & ✗) | catch + strip | SI | `✗ boom`; leading ✗ not doubled |
| M22 | success no isError | get {ok,value} | success branch | SI | isError absent; value present |
| M23 | connect opt mapping | source review tools.js | run body | SI | headed/fps/browserURL/attach+match→opts; target=url\|\|match |
| M24 | connect live summary | `connect{url}` | editor/coir button count | XT | `{ok:true,buttons===1,relevantNodes≥2}` |
| M25 | connect retarget | connect ×2 + snapshot | `if(state.cp)close` | SI | 2nd ok; snapshot drives new session |
| M26 | connect error isError | connect bad/unreachable url | throw on no cc | SI | isError /timeout\|cc\|navigation/ |
| M27 | connect paused branch | attach to paused renderer | `state.cp.paused` | SI | `{paused:true,note}`, no relevantNodes |
| M28 | reload needCp | reload w/ cp:null | needCp | SI | isError /no open game/ |
| M29 | reload waitUntil | reload {} / {waitUntil} | passthrough | SI | `[{},{waitUntil:'networkidle0'}]` |
| M30 | reload scene switch | open CopseTestB, reload, snapshot | editor current scene | XT | snapshot ∋ OtherBtn, ∌ AddBtn |
| M31 | close teardown | close (fake cp+dbg) | detach+null | SI | cpClosed,dbgDetached, state nulled |
| M32 | close idempotent | close (cp:null) | guards not needCp | SI | `{ok:true}`, no isError |
| M33 | debug dispatch hidden-callable | clear_breakpoints (debug unset, dbg seeded) | gate only in list | SI | ok:true, called |
| M34 | debug_step route | step over / resume | resume ternary | SI | `[['step','over'],['resume']]` |
| M35 | ensureDbg needCp | break_exceptions cp:null | ensureDbg→needCp | SI | isError /no open game/ |
| M36 | stdio pure stdout | spawn `copse mcp`, init+list | console→stderr, stdout JSON | SI | every stdout line parses; ready on stderr |
| M37 | stdio noise ignored | blank+garbage+ping | skip + try/catch | SI | only ping reply |
| M38 | stdio eof teardown | one req, close stdin | rl close→exit(0) | SI | exit 0 |
| M39 | cli --debug flips count | spawn w/ & w/o `--debug` | ready line | SI | 'ready — 17 tools (+7…)' vs '24 tools' |
| M40 | --browser-url not url | `mcp --browser-url …` | VAL_FLAGS guard | SI | 'waiting for connect(url)' (not pre-opened) |
| M41 | mcp get live readback | author "7", `get` | cocos authored value | AR | `{ok:true,value:"7"}` |
| M42 | mcp press live delta | get→press→get count | fixture +1 | D | `fired≥1,drove∋clickEvent`; count N→N+1 |
| M43 | mcp snapshot live vs editor | snapshot{} & {includeInactive} | cocos hierarchy | XT | default ∋ScoreLabel/AddBtn ∌CloseBtn; incInactive adds CloseBtn |

## Phase H — Harness hard-fails (`runHarness` gates)

FAKE = `localDriver(fixture(),fakeRuntime())`, methods overridden per-spec; live rows over the
real puppeteer driver against `CopseTest.scene`. Gates: **reachableGate · errorGate · driveGate**;
**uncertain** is surfaced not failed.

| id | case | action | ground truth | verify | expect |
|----|------|--------|--------------|--------|--------|
| H01 | happy control | plan press+call+get, judge true | scripted core+fixture | SI | pass:true, 1 round; no gate keys; press `drove:['clickEvent']` |
| H02 | **reachableGate** hard-fail | reachable:false, judge+report pass | gate overrides opinion | SI | pass:false; `unreachable:[{ref,blockedBy}]`; step.result.unreachable set |
| H03 | reachableGate live | runHarness press CoveredBtn (real) | overlay geom (cocos)+coir wired | XT | pass:false; unreachable[0].ref CoveredBtn |
| H04 | force bypass | press {force:true}; reachable spy | `!(opts.force)` guard | SI | pass:true; reachable called 0×; no unreachable |
| H05 | reachableGate:false | reachable:false, gate off | skipped in execStep | SI | pass:true; no `unreachable` key (not even computed) |
| H06 | blockedBy falsy → true | reachable:false,blockedBy:null | `||true` | SI | `unreachable:[{ref,blockedBy:true}]` |
| H07 | reach press-only | get step; reachable spy | gate in `case 'press'` | SI | spy 0×; pass:true |
| H08 | reach degrades no signal | no reachable() / unsupported rt | capability guard | SI | pass:true; no unreachable; press ran |
| H09 | reach throws caught | reachable throws | best-effort try/catch | SI | pass:true; no unreachable |
| H10 | **uncertain** unsure | reachable:'unsure' | surfaced not failed | SI | pass:true; `uncertain:[{ref,why:'unsure'}]` |
| H11 | uncertain occluded | reachable:true+occludedBy | branch | SI | `uncertain:[{why:'occluded:Canvas/Img'}]`; pass:true |
| H12 | uncertain touch-into-void | press drove:['touch'],wired:false | branch | SI | `uncertain:[{why:'touch-into-void'}]`; no undriven |
| H13 | uncertain precedence | occluded + touch-void | `!uncertain` guard | SI | why==='occluded:…' (not overwritten) |
| H14 | **driveGate** hard-fail | press drove:'nothing', judge+report pass | gate | SI | pass:false; `undriven:[{ref}]` |
| H15 | driveGate live | press DeadBtn (real) | coir 0 edges + empty clickEvents | XT | pass:false; undriven[0] DeadBtn |
| H16 | driveGate:false | drove:'nothing', gate off | surfaced unconditionally | SI | pass:true; `undriven` STILL present |
| H17 | **errorGate** errors[] | press errors[] (swallowed) judge+report pass | log-diff | SI | pass:false; errored[0].error /TypeError/ |
| H18 | errorGate threw | press throws | execStep catch reason:'threw' | SI | pass:false; result `{reason:'threw',error}`; errored set |
| H19 | errorGate:false | errors[], gate off | computed unconditionally | SI | pass:true; `errored` STILL present |
| H20 | errorGate op-agnostic ref | call step throws | `ref\|\|sel\|\|op` | SI | errored[0].ref = the sel |
| H21 | errorGate logged live | press ThrowBtn (real) | known throw via log-diff | D | pass:false; errored[0].error ∋ 'copse-harn-boom' |
| H22 | throwing+unknown-op captured | plan press(throws)+frobnicate | loop continues | SI | 2 steps recorded; pass:false (errorGate) |
| H23 | unknown-op not hard-fail | plan frobnicate, judge true | default arm | SI | pass:true; result `{reason:'unknown-op',op}` |
| H24 | op dispatch | get/call/snapshot/interactive | switch | SI | get 100, call 60 (args spread), arrays; pass:true |
| H25 | next iterate bounded | next:{continue:true}, maxRounds:3 | bound + re-snapshot | SI | rounds 3; snapshot 3× |
| H26 | next absent → 1 round | no next, maxRounds:5 | default policy | SI | rounds 1 |
| H27 | next stop | next →{continue:false}/null | break | SI | rounds 1 both |
| H28 | re-snapshot timing | maxRounds:2, next:true | `round<max-1` | SI | snapshot 2× (none after capped round) |
| H29 | maxRounds:0 | maxRounds:0 | loop never enters | SI | pass:false, rounds:0; snapshot present |
| H30 | empty verdict passes | judge →{} | `pass!==false` | SI | pass:true |
| H31 | context verbatim | record ctx.context each stage | passed verbatim | SI | plan/judge/next/report all got same object |
| H32 | report overrides AND | judge true, report {pass:false} | `'pass' in rep` | SI | pass:false; summary set |
| H33 | report plain = summary | report →'just text' | else-branch | SI | pass:true; summary='just text' |
| H34 | report absent | no report | block skipped | SI | no `summary` key |
| H35 | report cannot pass gates | each gate trips, report {pass:true} | re-force after report | SI | pass:false (all 3); summary still set |
| H36 | report receives gate-adjusted | reachable:false; report reads ctx | line 181 | SI | ctx.pass false, ctx.unreachable set; final false |
| H37 | happy live delta control | get→press AddBtn→get (real) | fixture +1, uncovered | D | pass:true; values differ by 1; no gate keys |

## Phase L — CLI single-shots (`src/cli.js`)

| id | case | action | ground truth | verify | expect |
|----|------|--------|--------------|--------|--------|
| L01 | --version / -V / fallback | `--version`, `-V`, isolated copy | package.json / catch '?' | AR+SI | '0.0.1' exit0; copy→'?' |
| L02 | --version precedence | `get … --version` | line-20 short-circuit | AR | prints version, no connect/get |
| L03 | --help / -h | `--help`, `-h` | USAGE literal | SI | USAGE text, exit0 |
| L04 | no-args exit1 | `copse` | `cmd?0:1` | SI | USAGE, exit1 |
| L05 | unknown command | `frobnicate <url>` | else-branch | SI | stderr 'unknown command', exit1 |
| L06 | bare -v unknown | `-v` | -v is verbose flag | SI | 'unknown command: -v', exit1 |
| L07 | no target exit1 | `get` | target guard pre-import | SI | '<url> … required', exit1, no browser |
| L08 | no selector per-cmd example | `get`/`call`/`press <url>` | per-cmd literal | SI | examples Score:Label.string / Mgr:Ctrl.buy 30 / ShopBtn; exit1 |
| L09 | ai no goal / no target | `ai <url>` / `ai --goal …` | guards | SI | '--goal is required' / '<url> … required', exit1 |
| L10 | url finder skips VAL_FLAGS | `get --browser-url http://decoy … sel` | VAL_FLAGS guard | SI | decoy not taken as url → exit1 |
| L11 | get label readback | `get <url> Canvas/ScoreLabel:Label.string` | authored '0' | AR | `{ok:true,value:'0'}`, exit0 |
| L12 | get Node.active | `get … Canvas/Panel:Node.active` | authored false | AR | `value:false`, exit0 |
| L13 | get component field | `get … Canvas/Mgr:CopseCtrl.count` | authored 0 | AR | `value:0`, exit0 |
| L14 | get not-found exit1 | `get … Canvas/Nope:Label.string` | node absent (cocos) | AR | `not-found`, exit1 |
| L15 | get no-component exit1 | `get … ScoreLabel:Sprite.spriteFrame` | no Sprite (cocos) | AR | `no-component`, exit1 |
| L16 | get bad member ok:true | `get … CopseCtrl.nope` | undefined dropped | SI | `{ok:true}` no value key, exit0 |
| L17 | malformed selector throws | `get … Canvas/ScoreLabel` | no try/catch | SI | non-zero exit + stack (CLI≠MCP {error}) |
| L18 | press delta | `press <url> Canvas/AddBtn` | onAdd '0'→'1' | D | `fired:1,drove:['clickEvent'],changed.labelChanged`; exit0 |
| L19 | press disabled exit1 | `press … Canvas/DisabledBtn` | interactable:false | AR | `disabled`, exit1 |
| L20 | press --force | `press … DisabledBtn --force` | force bypass | D | `fired:1,drove:['clickEvent']`, count++, exit0 |
| L21 | press not-found / not-a-button | `press … Nope` / `ScoreLabel` | guards | AR | exit1 each |
| L22 | press drove:'nothing' exit0 | `press … Canvas/DeadBtn` | no handlers | AR | `ok:true,drove:'nothing',wired:false`, **exit0** (caveat) |
| L23 | call numeric arg | `call … CopseCtrl.add 5` | jsonOr→5 | D | `value:5`; count===5 |
| L24 | call string arg | `call … setName hello` | jsonOr stays string | D | `value:'hello'` |
| L25 | call json object arg | `call … setConfig '{"a":1}'` | parsed object | D | `value:'{"a":1}'` |
| L26 | call multi-arg | `call … addPair 2 3` | both parsed | D | `value:5` (not '23') |
| L27 | call not-found / no-component | `call … Nope…` / `ScoreLabel…` | guards | AR | exit1 each |
| L28 | node intrinsics | `node … Canvas/Panel` | active:false + size | AR | `active:false,activeInHierarchy:false,size`, exit0 |
| L29 | node not-found | `node … Canvas/Nope` | absent | AR | `not-found`, exit1 |
| L30 | reachable clear | `reachable … Canvas/AddBtn` | uncovered (cocos) | AR | `reachable:true,blockedBy:null,visible:true`, exit0 |
| L31 | reachable blocked exit0 | `reachable … Canvas/CoveredBtn` | Overlay geom | AR | `reachable:false,blockedBy:'Canvas/Overlay'`, **exit0** (caveat) |
| L32 | reachable not-found | `reachable … Canvas/Nope` | absent | AR | `not-found`, exit1 |
| L33 | sel order independence | `get … <sel> <url>` | `a!==url` filter | AR | same as url-first; `value:'0'` |
| L34 | scan counts + labels | `scan <url>` | coir button count + cocos labels | XT | 'nodes\|buttons\|labels' (buttons==coir); labels ∋ ScoreLabel '0' |
| L35 | scan -o appends | `scan <url> -o <dir>` | sink writes scan.log | SI | scan.log == stdout; appends on 2nd run |
| L36 | parity vs MCP | CLI get/call/node/reachable/press/scan-interactive | both funnel to cp.X | SI | CLI shape == MCP data (value correctness pinned by L11/L23/L28/L31) |
| L37 | ai exit mirrors report.pass | `ai <url> --goal … --rounds 1` | report.pass?0:1 | SI | exit 0 on pass goal / 1 on fail goal; DONE line agrees |

---

## Execution order

> **Live-execution prerequisites** (COVERAGE critiques #14–18, *deferred-to-execution*): **(a)** the
> cocos-creator MCP cannot wire `Button.clickEvents`→a script handler — author clickEvents via an escape
> hatch (`sceneAdvanced_execute_scene_script` EventHandler API / direct `.scene` JSON / `mcp__coir__edit_*`)
> and record which in RESULTS; if **coir** authors them, switch the `XT` edge-count oracle to cocos
> `get_component_info(Button).clickEvents` (FINDING-D — coir-wrote can't coir-confirm). **(b)**
> `mcp__coir__rescan` after every `scene_save_scene` so coir's static view is fresh before any `XT` join.
> **(c)** after `project_create_asset` for the `Copse*.ts` scripts, `project_refresh_assets` + wait for
> compile (`assetAdvanced_query_asset_db_ready`) before `component_attach_script`; then reload the preview and
> assert `click_surface` method≠null before the D/X rows. **(d)** route the preview to `CopseTest`
> (`scene_open_scene` + `mcp__copse__reload`); a guard row must see `AddBtn`/`ScoreLabel` before phase S.
> **(e)** make `CopseTouch`'s `TOUCH_END` listener unconditional (no coordinate gating).

1. **Pure/library first (no rig)** — fake-tree & dispatcher rows: G19, G22, R15, R16, C12,
   X19–X28, M01–M23, M31–M35, H01–H02,H04–H14,H16–H20,H22–H37, L01–L10, L16–L17. Cheap,
   deterministic, catch contract regressions before any browser.
2. **Author the master fixture** — build `CopseTest.scene` (+ scripts/prefab + `CopseTestB.scene`)
   via cocos-creator MCP, save, open, preview (:7456), `mcp__copse__connect` + `reload`.
3. **Authored-readback / shape** — S (read/shape), A (authored-readback), the live G refusals
   (G01–G18,G20,G23) + the G24 umbrella before/after snapshot.
4. **Delta / panel / reachability** — D (mutation; reset between stateful specs), P (panel diff),
   R (reachability), C (code handlers, incl. hijack/captured on a FRESH session).
5. **Cross-tool** — X live rows (capture `click_surface` + coir `find`/`deps` → `_xtool-join.mjs`),
   the cross-tool A/D/P/M rows, and the unreached→covered activation delta (X06).
6. **MCP / harness / CLI live** — M24–M30,M36–M43 (real `connect`/stdio), H03,H15,H21,H37 (real
   driver), L11–L15,L18–L37 (single-shot CLI + parity vs MCP).
7. **Teardown** — delete `assets/_copsetest/` and `scratchpad/_xtool-join.mjs`; real assets never touched.

Each id logs one row to **`RESULTS.md`** (verify-level, oracle value, observed, PASS/FAIL/FLAG);
X29 and C18 are expected **FLAG** rows (a pinned-behaviour probe and a documented release-build
limit, not pass/fail). The 388-candidate `_design_raw.json` is the audit backstop.