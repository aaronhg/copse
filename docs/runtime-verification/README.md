# copse runtime primitives — live verification record

This directory is a **durable, reproducible record** of verifying every copse runtime
primitive against a **real, running Cocos Creator 3.8.6 game** (the dev preview the editor
serves), **not copse reading back its own snapshot** — which would be circular. It exists so
the runtime surface (`snapshot` / `press` / `get` / `call` / `reachable` / `node` / `diff` /
`listeners` / `hijack` / `captured` / `logs` / `emitTouch`, plus the `coverageJoin` bridge and
the `runHarness` gates) can be re-validated later by re-running the same plan.

## Why independent ground truth

copse is a runtime UI driver: it walks `cc.director.getScene()`, invokes handlers, and reads
component state back. If a spec's only check were *"copse said X, then copse still says X"*, it
would prove nothing but copse's internal consistency — the cardinal sin this record exists to
avoid. Every spec therefore pins copse's output to an **independent oracle**.

The oracles come from the **3-MCP rig** — three independent views of **one** scene:

| View | MCP | Role here |
|---|---|---|
| **copse** (runtime) | `mcp__copse__*` | the **system under test** — drives the live node tree |
| **cocos-creator** (editor) | `mcp__cocos-creator__*` | oracle for **authored** values + editor geometry/hierarchy (HTTP `:3000`, preview `:7456`) |
| **coir** (static) | `mcp__coir__*` | oracle for the **static** node/ClickEvent graph read from the `.scene`/`.prefab` bytes |
| **fixture logic** | `assets/_copsetest/Copse*.ts` | oracle for **predicted deltas** — synchronous, deterministic controller methods |

copse is cross-checked by the *other* two tools and by the fixture's own deterministic logic —
never by itself.

## Environment

| | |
|---|---|
| Project | `<home>/Documents/repo/NewProject_386` (Cocos Creator **3.8.6**) |
| System under test | copse at `<home>/Documents/repo/copse` |
| Editor bridge | `cocos-creator` MCP — editor open + preview server started (`:3000` / `:7456`) |
| Static bridge | `coir` MCP on the same project (`mcp__coir__*`) |
| copse bridge | `mcp__copse__*` — `connect{url:'http://localhost:7456/'}` then `reload` |
| Pure / in-process | `node` only — `localDriver` + fake `Runtime` for structural-invariant specs (no engine, no LLM) |

## Fixtures (synthetic, isolated — real assets are never touched)

All fixtures live under a single de-identified namespace, **`NewProject_386/assets/_copsetest/`**,
authored **fresh** via the `cocos-creator` MCP and **deleted at the end**
(`project_delete_asset db://assets/_copsetest`). No real project asset is read or written.

> **Public-repo de-identification rule.** copse is a public repo. Fixtures carry **no** game,
> operator, or host identifiers — only synthetic `Copse*` names (`CopseTest`, `CopseCtrl`,
> `AddBtn`, …). Anything that lands in this record is scrubbed of real-game content.

