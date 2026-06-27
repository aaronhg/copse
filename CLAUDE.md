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

## Status

**Working tool**, driven end-to-end against real games:

- **Live games**: verified on a web-mobile release build + remote slot games. snapshot /
  `press → get` round-trips through real handler logic (a real action deducting the amount:
  balance `1,000,000 → 999,700`), reachability flagging a covered button, and panel
  open/close via `changed`.
- **AI-driver** (`copse ai`): multi-round flows on a live slot — mainfeature window
  open+close, amount switching (`300 ↔ 400`), one-action deduction — all PASS (report-driven verdict).
- **MCP** (`copse mcp`): the bridge as MCP tools; verified driving a live slot **natively
  from Claude Code** (open → dismiss → press boost → panel via `changed.appeared` → press
  close → `changed.disappeared`), no browser-use, adaptive (waited for the toggle to enable).
- **CI**: 48 `node:test` cases green, `npm run typecheck` clean, `npm run build` → a
  self-contained `dist/copse.inject.js` (one IIFE, auto-installs `window.__copse` once `cc` is live).

## Commands

```bash
npm test           # node:test over FAKE trees (no engine, no install) — test/*.test.js (core + harness + mcp)
npm run typecheck  # tsc --noEmit (JSDoc); needs `npm install` for the dev deps only
npm run build      # esbuild src/cocos/inject.js → dist/copse.inject.js (one IIFE, gitignored)
```

Run it: `copse ai <url> --goal "…"` / `copse scan <url>` / `copse mcp [url]` / single-shot
`copse get|press|call|node|reachable <url> <sel>`
(the CLI is `src/cli.js`, runs directly; only `dist/copse.inject.js` is ever built). MCP: `claude mcp add copse -- node <abs>/src/cli.js mcp`
or a project `.mcp.json` — then any MCP client (Claude Code / browser-use) drives the canvas (see `docs/MCP.md`).

There is **no runtime install** — copse is zero-dep (esbuild is a dev-only dep). To run
against a real game you inject the bundle into the running page (console paste /
Playwright `addInitScript` / dev-build hook — see `docs/INJECT.md`). `npm run build`
produces `dist/copse.inject.js`: paste it / `addInitScript` it and it exposes
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

- `src/core/index.js` — **pure core**, engine-free. `snapshot` / `resolve` / `press` /
  `get` / `call` / `reachable` / `node` / `diff`, all over a `Runtime` adapter (the
  `@typedef` at the top is the whole contract). Addressing: `Parent/Child` paths relative
  to the scene root, `[i]` for same-name siblings, `path:Comp.member` (or `path:Node.prop`)
  for a member. `#N` absolute indices are intentionally unsupported (no stable index).
- `src/cocos/` — the **engine-coupled** layer (the only place that touches `cc.*`):
  - `runtime.js` — `cocosRuntime(cc)` implements the `Runtime` adapter (incl. optional
    `codeHandlers` via `_eventProcessor`, geometric `reachable` via `UITransform.hitTest` +
    **cross-camera/Layer z-order** (camera priority → sibling-index) + a separate `visible` signal
    (`opacity/scale===0`, never folded into the reachable boolean), `nodeInfo` intrinsics), plus `hijack(cc)`,
    `findCC()` (walk same-origin (i)frames → the game's `cc`), and `startLogCapture()` (patch
    `console.*` + error events into a buffer). `install(cc)` exposes `window.__copse`
    (`snapshot`/`interactive`/`press`/`get`/`call`/`reachable`/`node`/`diff`/`listeners`/`logs`/
    `hijack`/`captured`). All verified on a live build.
  - `inject.js` — the **build entry** (not public API): re-exports the in-page surface on
    `globalThis.copse` + auto-installs `window.__copse` once `cc` boots. esbuild → `dist/copse.inject.js`.
- `src/harness.js` — **pure AI-driver loop** (`runHarness`), decoupled like the core: over a
  `Driver` adapter (`localDriver(scene, rt)` builds one over an in-process tree) and an
  `Agent` adapter whose `plan`/`judge`/`next`/`report` are the AI seams (`next`/`report`
  optional). Loop `snapshot → (plan → execute → judge) → maybe iterate → report`, `maxRounds`-
  bounded, policy-free, throwing steps captured not fatal. Prompt-agnostic: `opts.context` is
  passed verbatim to every stage. No engine/LLM dep — those live at the adapter edges below.
- `src/drivers/puppeteer.js` — **optional** driver (`copse/driver-puppeteer`): `connect(url)`
  launches system Chrome (puppeteer-core peerDep), injects the bundle → a `Driver` for runHarness.
  Browser-glue, so deliberately not `@ts-check`ed.
- `src/agents/claude.js` — **optional** agent (`copse/agent-claude`): `makeClaudeAgent({goal,
  stopCondition,reportFormat})` → an `Agent` backed by the `claude -p` CLI (no npm dep).
