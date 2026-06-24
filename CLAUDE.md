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

**Validated MVP.** End-to-end proven against a **live Cocos 3.8.6 preview**
(`http://localhost:7456/`, the NewProject_386 test project): `cc` is reachable in the
preview, copse walked the live tree (coir-style refs), read a Button's wired
ClickEvent (`Button → NewComponent.onClick`), and `press('Node/Canvas/Button')`
returned `{ok:true, fired:1}` — i.e. `EventHandler.emit` fires the handler. 8 unit
tests green. `npm run build` now bundles a self-contained `dist/copse.inject.js` (one
IIFE, no ESM) that auto-installs `window.__copse` once `cc` is live — verified
end-to-end against a real-`cc`-shaped fake. Still scaffold-level beyond that.

## Commands

```bash
npm test           # node:test over FAKE trees (no engine, no install) — test/*.test.js (core + harness)
npm run typecheck  # tsc --noEmit (JSDoc); needs `npm install` for the dev deps only
npm run build      # esbuild src/inject.js → dist/copse.inject.js (one IIFE, gitignored)
```

There is **no runtime install** — copse is zero-dep (esbuild is a dev-only dep). To run
against a real game you inject the bundle into the running page (console paste /
Playwright `addInitScript` / dev-build hook — see `examples/inject.md`). `npm run build`
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
    `codeHandlers` via `_eventProcessor`, geometric `reachable` via `UITransform.hitTest`
    +camera+draw-order, `nodeInfo` intrinsics), plus `hijack(cc)` (patch `Node.prototype.on`).
    `install(cc)` exposes `window.__copse` (`snapshot`/`interactive`/`press`/`get`/`call`/
    `reachable`/`node`/`diff`/`listeners`/`hijack`/`captured`). All verified on a live build.
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
- `bin/copse.js` — the **CLI** (`copse ai <url> --goal …` / `copse scan <url>`), a thin
  wrapper over `connect` + `makeClaudeAgent` + `runHarness`.
- `test/core.test.js` — `node:test` over a fake tree (the place to add core tests).
- `test/harness.test.js` — the harness loop over a fake driver + deterministic agent.
- `examples/inject.md` — the three ways to inject + the AI test loop.
- `examples/ai-driver.md` — the harness wired to real Playwright + an LLM agent, two
  backends: the Anthropic SDK (`claude-opus-4-8`) or the `claude -p` CLI (no SDK, no API key).
- `examples/ai-driver-demo.js` — **runnable** end-to-end demo: `localDriver` over a fake
  shop scene + the `claude -p` agent. `node examples/ai-driver-demo.js` runs the whole AI
  loop with no browser/game/npm-deps (needs the `claude` CLI). Throwaway-free smoke.

`window.__copse` API once installed:
```js
__copse.snapshot()                 // slim: [{ ref, active?(only false), button?, interactable?, click?, label?, codeHandlers? }] — name=ref tail; components OFF by default
__copse.snapshot({ relevant:true, components:true })  // relevant: only button|label|codeHandlers nodes (cuts noise); components: include raw type list
__copse.interactive()              // snapshot filtered to buttons, WITH reachable/blockedBy (reachability:true)
__copse.press('Canvas/ShopBtn')    // run clickEvents + emit CLICK → { ok, ref, fired }  (honors interactable; {force:true} to override)
__copse.get('Canvas/Score:Label.string')          // { ok, value }  — for assertions
__copse.call('Canvas/Mgr:ShopController.buy', 30)  // invoke ANY method on ANY component → { ok, value }
__copse.reachable('Canvas/ShopBtn')               // { ok, reachable, blockedBy } — best-effort: covered by an overlay/BlockInputEvents?
__copse.node('Canvas/Panel')                      // node intrinsics → { active, activeInHierarchy, opacity, scale, worldPos, size }
__copse.get('Canvas/Panel:Node.active')           // read a single node intrinsic via the `Node` pseudo-component
__copse.diff(before, after)                       // → { appeared, disappeared, activated, deactivated (node descriptors w/ label/click), labelChanged }
__copse.listeners('Canvas/ShopBtn')               // user node.on() handlers (engine-internal + Button's own filtered out)
__copse.hijack(); __copse.captured('Canvas/X')    // opt-in: patch Node.prototype.on, then read what registered since (post-install only)
```
Panel open/close ("press buyfeature → its block opens") = snapshot `{includeInactive:true}`
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
≠ a player reaching the button. `reachable(ref)` / `interactive()` now flag a button that's
covered by an overlay / `BlockInputEvents` / a later-drawn panel (`blockedBy`). It's a
*geometric heuristic* (hitTest at the button's center + sibling-index draw order): it does
NOT resolve cross-camera/Layer z-order or alpha hit-areas, so treat `reachable:false` as a
strong signal to verify, not gospel, and `reachable:true` as "not obviously covered".

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
  `System.import('cc')` and pass the module to `install(...)` (the inject bundle's
  auto-install only covers `window.cc`). Note: release builds **minify component class
  names** (`constructor.name` → `e`/`n`/`t`), so `components[].type` is mangled though
  `getComponent('Label')` and serialized ClickEvent names still resolve.

## Open next steps

1. ~~A tiny build step → `dist/copse.inject.js`~~ **DONE** — `npm run build` (esbuild,
   `src/cocos/inject.js` → self-contained IIFE, auto-installs `window.__copse`).
2. ~~Run against a real game scene + `press → get` round-trip.~~ **DONE** — driven the live
   web-mobile build via system Chrome (CDP/puppeteer, throwaway): snapshot Q'd 62 nodes,
   `press('…/btn_panel')` fired `PanelUI.show`, `get`/`reachable`/`listeners` round-tripped.
   Still TODO: a *state-delta* assertion through a buy-style mutation (gold before/after).
3. ~~Code-registered handler coverage~~ **DONE** — `codeHandlers`/`listeners` (read
   `_eventProcessor`) + `hijack`/`captured` (patch `Node.prototype.on`). `press` still only
   emits CLICK, not raw `TOUCH_*` — emitting a synthetic touch for those is the remaining bit.
4. ~~An AI-driver harness~~ **Core DONE** — `runHarness` (`src/harness.js`, pure) + real
   Playwright/Anthropic wiring (`examples/ai-driver.md`); ran 2 rounds end-to-end against the
   live game (plan→press→judge→next→report).
5. **Reachability DONE (best-effort)** — `reachable`/`blockedBy` (`runtime.js`), verified
   flagging a covered button on the live build. Next: better z-order (cross-camera/Layer),
   and wire `reachable` into the harness so a covered button becomes a real fail, not a PASS.
