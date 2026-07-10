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
idea is `../aaron/canvas-ai-testing-plan.md` (the "make AI see into the canvas" plan,
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
- **AI-driver** (`copse ai`): multi-round flows on a running game — panel open+close, a
  setting toggle, a one-action state delta — all PASS (report-driven verdict).
- **MCP** (`copse mcp`): the bridge as MCP tools; verified driving a running game **natively
  from Claude Code** (open → dismiss → press → panel via `changed.appeared` → press
  close → `changed.disappeared`), no browser-use, adaptive (waited for a toggle to enable).
- **CI**: 101 `node:test` cases green (+1 engine-gated skip), `npm run typecheck` clean, `npm run build` → three
  self-contained IIFEs (each auto-installs `window.__copse` once `cc` is live): `dist/copse.inject.js`
  (full — the QA/coverage surface), `dist/copse.inject.lite.js` (lite — snapshot/press/get/call/node/diff,
  reachability tree-shaken out; ~half the size, for a `press`-only caller like mast), and
  `dist/copse.inject.probe.js` (probe — read+drive: reachability/`find`/`assets`/`press`, no
  snapshot-extras/get/call/diff; for a load-metrics driver like mast's extension).

## Commands

```bash
npm test           # node:test over FAKE trees (no engine, no install) — test/*.test.js (core + harness + mcp)
npm run typecheck  # tsc --noEmit (JSDoc); needs `npm install` for the dev deps only
npm run build      # build:full + build:lite + build:probe → dist/copse.inject{,.lite,.probe}.js (IIFEs, gitignored)
```

Run it: `copse ai <url> --goal "…"` / `copse scan <url>` / `copse mcp [url]` / single-shot
`copse get|press|call|node|reachable <url> <sel>` / `copse coverage <url> <coir-rows.json>` (the coir×copse join)
/ `copse run <url> <script.json>` (deterministic script replay → exit 0/1, `docs/SCRIPTS.md`)
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

Layout (grouped by concern; `src/index.js` is the public barrel):

- `src/core/index.js` — **pure core**, engine-free. `snapshot` / `clickSurface` / `resolve` /
  `press` / `get` / `call` / `reachable` / `node` / `diff`, all over a `Runtime` adapter (the
  `@typedef` at the top is the whole contract). Addressing: `Parent/Child` paths relative
  to the scene root, `[i]` for same-name siblings, `path:Comp.member` (or `path:Node.prop`)
  for a member. `#N` absolute indices are intentionally unsupported (no stable index). The full
  grammar copse implements (a subset of coir's) + divergences are in `docs/SELECTORS.md`, pinned
  by `test/selectors.test.js`.
- `src/coverage.js` — **pure** coir × copse bridge: `coverageJoin(staticRows, runtimeRows)` buckets
  every wired button into covered / blocked / unreached / ambiguous / code-only on the shared key
  `(nodePath, method)`. Two-tier match: exact + **symmetric tail** (shorter path is a segment-suffix of the
  longer, `[i]` fuzzy) — absorbs the two rootings: coir's scene/prefab-file root (`dropped`) and a prefab's
  instantiation `mount`; >1 tail candidate → ambiguous. `clickSurface` produces its copse side. Verified
  live (the symmetric case is what a real scene needs — coir paths carry the scene-root prefix). See `docs/COVERAGE.md`.
- `src/cocos/` — the **engine-coupled** layer (the only place that touches `cc.*`):
  - `runtime.js` — the `Runtime` adapter over ONE shared `baseRuntime(cc)` (`press`/`get`/`call` driving +
    `codeHandlers` via `_eventProcessor` + `nodeInfo` intrinsics), in two shapes: `cocosRuntime(cc)` =
    base **+ `reachable`**, `cocosRuntimeLite(cc)` = base ONLY. Plus `findCC()` (walk same-origin
    (i)frames → the game's `cc`), `startLogCapture()` (patch `console.*` + errors), and the two installers:
    `install(cc)` (full `window.__copse`: `snapshot`/`interactive`/`press`/`get`/`call`/`reachable`/`node`/`diff`/
    `listeners`/`probe`/`logs`), `installLite(cc)` (minimal: `snapshot`/`press`/`get`/`call`/`node`/`diff`/`listeners`),
    and `installProbe(cc)` (read+drive metrics surface: `probe`/`firstClickable`/`find`/`interactive`/`reachable`/`press`
    + `assetsPending` — keeps reachability, drops snapshot-extras/get/call/diff/logs; for a load-metrics driver).
    All verified on a dev/preview build.
  - `reachable.js` — `makeReachable(cc)`, the geometric `reachable` signal (`UITransform.hitTest` +
    **cross-camera/Layer z-order** (camera priority → sibling-index) + a separate `visible` signal
    (`opacity/scale===0`, never folded into the reachable boolean) + `occludedBy`), split out so it's
    **imported only by the full `cocosRuntime`** → esbuild tree-shakes it out of the lite bundle. Self-contained
    (re-resolves the cc classes it needs), so it could later be built into a standalone injectable snippet.
    Exercised in CI by `test/reachable.test.js` over a geometric fake `cc`.
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
- `src/harness.js` — **pure AI-driver loop** (`runHarness`), decoupled like the core: over a
  `Driver` adapter (`localDriver(scene, rt)` builds one over an in-process tree) and an
  `Agent` adapter whose `plan`/`judge`/`next`/`report` are the AI seams (`next`/`report`
  optional). Loop `snapshot → (plan → execute → judge) → maybe iterate → report`, `maxRounds`-
  bounded, policy-free, throwing steps captured not fatal. Prompt-agnostic: `opts.context` is
  passed verbatim to every stage. No engine/LLM dep — those live at the adapter edges below.
  **Lane (post-scripts):** the headless edge — unattended CI smoke over un-scripted flows
  (`copse ai --goal`), fact gates over LLM opinion, and a **script factory** (`rounds[].steps`
  freeze 1:1 into scripts). Interactive exploration belongs to Claude Code over MCP; known-flow
  regression belongs to `src/script.js`. Don't invest in making the harness's agent smarter.
- `src/script.js` — **pure deterministic script runner** (`runScript` + `subsetMatch`): replays a
  FROZEN flow (JSON steps + subset-match `expect`s, `docs/SCRIPTS.md`) over the same `Driver`
  adapter — the zero-LLM regression half. Step = the harness `Step` shape (+`expr`/`ms`/`since`) +
  `expect`/`allowErrors`; subset match = primitives `===`, objects by key, arrays CONTAINS. No
  `expect` → `ok !== false`; fact gates mirror the harness (`errors` fails unless
  allowErrors/asserted; press `drove:'nothing'` fails unless asserted — an explicit expect
  overrides its gate). Stops at the first fail (`continueOnFail` runs all); empty steps →
  `pass:false`; per-step `{step, ok, ms, mismatch?/gate?, result?}`.
- `src/drivers/puppeteer.js` — **optional** driver (`copse/driver-puppeteer`): `connect(url)`
  launches system Chrome (puppeteer-core peerDep), injects the bundle → a `Driver` for runHarness.
  Attach mode (`{attach:true, browserURL, match?}`) drives an already-open tab; **no `match`/url →
  the ACTIVE tab** (visibilityState/hasFocus probes, race-bounded so a paused tab can't hang the
  scan — a paused game must be attached via `match`). `cp.reload()` (factored `bootInPage`)
  re-navigates the tab + re-injects — picks up the editor's CURRENT
  scene after `scene_open_scene`, and recovers a wedged/empty preview (attach-found-`getScene()===null`).
  Browser-glue, so deliberately not `@ts-check`ed.
- `src/agents/claude.js` — **optional** agent (`copse/agent-claude`): `makeClaudeAgent({goal,
  stopCondition,reportFormat})` → an `Agent` backed by the `claude -p` CLI (no npm dep).
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
  out of `tools/list` when `state.debug` is falsy); `tools.js` = the tool registry — 32 testing primitives
  (`connect`/`reload`/`snapshot`/`interactive`/`click_surface`/`resolve`/`coverage`/`press`/`get`/`call`/`eval`/`reachable`/`node`/`diff`/
  `listeners`/`probe`/`logs`/`watch`/`patch`/`patch_clear`/`framework`/`register_framework`/`pm_state`/`pm_call`/`network`/`screenshot`/`visual_check`/`visual_baseline`/`reachable_visual`/`run_script`/`dump_script`/`close`)
  + 7 `debug:true`-tagged Debugger tools (`break_*`/`wait_pause`/
  `eval_frame`/`debug_step`/`clear_breakpoints`), **all advertised by default** (chrome-devtools-mcp has no
  Debugger domain, so the breakpoint surface is copse-unique; `copse mcp --no-debug` hides the debug 7
  against protected/anti-debug games) — over a live
  `connect()` session (the MCP tool names match the library 1:1, incl. `connect`). `record:true`-tagged
  tools (press/get/call/node/reachable/eval/snapshot/interactive) are wrapped at the bottom of tools.js to
  push `{…step, observed}` onto `state.history` on success — `dump_script` exports that recording as a
  script skeleton (`docs/SCRIPTS.md`); `connect` resets it. The valuable part of copse is this bridge; the
  agent loop is replaceable.
- `src/cli.js` — the **CLI** (registered as `copse`; runs directly, no build): `copse ai <url> --goal …`
  / `copse scan <url>` / `copse mcp [url] [--no-debug]` / single-shot `copse get|press|call|node|reachable
  <url> <sel>` (connect → one primitive → JSON → close, for shell/jq) / `copse coverage <url> <coir-rows.json>`
  (connect → clickSurface + coverageJoin → buckets — the coir×copse capability at the shell) / `--version`.
  Thin wrapper over `connect` + `makeClaudeAgent` + `runHarness`;
  heavy/optional bits (puppeteer driver, claude agent, MCP server) are **lazy-imported** per command so
  `copse --help` / `copse mcp` don't require puppeteer-core. (Layout matches coir: no `bin/` dir.)
- `test/core.test.js` — `node:test` over a fake tree (the place to add core tests; incl. `clickSurface`).
- `test/selectors.test.js` — selector-grammar conformance: copse's `[i]`/member/divergence semantics +
  an interop corpus (coir-emitted paths must resolve in copse). Pins the contract in `docs/SELECTORS.md`.
- `test/coverage.test.js` — the `coverageJoin` buckets incl. the prefab-internal prefix match + ambiguity.
- `test/harness.test.js` — the harness loop over a fake driver + deterministic agent.
- `test/script.test.js` — the script runner over a fake driver: subset/contains + mismatch paths,
  the default ok/errors/drove judgment, expect-overrides-gate, sleep, stop-on-fail vs continueOnFail.
- `test/mcp.test.js` — the MCP JSON-RPC dispatcher (`createDispatcher`) over a fake driver.
- `test/reachable.test.js` — `cocosRuntime(cc).reachable` over a geometric fake `cc` (the only place the engine-coupled reachable runs in CI).
- `test/runtime-lite.test.js` — the base/lite split contract (lite omits `reachable`; `press` works over lite).
- `test/probe.test.js` — `probe(cc)` over a 3.8.6-shaped fake (which internals resolve; tree-shaken/no-scene degrade).
- `test/real-engine.l2.test.js` (+ `test/helpers/real-engine.js`) — **L2**: copse's reads against a REAL Cocos engine.
  esbuild-bundles the event source from `reference/cocos/<ver>` (gitignored local checkout; virtual/deep-leaf modules
  stubbed) → a real `CallbacksInvoker`, and asserts `codeHandlers` parses the real `_callbackTable`. SKIPS when no
  engine is checked out. Add a version: `git clone --depth 1 -b v3.8.6 https://github.com/cocos/cocos-engine reference/cocos/3.8.6`.
- `docs/COVERAGE.md` — the **coir × copse** join recipe: `clickSurface`/`click_surface` → `coverageJoin`
  cross-references copse's runtime click surface with coir's static ClickEvent map on `(nodePath, method)`
  → buckets (covered / blocked / unreached / ambiguous / code-only). Runnable proof: `scripts/coverage-demo.js`.
- `docs/SELECTORS.md` — copse's selector grammar as a **subset of coir's** (canonical: coir/docs/EDITING.md §3):
  the shared core, copse's divergences (no `#N`/component-`[i]`/array-`[i]`, always index-parses `[i]`,
  minified comp names) + its `Node` pseudo-component. Pinned by `test/selectors.test.js`.
- `docs/MCP.md` — drive copse from any MCP client (Claude Code / browser-use); incl. **attach** mode
  for your own game behind a login/staging gate (attach to your own browser over CDP, no navigation).
- `docs/SCRIPTS.md` — test scripts: format + subset-match semantics + the
  explore→`dump_script`→trim→`run_script`/`copse run` workflow (freeze an explored flow into a
  deterministic replay; also freezes 1:1 from `runHarness` rounds).
- `docs/DEBUG.md` — `copse/debug` (CDP Debugger): breakpoints (incl. `break_in path:Comp.method`) +
  call stack / `eval_frame` / step, as MCP tools — for your own dev build.
- `docs/INJECT.md` — the three ways to inject + the AI test loop.
- `docs/AI-DRIVER.md` — the harness wired to real Playwright + an LLM agent, two
  backends: the Anthropic SDK (`claude-opus-4-8`) or the `claude -p` CLI (no SDK, no API key).
- `scripts/ai-driver-demo.js` — **runnable** end-to-end demo: `localDriver` over a fake
  shop scene + the `claude -p` agent. `node scripts/ai-driver-demo.js` runs the whole AI
  loop with no browser/game/npm-deps (needs the `claude` CLI). Throwaway-free smoke.
- `scripts/coverage-demo.js` — **runnable** proof of the coir × copse join: real `snapshot`+`clickSurface`
  over a fake scene + a coir static fixture → the four-quadrant coverage report. `node scripts/coverage-demo.js`,
  zero deps, no browser, **no CLI** (unlike ai-driver-demo). See `docs/COVERAGE.md`.

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
__copse.probe()                                   // engine-coupling self-diagnostic → { version, classes, reach, events, touch, framework } — which version-sensitive internals resolve on THIS build (drift → visible, not a silent 'unsure')

__copse.logs(sinceTs?)                            // captured console.* + uncaught errors → [{level,text,t,stack?}] (started on inject load)
__copse.watch({exprs?,selectors?,interval?,until?,timeout?,settle?})  // diff-only state TIMELINE over time → { timeline:[{t,dt,changes}], stoppedBy } (one in-page loop; replaces hand-written polling)
__copse.patch('Canvas/Mgr:Ctrl.setBet', {before?,after?,replace?})   // wrap a live method (JS fn-expr src) to verify a fix pre-rebuild → { ok, method, hooks }; __copse.patch_clear(sel?) restores
__copse.registerFramework(adapterOrSrc)           // install a framework adapter for this session → { ok, kind, registered }  (core ships NONE)
__copse.framework()                               // detect via REGISTERED adapters + enumerate → { kind, proxies, mediators, commands, registered }  (logic state OUTSIDE the cc tree)
__copse.pmState('GameDataProxy.active' [,true,value])  // read/write a proxy/mediator prop (get/call can't reach these) → { ok, value|wrote }
__copse.pmCall('PanelMediator.toggle', args)  // call a proxy/mediator method → { ok, value }
```
**Framework-aware access is a PLUGIN, not core knowledge** (`src/cocos/framework.js` is a generic adapter
engine — no PureMVC baked in; not every game has a framework and those that do wire it differently). The
driver auto-loads adapters from `copse.frameworks.mjs` (this machine's, next to the package, **git-ignored**;
then a per-project one in cwd) + `connect({frameworks})` / `--framework <file>` / the `register_framework`
tool, and injects them so `framework`/`pm_state`/`pm_call` light up. An adapter is a CONFIG object
(`{kind, facade:[…locations], proxy:{via?,map?}, mediator, command}` — field-name candidates absorb per-game
differences) or a code-adapter source string. `probe.framework.registered` says how many are loaded. See
`copse.frameworks.example.mjs`.

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
  coupling lives only in `src/cocos/`. The browser driver (`src/drivers/`, puppeteer-core)
  and LLM agent (`src/agents/`) are optional **peer**-dep edges, never runtime deps.
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
(`codeHandlers`/`listeners`); AI-driver harness (`runHarness` + `copse ai`, report-driven
verdict, evidence-fed `next`); best-effort reachability (`reachable`/`blockedBy`); slim snapshot +
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
3. ✅ **Wire `reachable` into the harness** — a press to a covered/unreachable button is now a HARD fail in
   `runHarness` (overrides judge+report; surfaced as `out.unreachable`; `force`/`reachableGate:false` opt out).
4. **MCP v2** — ✅ `diff`/`listeners`/`probe` tools added (hijack/captured dropped with the probe refactor);
   debug tools advertised by default
   (`--no-debug` hides them — flipped once chrome-devtools-mcp made the Debugger surface the copse-unique part);
   ✅ active-tab attach (no `match` needed) + the shared-Chrome composition with `chrome-devtools-mcp`
   documented as the recommended shape (`docs/MCP.md`).
   Remaining: multi-session, a browser-use custom-actions example.
5. ~~**Adaptive re-planning within a round**~~ — DEPRIORITIZED: that's "make the harness's agent
   smarter", and interactive/adaptive exploration is Claude Code over MCP's lane now (the harness's
   value is the deterministic shell + gates + script factory, not a smarter brain).