- `src/debug.js` — **optional** edge (`copse/debug`): `attachDebugger(cp.page)` → breakpoints + call
  stack over the CDP **Debugger** domain. iframe-aware (attaches to page + iframe/OOPIF targets; resolves
  across all contexts). `breakAt(urlRegex,line)` + `breakIn('path:Comp.method')`
  (resolves the method via `window.__copse` → break on call; works minified), `breakOnExceptions`,
  `waitPause`→callstack, `evalFrame`, `step`/`resume`. Exposed as MCP tools `break_*`/`wait_pause`/
  `eval_frame`/`debug_step`. For your OWN dev build (pausing trips anti-debug). Browser-glue, not `@ts-check`ed.
- `src/mcp/` — **optional** MCP edge (`copse/mcp`, subcommand `copse mcp`): exposes the bridge as
  MCP tools so ANY MCP client (Claude Code / browser-use / Stagehand / a plain tool-use loop) drives
  the canvas. `server.js` = hand-rolled JSON-RPC-over-stdio (mirrors coir's `mcp/server.js`: stderr-only
  logging, serialized handler, `createDispatcher(state)` exported for tests; gates debug-tagged tools
  out of `tools/list` unless `state.debug`); `tools.js` = the tool registry — 14 testing primitives by
  default (`connect`/`snapshot`/`interactive`/`press`/`get`/`call`/`reachable`/`node`/`diff`/`listeners`/
  `hijack`/`captured`/`logs`/`close`) + 7 `debug:true`-tagged Debugger tools (`break_*`/`wait_pause`/
  `eval_frame`/`debug_step`/`clear_breakpoints`) **hidden unless `copse mcp --debug`** — over a live
  `connect()` session (the MCP tool names match the library 1:1, incl. `connect`). The valuable part of copse is this bridge; the
  agent loop is replaceable.
- `src/cli.js` — the **CLI** (registered as `copse`; runs directly, no build): `copse ai <url> --goal …`
  / `copse scan <url>` / `copse mcp [url] [--debug]` / single-shot `copse get|press|call|node|reachable
  <url> <sel>` (connect → one primitive → JSON → close, for shell/jq) / `--version`.
  Thin wrapper over `connect` + `makeClaudeAgent` + `runHarness`;
  heavy/optional bits (puppeteer driver, claude agent, MCP server) are **lazy-imported** per command so
  `copse --help` / `copse mcp` don't require puppeteer-core. (Layout matches coir: no `bin/` dir.)
- `test/core.test.js` — `node:test` over a fake tree (the place to add core tests).
- `test/harness.test.js` — the harness loop over a fake driver + deterministic agent.
- `test/mcp.test.js` — the MCP JSON-RPC dispatcher (`createDispatcher`) over a fake driver.
- `docs/MCP.md` — drive copse from any MCP client (Claude Code / browser-use); incl. **attach** mode
  for Cloudflare/login sites (attach to your own browser over CDP, no navigation).
- `docs/DEBUG.md` — `copse/debug` (CDP Debugger): breakpoints (incl. `break_in path:Comp.method`) +
  call stack / `eval_frame` / step, as MCP tools — for your own dev build.
- `docs/INJECT.md` — the three ways to inject + the AI test loop.
- `docs/AI-DRIVER.md` — the harness wired to real Playwright + an LLM agent, two
  backends: the Anthropic SDK (`claude-opus-4-8`) or the `claude -p` CLI (no SDK, no API key).
- `scripts/ai-driver-demo.js` — **runnable** end-to-end demo: `localDriver` over a fake
  shop scene + the `claude -p` agent. `node scripts/ai-driver-demo.js` runs the whole AI
  loop with no browser/game/npm-deps (needs the `claude` CLI). Throwaway-free smoke.

`window.__copse` API once installed:
```js
__copse.snapshot()                 // slim: [{ ref, active?(only false), button?, interactable?, click?, label?, codeHandlers? }] — name=ref tail; components OFF by default
__copse.snapshot({ relevant:true, components:true })  // relevant: only button|label|codeHandlers nodes (cuts noise); components: include raw type list
__copse.interactive()              // snapshot filtered to buttons, WITH reachable/blockedBy + visible:false (reachability:true)
__copse.press('Canvas/ShopBtn')    // run clickEvents + emit CLICK → { ok, ref, fired }  (honors interactable; {force:true} to override)
__copse.get('Canvas/Score:Label.string')          // { ok, value }  — for assertions
__copse.call('Canvas/Mgr:ShopController.buy', 30)  // invoke ANY method on ANY component → { ok, value }
__copse.reachable('Canvas/ShopBtn')               // { ok, reachable, blockedBy, visible } — covered (z-order/BlockInputEvents)? + visible=opacity/scale!==0
__copse.node('Canvas/Panel')                      // node intrinsics → { active, activeInHierarchy, opacity, scale, worldPos, size }
__copse.get('Canvas/Panel:Node.active')           // read a single node intrinsic via the `Node` pseudo-component
__copse.diff(before, after)                       // → { appeared, disappeared, activated, deactivated (node descriptors w/ label/click), labelChanged }
__copse.listeners('Canvas/ShopBtn')               // user node.on() handlers (engine-internal + Button's own filtered out)
__copse.logs(sinceTs?)                            // captured console.* + uncaught errors → [{level,text,t,stack?}] (started on inject load)
__copse.hijack(); __copse.captured('Canvas/X')    // opt-in: patch Node.prototype.on, then read what registered since (post-install only)
```
Panel open/close ("press mainfeature → its block opens") = snapshot `{includeInactive:true}`
→ act → snapshot → `diff`: the panel's subtree shows up in `activated`/`appeared`. Verified
on a live slot: pressing the menu toggle put 21 menu nodes in `diff.activated`.
Verified against a live web-mobile build: `reachable` correctly flags a
home button as `blockedBy:"Canvas/Popup/mask"` once a panel opens. Caveats below.