| Fixture | Purpose |
|---|---|
| `_copsetest/CopseTest.scene` | the master fixture exercising every lens: READ/GET/DELTA nodes, same-name siblings + `Slot[0]` literal, clickEvent-wired DELTA buttons, code-registered buttons, a panel (active toggle), the reachability roster (covered / occluded / opacity / scale / closed / stacked), and a prefab mount for the cross-tool join |
| `_copsetest/CopseTestB.scene` | minimal companion (`OtherBtn` / `OtherLabel`) — the reload scene-switch spec: opening it makes the preview serve it, so `reload` must pick up `OtherBtn` and drop `AddBtn` |
| `_copsetest/CopseCtrl.ts` | the deterministic controller/counter/panel/throw oracle (`add`/`reset`/`open`/`close`/`boom`/`swallow`, Label writes **inside** methods so the editor edit-mode instance replays identically) |
| `_copsetest/CopseClick.ts` | code-registered `on('click')` oracle (C/D lens) |
| `_copsetest/CopseTouch.ts` | raw `TOUCH_END` oracle for `emitTouch` |
| `_copsetest/CopseMulti.ts` | two distinct code handlers on one node (`listeners()` + `press` droveClick short-circuit) |
| `_copsetest/CopseMask.ts` + `CopseEngineEvt.ts` | code-on-non-button + the engine-event filter (must return `[]`) |
| `_copsetest/CopseLazyWire.ts` | post-`hijack` registration oracle (the "only registrations AFTER hijack" temporal boundary) |
| `_copsetest/CopseRow.prefab` | prefab whose internal `Btn` drives the prefix-covered / ambiguous `coverageJoin` cases + `resolve('CopseRow/Btn')` |
| `scratchpad/harn_fixture.mjs` (FAKE) | in-process `localDriver(fixture(), fakeRuntime())` for structural-invariant harness / core specs — deleted after the run |
| `scratchpad/_xtool-join.mjs` (FAKE) | throwaway runner for the library `coverageJoin`/`resolveCoirPath`/`resolveCopseRef` (not MCP tools) — deleted after the run |

copse refs are scene-root-relative (`Canvas/…`); coir prepends the scene/prefab-file head
(`CopseTest/…`) which the join **drops** — that two-rooting is itself one of the things verified.

## Verification strategies

Every spec is tagged with the level it verifies and the **oracle** that makes it non-circular:

- **authored-readback** — copse reads a value **authored via the cocos-creator MCP**
  (`Label.string`, a component field, `node.active`) → assert `==`. Oracle: the **editor**
  (what was authored, read back independently of copse).
- **delta** — copse `press`/`call` mutates; copse reads the **predicted logical delta** → assert
  `==` the prediction. Oracle: the **fixture's deterministic logic** (`CopseCtrl`'s synchronous
  methods, replayable in the editor edit-mode instance via `execute_component_method`).
- **cross-tool** — copse's view agrees with **coir** (static `.scene` bytes) and/or with the
  **cocos-creator** editor readback on the same scene (e.g. `clickSurface` × coir's ClickEvent
  map through `coverageJoin`; refs / siblings / prefab mounts). Oracle: the **other** tool.
- **structural-invariant** — shape/contract assertions with **no external oracle** (e.g. a gate
  fires, a result shape, an unsupported selector throws). These are **labeled as such** so they
  are never mistaken for ground-truth confirmation.

## Files

- `PLAN.md` — the full ordered test matrix (primitive × lens), each row tagged with its verify
  level + oracle.
- `RESULTS.md` — per-test execution log: the copse call, the oracle readback, the assertion,
  PASS/FAIL, raw output.
- `COVERAGE.md` — adversarial audit of coverage gaps / circular or weak verifications.
- `_design_raw.json` — the raw fixture/spec design (roster, author steps) the plan was generated
  from.

## Reproduce

1. Open `NewProject_386` in Cocos Creator **3.8.6**; start the `cocos-creator` MCP (`:3000`) and
   the preview server (`:7456`). Have the `coir` MCP available on the same project.
2. Author the fixtures: create the `Copse*.ts` scripts (`project_create_asset` →
   `project_refresh_assets` so the classes register), then build `CopseTest.scene` /
   `CopseTestB.scene` / `CopseRow.prefab` per `_design_raw.json` (nodes, components, clickEvents,
   `@property` refs, sibling order, prefab instances).
3. `scene_open_scene CopseTest`; `project_start_preview_server`; `mcp__copse__connect
   {url:'http://localhost:7456/'}`; `mcp__copse__reload`.
4. Walk `PLAN.md` top to bottom, recording into `RESULTS.md`; for each spec read the named
   oracle (editor / coir / fixture logic) and assert against it.
5. For the structural-invariant rows, run the in-process fakes (`node scratchpad/harn_fixture.mjs`
   driver specs, `node scratchpad/_xtool-join.mjs`).
6. Delete the fixtures: `project_delete_asset db://assets/_copsetest`; remove the scratchpad
   runners.
