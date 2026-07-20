# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repo.

## What this is

**copse** drives and asserts a **running Cocos Creator canvas game** through its
**live node tree** — *no pixels, no input simulation*. It walks the live scene
(`cc.director.getScene()`), finds the buttons / registered events, and **calls their
handlers directly** (serialized `clickEvents` via `EventHandler.emit` + an emitted
`CLICK` for code-registered listeners), then reads component state back to assert.
In effect it's **integration/flow testing of the game's logic layer through the live
object graph** — fast, deterministic, no GPU.

It is the **runtime sibling to [coir](https://github.com/aaronhg/coir)** (at
`../coir`): coir reads a project's *static* asset/dependency graph; copse reads the
*running* scene's live UI tree. Both turn an opaque Cocos internal into structured
data an AI (or a test) can query, and **both speak the same selector grammar**
(`Parent/Child:Comp.prop`, `[i]` to disambiguate same-name siblings). The originating
idea is an internal design note (the "make AI see into the canvas" plan,
inspired by gstack's `/qa`); copse is the **runtime-pure-logic** route from it.

Positioning vs generic CDP tooling: copse is the **Cocos scene layer over a CDP
connection**, not a browser-automation harness. Generic browser control (navigate /
screenshot / network / perf / DOM input) is commodity — the official `chrome-devtools-mcp`
covers it, and to every such DOM-level tool the game stays one opaque `<canvas>`. The
recommended shape is **both MCP servers sharing one Chrome** (`--remote-debugging-port=9222`):
chrome-devtools-mcp navigates / passes gates / screenshots; copse **attaches** to the same
tab (`connect({attach:true, browserURL})` — no `match` → the ACTIVE tab) and drives the
scene. copse's own launch mode is the standalone fallback. See `docs/MCP.md`.

## Status

**Working tool**, verified end-to-end on a **dev/preview build** (the editor-preview rig in
`docs/runtime-verification/`):

- **Live verification**: snapshot / `press → get` round-trips through real handler logic (a
  state-delta mutation read back off a component), reachability flagging a covered button
  (`blockedBy`), and panel open/close via `changed`.
- **Executor** (`execute`): runs a step list on a running game and reports the FACTS
  (`unreachable`/`errored`/`undriven`/`uncertain`/`visual`) — no agent, no loop, no verdict.
  The plan→execute→judge LOOP + verdict moved to the sibling **arbor**, which drives `execute`.
- **MCP** (`copse mcp`): the bridge as MCP tools; verified driving a running game **natively
  from Claude Code** (open → dismiss → press → panel via `changed.appeared` → press
  close → `changed.disappeared`), no browser-use, adaptive (waited for a toggle to enable).
- **CI**: 219 `node:test` cases green over fakes (`npm test`), plus an L2 tier that needs a real engine /
  a real Chrome and self-skips without one (`npm run test:l2` — 12 cases: the driver's reconnect contract
  against a live Chrome, and the 3.8.6 listener-table parse). `npm run typecheck` clean, `npm run build` → three
  self-contained IIFEs (each auto-installs `window.__copse` once `cc` is live): `dist/copse.inject.js`
  (full — the QA/coverage surface), `dist/copse.inject.lite.js` (lite — snapshot/press/get/call/node/diff,
  reachability tree-shaken out; ~half the size, for a `press`-only caller like mast), and
  `dist/copse.inject.probe.js` (probe — read+drive: reachability/`find`/`assets`/`press`, no
  snapshot-extras/get/call/diff; for a load-metrics driver like mast's extension).

## Commands

```bash
npm test           # node:test over FAKE trees (no engine, no install, no browser) — EXCLUDES test/*.l2.test.js
npm run test:l2    # L2 only — the tests that need a REAL engine / a real Chrome (slow; self-skip when absent)
npm run test:all   # everything, L1 + L2
npm run typecheck  # tsc --noEmit (JSDoc); needs `npm install` for the dev deps only
npm run build      # build:full + :lite + :probe + :pixi → dist/copse.inject{,.lite,.probe,.pixi}.js (IIFEs, gitignored)
```

Run it: `copse scan <url>` / `copse mcp [url]` / single-shot
`copse get|press|call|node|reachable <url> <sel>` / `copse run <url> <script.json>`
(deterministic script replay → exit 0/1, `docs/SCRIPTS.md`)
(the CLI is `src/cli.js`, runs directly; only `dist/copse.inject{,.lite,.probe}.js` are ever built). MCP: `claude mcp add copse -- node <abs>/src/cli.js mcp`
or a project `.mcp.json` — then any MCP client (Claude Code / browser-use) drives the canvas (see `docs/MCP.md`).

There is **no runtime install** — copse is zero-dep (esbuild is a dev-only dep). To run
against a real game you inject the bundle into the running page (console paste /
Playwright `addInitScript` / dev-build hook — see `docs/INJECT.md`). `npm run build`
produces `dist/copse.inject.js` (full), `dist/copse.inject.lite.js` (lite — press-only, no
reachability), and `dist/copse.inject.probe.js` (probe — read+drive metrics surface): paste one /
`addInitScript` it and it exposes
`globalThis.copse` and auto-installs `window.__copse` once `cc` is reachable (it polls
~10s for the engine to boot, since `addInitScript` runs pre-boot). The PoC driver was a
**throwaway** in
`/tmp` that borrowed Playwright from another project + system Chrome (headed) — keep
such drivers OUT of this repo so it stays zero-dep.

## Architecture

The one load-bearing decision mirrors coir's `FileProvider`: **the logic is decoupled
from the engine through a minimal `Runtime` adapter**, so the pure core is testable in
Node against plain-object trees.

**Boundary (the `coir` · `copse` · `arbor` family).** Three tools, one rule:
**needs project files → coir** (static analyzer) · **needs a running game → copse** (this repo) ·
**has judgment/policy → arbor** (the AI-QA framework).

copse OWNS the **deterministic runtime driver**: the primitives (`snapshot`/`press`/`get`/`call`/
`reachable`/…), `clickSurface` (the runtime click surface — the copse half of the coir join), `execute`
(run a step list → report FACTS), `run` (frozen-script replay → exit code), and the MCP server.
**No LLM, no loop, no verdict.** copse does NOT read project files (→ **coir**), and does NOT decide
*what to test* or *whether it passed* — the plan→execute→judge LOOP, the pass/fail verdict + veto, the
coir×copse coverage JOIN (`coverageJoin`), test selection (`affected`), and capability branching all live
in **arbor**, which *drives* copse's `execute`. copse only drives a live game and reports facts.

Layout (grouped by concern; `src/index.js` is the public barrel):

- `src/core/index.js` — **pure core**, engine-free. `snapshot` / `clickSurface` / `resolve` /
  `press` / `get` / `call` / `reachable` / `node` / `diff`, all over a `Runtime` adapter (the
  `@typedef` at the top is the whole contract). Addressing: `Parent/Child` paths relative
  to the scene root, `[i]` for same-name siblings, `path:Comp.member` (or `path:Node.prop`)
  for a member. `#N` absolute indices are intentionally unsupported (no stable index). The full
  grammar copse implements (a subset of coir's) + divergences are in `docs/SELECTORS.md`, pinned
  by `test/selectors.test.js`.
- `src/core/bridge.js` — the **engine-neutral half of the in-page `__copse` surface**, hoisted out of
  `install()` so a second engine layer reuses ONE implementation instead of forking it (`docs/ENGINES.md`).
  `makeBridge({rt, root, target, engine})` returns the whole API — read+drive (`snapshot`/`press`/`get`/`call`/…),
  `watch`, `patch`/`patch_clear`/`patch_calls`, `hold`/`release`, `orient`, and the `pm*`/`pm.*` framework
  surface. The `engine` **port** is the only engine-aware seam: `freeze`/`unfreeze`/`canFreeze` (hold),
  `visualManifest` (node→screen px), `probe` (coupling self-diagnostic), `version`. The engine layer's
  `install()` supplies those four and assigns the result to `target.__copse`.
- `src/core/framework.js` + `src/core/eval-cond.js` — engine-free helpers (they live in `core/` because
  `bridge.js` needs them and core must never import from an engine dir). `framework.js` is the generic
  framework-adapter engine (pure over a `win` + adapters array); `eval-cond.js` is the shared
  `safeVal`/`safeBool`/`parseDur`/`jsonSafe` used by both `watch`'s `until:` and the probe bundle's `--until`.
- `src/coverage.js` — the **pure** coir↔copse ref-matching layer: `tailMatch(staticPath, runtimeRef)`
  (the shared vocabulary — now a **PUBLIC** export via the barrel) + the interop adapters
  `resolveCoirPath`/`resolveCopseRef` that translate a coir STATIC nodePath ↔ a copse RUNTIME `ref`
  against a live view (a `clickSurface`/`snapshot` result). Two-tier match: exact + **symmetric tail**
  (shorter path is a segment-suffix of the longer, `[i]` fuzzy) — absorbs the two rootings: coir's
  scene/prefab-file root (`dropped`) and a prefab's instantiation `mount`; >1 tail candidate → ambiguous.
  These stay in copse because they resolve against a live tree. The coverage JOIN itself (`coverageJoin` —
  the bucketing/verdict) + `affected` (test selection) **moved to arbor** — pure control-layer
  reconciliation, needing neither files nor a live game. `clickSurface` (core) still produces copse's
  runtime side. See `docs/COVERAGE.md`.
- `src/capabilities.js` — **NEW**: `engineCapabilities(engine)` → the per-engine capability profile
  `{engine, clickSurface, stableRefs, reachability, visualManifest}`, so a consumer (arbor, or any
  harness) BRANCHES on facts instead of silently assuming Cocos (`clickSurface`/`stableRefs` are
  Cocos-only; `reachability`/`visualManifest` are on both engines; `engine:null` zeroes everything).
  Exported from the barrel; the driver's `.capabilities` getter returns it for the resolved engine.
- `src/pixi/` — the **PixiJS 8 engine layer** (the second engine; `docs/ENGINES.md` is the rationale and
  the measured evidence). Same shape as `src/cocos/`: a `Runtime` + the engine port, everything else shared
  from `src/core/bridge.js`. Verified end-to-end against a MINIFIED production build of `pixijs/open-games`.
  - `pixitype.js` — node identity. `constructor.name` is mangled in prod AND polluted in dev (Vite renames
    Pixi's own classes), and `label` is a DECOY (Pixi's constructors set `label:"Sprite"`/`"Graphics"`
    themselves), so type comes from `renderPipeId` duck-typing and a name is `gameLabel(n) ?? pixiType(n)`.
  - `anchors.js` — the semantic skeleton. Pixi has no components, so addressing anchors on the game's own
    screen classes (`show`/`hide`/`resize`, the measured stable intersection) and then uses THEIR named
    fields (`_game`, `match3`, `pauseButton`) — minify-proof, unlike any path. Holds the three
    silent-failure traps (Pixi-surface subtraction, instance fields, back-reference cycles).
  - `reachable.js` — `hitTest` IS the oracle, so this is ~60 lines vs Cocos's ~230 z-order replay. Primes
    `rootBoundary.rootTarget` first: `hitTest` THROWS cold, which nothing documents.
  - `press.js` — real DOM PointerEvents at the canvas (all three phases, same pointerId,
    `pointerType:'mouse'` — each measured, each load-bearing). ASYNC. Inherently reachability-gated,
    the opposite of Cocos's default; `force:true` falls back to `emit` and says so (`drove:'emit-unsafe'`).
  - `visual.js` / `probe.js` / `runtime.js` (`pixiRuntime`/`install`/`findPixi`/`installInitHook`) /
    `inject.js` (the build entry — arms `__PIXI_APP_INIT__` FIRST, since that only works pre-boot).
  - `geom.js` — the Pixi counterpart of `cocos/geom.js`: `boundsRectOf` (v8 returns `Bounds`, earlier
    versions a `Rectangle` — normalized once, and it hands back the RAW rect because callers legitimately
    differ: `reachable` needs `> 0` to aim a click, `visual` accepts a collapsed rect), `visibleChain`
    (the ancestor `visible` walk = Cocos's `activeInHierarchy`; ignores alpha by design) and `visibleOf`
    (+ alpha/scale === 0, the perceptual signal). The duplication here was cheap but its consequence
    wasn't: `visualManifest` reported `visible` from the node ALONE while `reachable` reported the same
    field from an ancestor-aware walk, so a node under a hidden parent came back `true` from one and
    `false` from the other — and Cocos agreed with neither. One definition each; pinned in `test/pixi.test.js`.
- `src/cocos/` — the **engine-coupled** layer (the only place that touches `cc.*`):
  - `runtime.js` — the `Runtime` adapter over ONE shared `baseRuntime(cc)` (`press`/`get`/`call` driving +
    `codeHandlers` via `_eventProcessor` + `nodeInfo` intrinsics), in two shapes: `cocosRuntime(cc)` =
    base **+ `reachable`**, `cocosRuntimeLite(cc)` = base ONLY. Plus `findCC()` (walk same-origin
    (i)frames → the game's `cc`), `startLogCapture()` (patch `console.*` + errors), and the two installers:
    `install(cc)` — now a **thin wrapper**: it builds the runtime + the four-member ENGINE PORT
    (`freeze`/`unfreeze`/`canFreeze` over `cc.game.pause`→`cc.director.pause`, `visualManifest`, `probe`,
    `ENGINE_VERSION`) and hands them to `makeBridge` (`src/core/bridge.js`), which supplies the whole
    `window.__copse` surface — `installLite(cc)` (minimal: `snapshot`/`press`/`get`/`call`/`node`/`diff`/`listeners`),
    and `installProbe(cc)` (read+drive metrics surface: `probe`/`firstClickable`/`find`/`interactive`/`reachable`/`press`
    + `assetsPending` — keeps reachability, drops snapshot-extras/get/call/diff/logs; for a load-metrics driver).
    All verified on a dev/preview build.
  - `reachable.js` — `makeReachable(cc)`, the geometric `reachable` signal (`UITransform.hitTest` +
    **cross-camera/Layer z-order** (camera priority → sibling-index) + a separate `visible` signal
    (`opacity/scale===0`, never folded into the reachable boolean) + `occludedBy`), split out so it's
    **imported only by the full `cocosRuntime`** → esbuild tree-shakes it out of the lite bundle. Self-contained
    (re-resolves the cc classes it needs), so it could later be built into a standalone injectable snippet.
    Exercised in CI by `test/reachable.test.js` over a geometric fake `cc`.
  - `geom.js` — the primitives more than one Cocos layer needs the SAME answer from: `collectCameras`
    (class-NAME-string fallback, so a tree-shaken build doesn't find zero cameras), `camOf` (node → its
    rendering camera: layer/visibility mask, highest priority), `visibleOf` (opacity/scale collapse up the
    chain) and `synthTap` (the synthetic two-phase touch). Each of these had 2–4 copies kept "in lockstep"
    by hand — and they had already drifted: the two synthetic-touch paths projected through DIFFERENT
    cameras (`cams[0]` vs `cams[cams.length - 1]`), so at most one was right. `synthTap` now takes the
    camera from `camOf` and differs only by `endType` — `'end'` actuates (a Button's handler runs),
    `'cancel'` only lets the node observe a touch (reachable's opt-in probe; no click). Dependency-free
    on purpose: the base/probe bundles pull it in. Pinned by `test/geom.test.js` (the touch path had NO
    test before — core.test.js stubs `emitTouch`, which is how the drift went unnoticed).
  - `inject.js` — the **full build entry** (not public API): re-exports the in-page surface on
    `globalThis.copse` + auto-installs the full `window.__copse` via `install`. esbuild → `dist/copse.inject.js`.
  - `inject-lite.js` — the **lite build entry**: the minimal surface + auto-install via `installLite`.
    Because it never references `makeReachable`/`install`, esbuild drops reachable.js → `dist/copse.inject.lite.js`
    (~half the size, smaller injected surface). `__copse.press`/`get`/`call` are byte-identical to full's.
    Consumed by mast's `press:` stages (`copse/inject-lite` export, full `./inject` as fallback).
  - `inject-probe.js` — the **probe build entry**: `installProbe`'s read+drive metrics surface
    (`probe`/`firstClickable`/`find`/`reachable`/`press` + `assetsPending`). Keeps reachable.js but drops
    snapshot-extras/get/call/diff/logs → `dist/copse.inject.probe.js` (`copse/inject-probe` export). Consumed by
    mast's **extension** to time a Cocos game's load (first-interactive / assets-idle) and drive past the intro.
- `src/harness.js` — the **deterministic flow executor** (`execute`/`extractFacts`/`localDriver`),
  decoupled like the core: over a `Driver` adapter (`localDriver(root, rt)` builds one over an
  in-process tree). `execute(driver, steps, opts?)` runs a step list and returns `{ steps, facts }` —
  per-step results + the five FACT buckets `extractFacts` derives (`unreachable`/`errored`/`undriven`/
  `uncertain`/`visual`). **NO agent, NO loop, NO pass/fail verdict** — a covered-button press, a
  handler that threw, a press that drove nothing are reported as FACTS; whether any of them fails a
  run is the consumer's call. `reachableGate`/`visualGate` only toggle whether those facts are
  gathered (not a verdict). No engine/LLM dep. The plan→execute→judge LOOP + the verdict/veto + the
  `claude -p` agent moved to the sibling **arbor** (its `runLoop`) — copse stays deterministic; arbor
  drives `execute`. Exported from the barrel + `copse/harness`. Interactive exploration belongs to
  Claude Code over MCP; known-flow regression belongs to `src/script.js`.
- `src/script.js` — **pure deterministic script runner** (`runScript` + `subsetMatch`): replays a
  FROZEN flow (JSON steps + subset-match `expect`s, `docs/SCRIPTS.md`) over the same `Driver`
  adapter — the zero-LLM regression half. Step = the harness `Step` shape (+`expr`/`ms`/`since`) +
  `expect`/`allowErrors`; subset match = primitives `===`, objects by key, arrays CONTAINS. No
  `expect` → `ok !== false`; fact gates mirror the harness (`errors` fails unless
  allowErrors/asserted; press `drove:'nothing'` fails unless asserted — an explicit expect
  overrides its gate). Stops at the first fail (`continueOnFail` runs all); empty steps →
  `pass:false`; per-step `{step, ok, ms, mismatch?/gate?, result?}`.
- `src/drivers/puppeteer.js` — **optional** driver (`copse/driver-puppeteer`): `connect(url)`
  launches system Chrome (puppeteer-core peerDep), injects the bundle → a `Driver` (the shape `execute` consumes).
  **`connect({engine:'pixi'})`** drives PixiJS 8 instead (`docs/ENGINES.md`): it picks
  `dist/copse.inject.pixi.js` and injects it via `evaluateOnNewDocument` **before** `goto` — Pixi's
  `__PIXI_APP_INIT__` hook fires once during `Application.init`, so a post-load evaluate misses it
  entirely (that ordering is the whole reason the option must be set at connect time). The same
  registration survives navigation, so `reload()`/auto-reconnect re-arm for free; attach mode can't
  pre-inject and falls back to a direct evaluate + `findPixi`. On pixi, `clickSurface`
  REFUSEs with an explanation (§5 — an empty join would read as "nothing is wired"), `anchors()`
  replaces it, and `cp.engine`/`cp.capabilities` are surfaced so callers branch without sniffing the page.
  **`engine:'auto'`** resolves by probing the live page (pre-injecting the Pixi bundle as cheap
  insurance, since the hook must be armed before detection is possible). `copse doctor` DEFAULTS to
  auto — it's the "why won't it even run" command, so requiring you to already know the engine would
  defeat it; it reports `engine` (null when nothing identified itself), `injected`, and what it looked
  for. A page with no engine FAILS the boot (`[recoverable] no-engine`) rather than handing back a
  half-session: a boot that returned left `frame` on `page.mainFrame()` — live, no game, never
  "detached" — so recovery never re-fired and the session stayed broken even after the game came back.
  Attach mode (`{attach:true, browserURL, match?}`) drives an already-open tab; **no `match`/url →
  the ACTIVE tab** (visibilityState/hasFocus/title probes — each race-bounded so a paused tab can't hang the
  scan, and run in PARALLEL so N tabs cost one probe window, not N — a paused game must be attached via `match`).
  **Waits are budgeted, and every one of them fails LOUD rather than long** (DEVELOPMENT.md §25F
  has the measured before/after): a session survives the tab reloading under it — the frame detaches, `ev`
  re-finds the engine + re-injects (~6ms on a healthy F5) — and a boot that FAILS is recoverable, not terminal
  (`bootTries` 40s cold vs `rebootTries` 15s after a navigation, then a 2s fail-fast cooldown that the next
  navigation cancels, so a reload landing mid-rebuild self-heals on the op after the build finishes instead of
  wedging the session forever). `readyTimeout` (5s) bounds a call's wait on unfinished init and names the phase
  it's stuck in (`phase=finding-engine, 6.0s elapsed`) — init keeps running, so retrying is the fix. `opTimeout`
  (60s) caps ANY in-page call so a renderer that wedges AFTER connect can't hang one forever (`eval` may pass its
  own `{timeout}`). Errors carry a machine-readable class — `{recoverable, code}`, one definition in
  `errClass` (script.js) — so a caller branches on the fact instead of pattern-matching prose. Re-injection
  wipes the caller's in-page `patch`/`hold` hooks: it warns into `cp.logs()` and counts in `cp.reinjects`.
  `cp.reload()` (factored `bootInPage`, routed through the same deduped reboot)
  re-navigates the tab + re-injects — picks up the editor's CURRENT
  scene after `scene_open_scene`, and recovers a wedged/empty preview (attach-found-`getScene()===null`).
  Browser-glue, so deliberately not `@ts-check`ed.
- `src/debug.js` — **optional** edge (`copse/debug`): `attachDebugger(cp.page)` → breakpoints + call
  stack over the CDP **Debugger** domain. iframe-aware (attaches to page + iframe/OOPIF targets; resolves
  across all contexts). `breakAt(urlRegex,line)` + `breakIn('path:Comp.method')`
  (resolves the method via `window.__copse` → break on call; works minified), `breakOnExceptions`,
  `waitPause`→callstack, `evalFrame`, `step`/`resume`. Exposed as MCP tools `break_*`/`wait_pause`/
  `eval_frame`/`debug_step`. For your OWN dev build (pausing the runtime is intrusive). Browser-glue, not `@ts-check`ed.
- `src/mcp/` — **optional** MCP edge (`copse/mcp`, subcommand `copse mcp`): exposes the bridge as
  MCP tools so ANY MCP client (Claude Code / browser-use / Stagehand / a plain tool-use loop) drives
  the canvas. `server.js` = hand-rolled JSON-RPC-over-stdio (mirrors coir's `mcp/server.js`: stderr-only
  logging, serialized handler, `createDispatcher(state)` exported for tests; gates debug-tagged tools
  out of `tools/list` when `state.debug` is falsy, and GROUPS the advertised list by `FAMILY` with one ★
  `HEADLINE` per family — each description prefixed `[family ★]`/`[family]` so the flat surface reads as a
  guided map (signposting, not gating; families: session/see/read/drive/usable/observe/fix/coverage/script/orient/escape,
  `eval` alone in `escape` — the raw hatch, no ★); `tools.js` = the tool registry — 41 testing primitives
  (`connect`/`list_tabs`/`reload`/`snapshot`/`interactive`/`click_surface`/`resolve`/`press`/`get`/`call`/`eval`/`reachable`/`node`/`diff`/
  `listeners`/`orient`/`probe`/`logs`/`watch`/`hold`/`release`/`hold_status`/`patch`/`patch_clear`/`patch_calls`/`framework`/`register_framework`/`pm_get`/`pm_set`/`pm_call`/`pm_patch`/`pm_trace`/`pm_notify`/`network`/`screenshot`/`visual_check`/`visual_baseline`/`run_script`/`dump_script`/`close`)
  + 7 `debug:true`-tagged Debugger tools (`break_*`/`wait_pause`/
  `eval_frame`/`debug_step`/`clear_breakpoints`, family `debug`), **hidden from `tools/list` by default**
  (dev-build-only — pausing the runtime is intrusive; `copse mcp --debug` surfaces them, still callable by
  name regardless) — over a live
  `connect()` session (the MCP tool names match the library 1:1, incl. `connect`). `record:true`-tagged
  tools (press/get/call/node/reachable/eval/snapshot/interactive) are wrapped at the bottom of tools.js to
  push `{…step, observed}` onto `state.history` on success — `dump_script` exports that recording as a
  script skeleton (`docs/SCRIPTS.md`); `connect` resets it. The valuable part of copse is this bridge; the
  plan→judge loop sits above it (arbor's layer).
- `src/cli.js` — the **CLI** (registered as `copse`; runs directly, no build): `copse scan <url>`
  / `copse mcp [url]` / single-shot `copse get|press|call|node|reachable <url> <sel>` (connect → one
  primitive → JSON → close, for shell/jq) / `copse run <url> <script.json>` (deterministic script
  replay → exit 0/1) / `--version`. Thin wrapper over `connect` + the primitives + `runScript`;
  heavy/optional bits (puppeteer driver, MCP server) are **lazy-imported** per command so
  `copse --help` / `copse mcp` don't require puppeteer-core. (The AI-driver loop is NOT here — that's
  arbor's layer, built on copse's `execute`.) (Layout matches coir: no `bin/` dir.)
- `test/core.test.js` — `node:test` over a fake tree (the place to add core tests; incl. `clickSurface`).
- `test/selectors.test.js` — selector-grammar conformance: copse's `[i]`/member/divergence semantics +
  an interop corpus (coir-emitted paths must resolve in copse). Pins the contract in `docs/SELECTORS.md`.
- `test/coverage.test.js` — the coir↔copse selector resolvers (`resolveCoirPath`/`resolveCopseRef`) incl. the prefab-internal tail match + ambiguity (the `coverageJoin` buckets moved to arbor).
- `test/harness.test.js` — `execute` + `extractFacts` over a fake driver: step order, throw capture, and the five FACT buckets (no verdict, no agent).
- `test/script.test.js` — the script runner over a fake driver: subset/contains + mismatch paths,
  the default ok/errors/drove judgment, expect-overrides-gate, sleep, stop-on-fail vs continueOnFail.
- `test/mcp.test.js` — the MCP JSON-RPC dispatcher (`createDispatcher`) over a fake driver.
- `test/reachable.test.js` — `cocosRuntime(cc).reachable` over a geometric fake `cc` (the only place the engine-coupled reachable runs in CI).
- `test/pixi.test.js` — the Pixi layer over a fake Pixi tree. Pins what was MEASURED on a real minified
  build, because each of these regresses SILENTLY: decoy labels vs identity, a listener-less background
  not being a button, the three anchor traps, `alwaysIndex` ref stability, and refOf/snapshot ref agreement.
- `test/runtime-lite.test.js` — the base/lite split contract (lite omits `reachable`; `press` works over lite).
- `test/probe.test.js` — `probe(cc)` over a 3.8.6-shaped fake (which internals resolve; tree-shaken/no-scene degrade).
- `test/real-engine.l2.test.js` (+ `test/helpers/real-engine.js`) — **L2**: copse's reads against a REAL Cocos engine.
  esbuild-bundles the event source from `reference/cocos/<ver>` (gitignored local checkout; virtual/deep-leaf modules
  stubbed) → a real `CallbacksInvoker`, and asserts `codeHandlers` parses the real `_callbackTable`. SKIPS when no
  engine is checked out. Add a version: `git clone --depth 1 -b v3.8.6 https://github.com/cocos/cocos-engine reference/cocos/3.8.6`.
- `test/patch-trace.test.js` — the trace contract over a fake `cc` + a stubbed clock: one shared epoch
  (`t` comparable across patches armed at different moments) + one shared seq (`i`, on ENTRY → a nested callee sorts
  after its caller; sub-ms chains stay ordered), the merged `patch_calls()` read (+`dt`), epoch reset on clear-all only,
  shared `d` (unwinds even when the method throws), entry-time `label` (pins the MacroCommand-splice case), and
  `pm_trace` arming/roles-filter/unresolved over a fake framework. See docs/PM-TRACE.md.
- `test/driver-reconnect.l2.test.js` — **L2**: the puppeteer driver's auto-reconnect against a REAL Chrome (launches one;
  SKIPS without Chrome/puppeteer-core, so `npm test` stays green everywhere — but adds ~20s where it runs; `npm run test:l2`).
  Pins the two ways a session dies around a reload, both measured, neither what the field report originally blamed:
  a boot that fails mid-rebuild must not wedge the session FOREVER (bootInPage fell back to `page.mainFrame()` — live, no
  game, never "detached" → `isDetached` never fires again → no recovery even after the game is healthy), and `ev()` must
  BOUND its wait on `ready` (attach deliberately leaves it pending; a bare `await` made every call hang silently — 1953s
  in the reported session). A healthy F5 already self-heals in ~4ms; that's pinned too so a fix can't regress it.
- `docs/COVERAGE.md` — the **coir × copse** join recipe: `clickSurface`/`click_surface` emits copse's
  runtime click surface (`(ref, method)` rows); the JOIN itself (`coverageJoin` → buckets covered /
  blocked / unreached / ambiguous / code-only) now lives in **arbor**. copse keeps the interop resolvers
  (`resolveCoirPath`/`resolveCopseRef`).
- `docs/SELECTORS.md` — copse's selector grammar as a **subset of coir's** (canonical: coir/docs/EDITING.md §3):
  the shared core, copse's divergences (no `#N`/component-`[i]`/array-`[i]`, always index-parses `[i]`,
  minified comp names) + its `Node` pseudo-component. Pinned by `test/selectors.test.js`.
- `docs/ENGINES.md` — the **second-runtime verdict (Pixi 8)**: whether the `Runtime` seam holds for a
  non-Cocos engine, empirically verified against `pixijs/open-games` (pixi 8.14.1, dev + **minified prod**).
  Attach via the unconditional `__PIXI_APP_INIT__` core hook (zero game cooperation); `:Comp.member`
  transfers INTACT (minifiers spare property/method names — `…:Node.startPlaying()` works on a prod build)
  while name-based **paths** do not (`label` is a Pixi constructor default, `constructor.name` is mangled),
  so the Pixi lane is `find`-first; `press`+`reachable` FUSE (real DOM PointerEvents through the engine's
  own pipeline); `clickSurface` does NOT apply (no serialized handlers); `watch`/`diff` survive
  with no core change and should land first. Lists the two required core changes (bridge.js hoist,
  nested member paths) and the traps that fail silently. **Researched, not implemented.**
- `docs/MCP.md` — drive copse from any MCP client (Claude Code / browser-use); incl. **attach** mode
  for your own game behind a login/staging gate (attach to your own browser over CDP, no navigation).
- `docs/SCRIPTS.md` — test scripts: format + subset-match semantics + the
  explore→`dump_script`→trim→`run_script`/`copse run` workflow (freeze an explored flow into a
  deterministic replay; also freezes 1:1 from an `execute` run's step list).
- `docs/DEBUG.md` — `copse/debug` (CDP Debugger): breakpoints (incl. `break_in path:Comp.method`) +
  call stack / `eval_frame` / step, as MCP tools — for your own dev build.
- `docs/INJECT.md` — the three ways to inject + the AI test loop.
- `docs/PM-TRACE.md` — **`pm_trace`**: the runtime half of a command flow (coir `flow --time` is a static lower bound
  and says so; animation durations "stay a runtime question" — this answers it). Why the hook points are the framework's
  CLASS prototypes and not its registries (PureMVC captures the handler fn at registration → patching the registry object
  fires 0 times, measured), the row shape (`i` orders, `d` indents, `dt` is where the time went), the `label` extractor +
  why it runs on entry, the measured defaults, and the limits (minified notification names; subcommands nameable only via
  coir's `⊕ addSubCommand` — the intended join, keyed like docs/COVERAGE.md).
- `docs/AI-DRIVER.md` — copse's one AI-testing rail, `execute(driver, steps, opts?)`: runs a step
  list, reports the FACTS — no plan/loop/judge. The autonomous LOOP + verdict/veto live in **arbor**,
  which drives `execute`.

`window.__copse` API once installed:
```js
__copse.snapshot()                 // slim: [{ ref, active?(only false), button?, interactable?, click?, label?, codeHandlers? }] — name=ref tail; components OFF by default
__copse.snapshot({ relevant:true, components:true })  // relevant: only button|label|codeHandlers nodes (cuts noise); components: include raw type list
__copse.interactive()              // snapshot filtered to buttons, WITH reachable/blockedBy + visible:false (reachability:true)
__copse.clickSurface()             // join-ready: one row per editor-wired clickEvent [{ref, method, component?, interactable, reachable?...}] — key (ref,method) cross-refs coir's static map (docs/COVERAGE.md)
__copse.press('Canvas/ShopBtn')    // run clickEvents + emit CLICK → { ok, ref, fired }  (honors interactable; {force:true} to override)
__copse.get('Canvas/Score:Label.string')          // { ok, value }  — for assertions
__copse.call('Canvas/Mgr:ShopController.buy', 30)  // invoke ANY method on ANY component → { ok, value }
__copse.reachable('Canvas/ShopBtn')  // { ok, reachable:true|false|'unsure', reachableFraction, partial?, blockedBy, occludedBy?, visible, reason?, via:{consumer,camera} } — centre-primary z-order; via = which detection tier resolved it
__copse.node('Canvas/Panel')                      // node intrinsics → { active, activeInHierarchy, opacity, scale, worldPos, size }
__copse.get('Canvas/Panel:Node.active')           // read a single node intrinsic via the `Node` pseudo-component
__copse.diff(before, after)                       // → { appeared, disappeared, activated, deactivated (node descriptors w/ label/click), labelChanged }
__copse.listeners('Canvas/ShopBtn')               // user node.on() handlers (engine-internal + Button's own filtered out)
__copse.orient()                                  // one-call bearings → { scene, engine, framework:{kind,registered,capabilities}, buttons, entryPoints[] } (driver adds url + a next-step hint)
__copse.probe()                                   // engine-coupling self-diagnostic → { version, classes, reach, events, touch, framework } — which version-sensitive internals resolve on THIS build (drift → visible, not a silent 'unsure')

__copse.logs(sinceTs?)                            // captured console.* + uncaught errors → [{level,text,t,stack?}] (started on inject load)
__copse.watch({exprs?,selectors?,interval?,until?,timeout?,settle?})  // diff-only state TIMELINE over time → { timeline:[{t,dt,changes}], stoppedBy } (one in-page loop; replaces hand-written polling)
__copse.patch('Canvas/Mgr:Ctrl.setBet', {before?,after?,replace?,trace?})  // wrap a live method (JS fn-expr src) to verify a fix pre-rebuild; trace:true records calls → { ok, method, hooks }; patch_clear(sel?) restores, patch_calls(sel) reads trace
__copse.patch_calls()                             // NO sel → the MERGED timeline across every traced patch: { traced:[sels], calls:[{sel,i,t,dt,d,args,ret}] } — one shared epoch (t comparable) + one shared seq stamped on ENTRY (order by `i`, not `t`: a synchronous command chain runs inside a single ms)
__copse.pmTrace({roles?, traceMax?})              // arm the adapter's DISPATCH choke points in one call (no selector to guess) → { ok, armed:[{role,sel:'@role',at}], unresolved?, failed? }. See docs/PM-TRACE.md
__copse.hold('PanelMediator.toggle', {at?,pmMode?,holdMs?})  // arm a ONE-SHOT freeze of the engine loop at a trigger → the transient state is held (screenshot/inspect), then release(); { ok, armed } or { ok:false, reason:'no-freeze-api' }. hold_status() → { armed, held, sel, via, sinceMs }; release() resumes
__copse.registerFramework(adapterOrSrc)           // install a framework adapter for this session → { ok, kind, registered }  (core ships NONE)
__copse.framework()                               // detect via REGISTERED adapters + enumerate → { kind, proxies, mediators, commands, registered, capabilities:{proxy,mediator,command,notify} }  (capabilities = what resolved on THIS build)
__copse.pmGet('GameDataProxy.active')         // READ a proxy/mediator prop (get can't reach these) → { ok, value }
__copse.pmSet('GameDataProxy.mode', v)     // WRITE a proxy/mediator leaf (verified; write=actuation) → { ok, wrote[, landed if a setter transformed it] }
__copse.pmCall('PanelMediator.toggle', args)  // call a proxy/mediator method → { ok, value }
__copse.pmPatch('StartCommand.execute', {trace?})  // patch a proxy/mediator INSTANCE or a command CLASS prototype (patch_clear/patch_calls apply) → { ok, method, kind:'instance'|'command' }
__copse.pmNotify('StartFlow', body?, type?)   // fire a framework notification — the direct flow entry → { ok, via, value }
__copse.pm.get(sel) / pm.set(sel,v) / pm.call(sel,...args) / pm.notify(name,body?,type?) / pm.patch(sel,hooks)  // `pm.*` = a stable, eval-ergonomic namespace over the camelCase members above (the snake_case TOOL names like `pm_get` DON'T exist in-page → `__copse.pm_get` throws). pm.proxy('GameDataProxy') / pm.mediator('XxxViewMediator') hand back the RAW live object to poke.
```
**Framework-aware access is a PLUGIN, not core knowledge** (`src/core/framework.js` is a generic adapter
engine — no PureMVC baked in; not every game has a framework and those that do wire it differently). The
driver auto-loads adapters from `copse.frameworks.mjs` (this machine's, next to the package, **git-ignored**;
then a per-project one in cwd) + `connect({frameworks})` / `--framework <file>` / the `register_framework`
tool, and injects them so `framework`/`pm_state`/`pm_call`/`pm_patch`/`pm_notify` light up. An adapter is a
CONFIG object (`{kind, facade:[…locations], proxy:{via?,map?}, mediator, command:{map?,execute?}, notify:{via?}, trace:{role:{at,label?}}}`
— field-name CANDIDATE lists absorb per-game NAME differences) or a code-adapter source string (its own
`detect`/`retrieve`/`commandTarget`/`notify`/`traceTargets` for STRUCTURAL quirks the config can't express). `pm_patch` wraps a
proxy/mediator INSTANCE or a command CLASS prototype (transient commands); `pm_notify` fires a notification (the
direct flow entry); **`pm_trace`** arms the `trace` block's DISPATCH choke points — `at` is a dotted path from the
WINDOW to a class prototype, because a framework's registries are NOT where dispatch is observable (PureMVC's
View/Controller capture `mediator.handleNotification`/`this.executeCommand` as function VALUES at registration, so
patching what the registry hands you fires zero times — measured). `label` (a fn-expr src) extracts the readable
row; it runs on ENTRY, so it sees state the method destroys. See **[docs/PM-TRACE.md](docs/PM-TRACE.md)**.
Per-game variance is handled purely in `copse.frameworks.mjs` — core stays zero-assumption,
fails LOUD when a target can't resolve, and `framework().capabilities` reports what resolved on THIS build (like
`probe` for engine internals). See `copse.frameworks.example.mjs`.

(The driver adds two Node-side surfaces that don't need `cc`: `cp.network({grep,status,type,tail,since})`
— CDP-captured requests for "client action → server error code" bugs, also attachable via `press({captureNetwork:true})`;
and `cp.screenshot({selector?,path?})` — a PNG so the model can pair a logic state with the actual screen.
`cp.logs`/`cp.network` filter server-side (grep/level/tail) so a chatty game never blows the token budget;
`cp.eval` auto-wraps top-level `await`; and `cp.*` calls transparently re-inject after a page navigation.
Attach reports `paused` (renderer HALTED in the debugger → inject deferred) and `stalled`/`injecting`
(init not settled — usually a loading/intro screen with no buttons yet; `__copse` is typically already up)
as **separate** states, so a still-loading game is no longer mislabelled "paused in the debugger".)
Panel open/close ("press a panel button → its block opens") = snapshot `{includeInactive:true}`
→ act → snapshot → `diff`: the panel's subtree shows up in `activated`/`appeared`. Verified
on a dev/preview build: pressing a menu toggle put its menu subtree (21 nodes) in `diff.activated`,
and `reachable` correctly flags a button as `blockedBy:"…/mask"` once a panel opens. Caveats below.

## Capability boundary (be honest in docs/replies)

**Can test ✅** (functional/logic): UI flows + state machines, numeric/data correctness
(read component fields), UI binding (Label/sprite after an action), button enable
logic, node presence/absence, **panel open/close & visibility transitions** (`node()`
intrinsics + `diff()` of before/after snapshots → which subtree activated/appeared),
doesn't-crash, idempotency/races, logical-state regression. Because you hold the live
component reference, `call` drives *any* method — a general "drive the logical API +
assert state" harness, not just buttons.

**Best-effort now (was the headline caveat) ⚠️**: **reachability** — calling the handler
≠ a player reaching the button. `reachable(ref)` / `interactive()` flag a button covered by an
overlay / `BlockInputEvents` / a later-drawn panel (`blockedBy`) by **replaying the engine's input
z-order** over the live tree (Rung 2+3): the consumer set comes from a version-adaptive ladder (the
engine's own `shouldHandleEventTouch` → a user touch/click listener → `Button`/`BlockInputEvents`, so a
raw `node.on(TOUCH_*)` scrim now blocks too — not just `cc.Button`s), ordered by **[render-camera
priority, …sibling-index]** (resolves cross-camera/Layer z-order), sampled at **multiple points** across
the button's own rect — the **centre decides** (tappable point): centre free → `reachable:true` (a covered
corner only flags `partial:true` + a `reachableFraction`); centre covered → `reachable:false` (names
`blockedBy`); centre miss → `'unsure'`. (Centre-primary, NOT all-points: a button packed among neighbours
whose bbox corners overlap them isn't a false `'unsure'`.) `via:{consumer,camera}` records which tier
resolved it (cross-version provenance); caps
are **feature-probed, never version-branched**, and degrade to a public-API floor or fail **loud**
(`'unsure'` + a `reason`). Still: no alpha hit-areas, no `preventSwallow`/event-penetration, single-frame;
and — key boundary — `reachable` answers "would a **touch** reach it" (input ignores opacity), so a button
**visually** covered by an opaque sprite (no input-consumer on top) reads `reachable:true`. A separate
**`visible`** field (`opacity/scale!==0`) catches opacity/scale toggles, and **`occludedBy`** flags an
opaque renderer drawn on top (best-effort, bbox, no pixels) — combine `reachable && visible`. Treat
`reachable:false`/`'unsure'` as a strong signal to verify, not gospel.

**Code-registered handlers ⚠️**: `codeHandlers`/`listeners` surface `node.on()` listeners
(via `_eventProcessor`), but filtering only drops engine-internal events + cc.Button's own
touch listeners — a project's custom button base-class still shows as touch-* noise, and
minification strips fn/target *names* (you get identity, not semantics). `press` fires
serialized clickEvents + emits CLICK (covers `on('click')`), but NOT raw `on(TOUCH_*)`.

**Can't test ❌**: rendering correctness, layout/position, timing/animation/feel,
physics/gameplay, audio, state not exposed on a component. *What* a button does is opaque
at runtime (press + observe a state delta) — coir's static ClickEvent map is the complement.

→ Use copse for **logic/flow integration testing** (+ best-effort reachability), not visual
or playtest QA.

## Conventions

- **Zero runtime deps.** DOM-free / engine-free pure core (`src/core/`); the `cc.*`
  coupling lives only in `src/cocos/` (Pixi in `src/pixi/`). The browser driver (`src/drivers/`,
  puppeteer-core) is an optional **peer**-dep edge, never a runtime dep.
- **Types** via JSDoc + `// @ts-check` (no `.ts` files); `npm run typecheck` is
  `tsc --noEmit` with `allowJs`/`checkJs:false`/`strict:false` — same posture as coir.
  (`src/drivers/puppeteer.js` opts out — its `page.evaluate` callbacks are browser code.)
- **Selector grammar is shared with coir** — keep `Parent/Child:Comp.prop` + `[i]`
  aligned so the two tools interoperate.
- Reaching `cc`: **build-setting dependent**. Verified on a **dev/preview build** (`window.cc`
  was present); a release build may tree-shake `cc` away (see `docs/INJECT.md`). If `window.cc`
  is missing, try `System.import('cc')` and pass the module to `install(...)`. **Iframed games**: the game's
  `cc` lives in the iframe's window — the inject bundle's `findCC()` walks **same-origin**
  (i)frames; the puppeteer driver scans `page.frames()` (handles **cross-origin** + nested too,
  per-frame `evaluate` isn't SOP-bound) and drives that frame. Note: release builds **minify component class
  names** (`constructor.name` → `e`/`n`/`t`), so `components[].type` is mangled though
  `getComponent('Label')` and serialized ClickEvent names still resolve.

## Open next steps

Done so far: build step → `dist/copse.inject.js`; `press → get` incl. a **state-delta**
mutation (read back off a component); code-registered handlers
(`codeHandlers`/`listeners`); the deterministic executor (`execute`/`extractFacts` — FACTS, no
verdict; the plan→judge LOOP moved to arbor); best-effort reachability (`reachable`/`blockedBy`); slim snapshot +
settle + descriptor-rich `changed`; **MCP** (`copse mcp`, hand-rolled stdio, verified driving a
running game natively from Claude Code); **test scripts** (`runScript` + `run_script`/`dump_script`
session recording + `copse run` — freeze an explored flow into a deterministic zero-LLM replay,
`docs/SCRIPTS.md`).

Remaining:

1. **Synthetic `TOUCH_*`** — `press` fires serialized clickEvents + emits CLICK, but not raw
   `on(TOUCH_*)` listeners; emit a synthetic touch for those.
2. **Reachability `reachable`** — ✅ Rung 2+3: cross-camera/Layer z-order; **version-adaptive caps**
   (feature-probe, never version-branch; `cc.UITransform`/`Camera` class-name-string fallback so a
   tree-shaken minified build — where the global class is `undefined` — still resolves `getComponent`);
   **engine-tier consumer** (`shouldHandleEventTouch`, ADDITIVE — catches a raw `node.on(TOUCH_*)` overlay a
   class check misses, never excludes a Button); **authoritative render camera** (`getFirstRenderCamera`,
   mapped back to its cc.Camera **component** because the raw render-camera's `worldToScreen` returns (0,0));
   **centre-primary** multi-point sampling (`reachableFraction`/`partial`); provenance `via:{consumer,camera}`;
   fail-loud `'unsure'`+`reason`; `visible` (opacity/scale). Remaining: alpha hit-areas, opaque-sprite visual
   occlusion (`occludedBy` is bbox best-effort), and `preventSwallow`/event-penetration (decided in-handler →
   statically unknowable).
3. ✅ **Surface `reachable` as a FACT** — a press to a covered/unreachable button is reported in
   `execute`'s `facts.unreachable` (`force`/`reachableGate:false` opt out); whether it fails a run is the
   consumer's verdict (arbor's).
4. **MCP v2** — ✅ `diff`/`listeners`/`probe` tools added (hijack/captured dropped with the probe refactor);
   debug tools advertised by default
   (`--no-debug` hides them — flipped once chrome-devtools-mcp made the Debugger surface the copse-unique part);
   ✅ active-tab attach (no `match` needed) + the shared-Chrome composition with `chrome-devtools-mcp`
   documented as the recommended shape (`docs/MCP.md`); ✅ **tab disambiguation** — `list_tabs` + multi-condition
   `match` (list ANDs, title too) + ambiguity error / `pick` + `attachedTab` in the connect summary (no more
   silent wrong-tab attach); ✅ **`hold`/`release`** — freeze the engine loop at a trigger to screenshot/inspect
   a transient state (the ~1s intermediate window a self-running flow blows past).
   Remaining: multi-session, a browser-use custom-actions example.
5. ~~**Adaptive re-planning within a round**~~ — MOVED TO ARBOR: the plan→execute→judge loop (and any
   smarter re-planning) is arbor's layer now. copse's value is the deterministic `execute` + facts +
   gates + script factory; interactive/adaptive exploration is Claude Code over MCP's lane.