## Capability boundary (be honest in docs/replies)

**Can test ✅** (functional/logic): UI flows + state machines, numeric/data correctness
(read component fields), UI binding (Label/sprite after an action), button enable
logic, node presence/absence, **panel open/close & visibility transitions** (`node()`
intrinsics + `diff()` of before/after snapshots → which subtree activated/appeared),
doesn't-crash, idempotency/races, logical-state regression. Because you hold the live
component reference, `call` drives *any* method — a general "drive the logical API +
assert state" harness, not just buttons.

**Best-effort now (was the headline caveat) ⚠️**: **reachability** — calling the handler
≠ a player reaching the button. `reachable(ref)` / `interactive()` flag a button that's
covered by an overlay / `BlockInputEvents` / a later-drawn panel (`blockedBy`), via a *geometric
heuristic*: hitTest at the button's center, draw-order = **[camera priority, …sibling-index]** so it
DOES resolve cross-camera/Layer z-order. Still: no alpha hit-areas, and — key boundary — `reachable`
answers "would a **touch** reach it" (input ignores opacity), so a button **visually** covered by an
opaque sprite (no input-consumer on top) reads `reachable:true`. A separate **`visible`** field
(`opacity/scale!==0`, on `interactable`/`reachable`) catches buttons hidden by an opacity/scale toggle —
combine `reachable && visible` — but neither sees opaque-sprite visual occlusion (that's pixels, not the
logic tree). Treat `reachable:false` as a strong signal to verify, not gospel.

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
- Reaching `cc`: **build-setting dependent**, not preview-only. Verified working on a real
  **web-mobile release build** (`window.cc` was present). If `window.cc` is missing, try
  `System.import('cc')` and pass the module to `install(...)`. **Iframed games**: the game's
  `cc` lives in the iframe's window — the inject bundle's `findCC()` walks **same-origin**
  (i)frames; the puppeteer driver scans `page.frames()` (handles **cross-origin** + nested too,
  per-frame `evaluate` isn't SOP-bound) and drives that frame. Note: release builds **minify component class
  names** (`constructor.name` → `e`/`n`/`t`), so `components[].type` is mangled though
  `getComponent('Label')` and serialized ClickEvent names still resolve.

## Open next steps

Done so far: build step → `dist/copse.inject.js`; real-game `press → get` incl. a **state-delta**
mutation (a action deducting the amount, balance `1,000,000 → 999,700`); code-registered handlers
(`codeHandlers`/`listeners`/`hijack`); AI-driver harness (`runHarness` + `copse ai`, report-driven
verdict, evidence-fed `next`); best-effort reachability (`reachable`/`blockedBy`); slim snapshot +
settle + descriptor-rich `changed`; **MCP** (`copse mcp`, hand-rolled stdio, verified driving a
live slot natively from Claude Code).

Remaining:

1. **Synthetic `TOUCH_*`** — `press` fires serialized clickEvents + emits CLICK, but not raw
   `on(TOUCH_*)` listeners; emit a synthetic touch for those.
2. **Better z-order in `reachable`** — ✅ cross-camera / Layer ordering done (camera priority →
   sibling-index) + `visible` (opacity/scale). Remaining: alpha hit-areas, and opaque-sprite visual
   occlusion (a button covered by an opaque image with no input-consumer on top reads `reachable:true`).
3. ✅ **Wire `reachable` into the harness** — a press to a covered/unreachable button is now a HARD fail in
   `runHarness` (overrides judge+report; surfaced as `out.unreachable`; `force`/`reachableGate:false` opt out).
4. **MCP v2** — ✅ `diff`/`listeners`/`hijack`/`captured` tools added; debug tools gated behind `--debug`.
   Remaining: multi-session, a browser-use custom-actions example.
5. **Adaptive re-planning within a round** — so a step whose target only appears after an earlier
   step (e.g. a panel's close button) doesn't always need another round.
