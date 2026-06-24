# copse

Drive and assert a **running Cocos canvas game** through its **live node tree** —
no pixels, no input simulation. You walk the live scene (`cc.director.getScene()`),
find the buttons / registered events, and **call their handlers directly**, then
read component state back to check what happened.

It's the **runtime sibling to [coir](https://github.com/aaronhg/coir)**: coir reads
a project's *static* asset/dependency graph; copse reads the *running* scene's live
UI tree. Both turn an opaque Cocos internal into structured data an AI (or a test)
can query — and both speak the **same selector grammar** (`Parent/Child:Comp.prop`,
`[i]` to disambiguate same-name siblings).

> Status: **working.** Pure core + Cocos adapter + AI-driver harness + a CLI/library
> entry, verified end-to-end against live builds (a web-mobile game and a remote slot):
> snapshot, `press → get` state round-trips, reachability, and panel-open detection.

## Why this shape

`<canvas>` is an opaque rectangle to the DOM — Playwright/Selenium see one element.
The usual fix (a coordinate bridge: snapshot → screen rect → real mouse click) drags
in the hardest problems: coordinate mapping, frame timing, headless GPU. copse skips
all of it: it doesn't click *pixels*, it **invokes the handler the button is wired to**
(serialized `clickEvents` + an emitted `CLICK` for code-registered listeners). What
you get is, in effect, **integration testing of the game's logic layer through the
live object graph** — fast, deterministic, no GPU.

## What it can test ✅

- **Flows / state machines** — press Shop → does the panel activate? press Buy → does
  gold decrement and the item appear? press Close → does it deactivate?
- **Numeric / data correctness** — read your component fields (gold, hp, score) after
  an action and assert.
- **UI binding** — after a state change, did the `Label.string` / shown sprite update?
- **Button enable logic** — is Buy `interactable:false` when gold is short?
- **Panel open/close & visibility** — `node(ref)` reads `active`/`activeInHierarchy`/
  `opacity`/`scale`/`worldPos`; `diff(before, after)` shows which subtree activated/appeared
  after an action (e.g. press mainfeature → its block opens).
- **Doesn't-crash** — pressing a button throws? caught.
- **Idempotency / races** — hammer a handler twice; does it double-charge?
- **Regression** — snapshot the logical state tree before/after a change and diff.

Because you hold the live component reference, you're not limited to buttons — `call`
invokes **any method on any component**, so copse is a general "drive the game's
logical API + assert on its state" harness.

## What it can't test ❌ (be honest)

copse trades away the whole visual/spatial/timing dimension:

- **Rendering** — is it actually drawn, on top, un-clipped, not garbled? (tree ≠ pixels)
- **Layout / position** — a button at `(-9999, 0)` or two overlapping panels.
- **⚠ Reachability (now best-effort)** — *calling the handler ≠ a player being able to reach
  it.* `reachable(ref)` / `interactive()` flag a button covered by an overlay /
  `BlockInputEvents` / a later-drawn panel (`blockedBy`), via a geometric hitTest +
  draw-order heuristic. It does **not** resolve cross-camera/Layer z-order or alpha hit
  areas — treat `reachable:false` as a strong signal to verify, `reachable:true` as "not
  obviously covered". Still not a substitute for a real playtest.
- **Timing / animation / feel**, **physics / gameplay**, **audio**, and any state not
  exposed on a component (closures, locals).
- **What a button does** is opaque at runtime (you press and observe a state delta) —
  coir's *static* ClickEvent map (`click→method()`) is the complement if you want that.

→ Use copse for **logic/flow integration testing**, not visual or playtest QA.

## API

The pure core (`src/core/`) operates over a tiny `Runtime` adapter, so it's
testable in Node against a fake tree. `src/cocos/runtime.js` is the Cocos `cc.*` adapter
+ `install(cc)`, which exposes the bridge as `window.__copse`:

```js
__copse.snapshot()                 // slim: [{ ref, active?(only false), button?, interactable?, click?, label?, codeHandlers? }]
__copse.snapshot({ relevant:true })  // only nodes with a testable surface (button|label|codeHandlers); {components:true} adds raw types
__copse.interactive()              // buttons only, WITH reachable/blockedBy
__copse.press('Canvas/ShopBtn')    // run its clickEvents + emit CLICK → { ok, ref, fired }
__copse.press('Canvas/BuyBtn', { force: true })   // ignore interactable
__copse.get('Canvas/Score:Label.string')          // { ok, value }
__copse.call('Canvas/Mgr:ShopController.buy', 30)  // invoke any method → { ok, value }
__copse.reachable('Canvas/ShopBtn')               // { ok, reachable, blockedBy } — covered by an overlay/BlockInputEvents?
__copse.node('Canvas/Panel')                      // node intrinsics → { active, activeInHierarchy, opacity, scale, worldPos, size }
__copse.diff(before, after)                        // → { appeared, activated, deactivated (node descriptors), labelChanged, ... }
__copse.listeners('Canvas/ShopBtn')               // user node.on() handlers (best-effort; see caveat)
__copse.hijack(); __copse.captured('Canvas/X')    // opt-in: record node.on() registrations made after install
```

To check a panel opened ("press mainfeature → its block appears"): `snapshot({includeInactive:true})`
→ press → `snapshot` → `diff` — the panel's subtree turns up in `activated`/`appeared`.

Addressing matches coir: `Parent/Child` node paths, `[i]` for same-name siblings,
`path:Comp.member`. Paths are relative to the scene root; `#N` absolute indices are
unsupported (no stable index in a live tree).

## AI-driver harness

`runHarness(driver, agent, opts)` is the autonomous loop on top of those
primitives — `snapshot → plan → press/get/call → judge → maybe iterate → report`.
It's **pure and zero-dep**, decoupled through a `Driver` adapter (copse proxied
into the page) and an `Agent` adapter whose methods are the points where the AI
intervenes: `plan` (decide *what to test* + the expected outcome — the oracle),
`judge` (*pass/fail* from the state delta), `next` (*when to stop*, optional), and
`report` (shape the final summary *in your format*, optional). Everything between
is the deterministic copse rail.

You steer each stage with your own prompts — the harness passes `opts.context`
(e.g. `{ diff, goal, stopCondition, reportFormat }`) verbatim to every stage, or
bake guidance into the agent with a factory. `runHarness` always returns the
structured `{ pass, rounds, snapshot }` (raw material to reshape in code) plus
`summary` when you supply `agent.report`. The AI sees the node tree, not pixels,
so its verdict is scoped to **logic/flow**, not visual/reachability. Real
Playwright + Anthropic (`claude-opus-4-8`) wiring, the steering knobs, and the
report shape are in [`examples/ai-driver.md`](examples/ai-driver.md);
[`examples/ai-driver-demo.js`](examples/ai-driver-demo.js) is a runnable demo and
`localDriver()` builds an in-process driver for testing the loop without a browser.

## Run it on your game

copse drives a **running** Cocos game (dev/preview, or a release build where `cc` is
reachable). Three on-ramps:

### 1. CLI — quickest

```bash
npm i copse                 # the bundle ships built (from source: npm run build)
npm i -D puppeteer-core     # browser driver — peer dep, uses your system Chrome

npx copse scan <url>                                  # read-only: print buttons / labels / reachability
npx copse ai   <url> --goal "verify the buy flow clamps gold at 0" \
               [--stop "..."] [--report "..."] [--rounds 3] [--model sonnet] \
               [--verbose] [-o <folder>] [--headed] [--fps 30]
```

**Watch it run:** add `--headed` for a visible browser window (default is headless), and
`--fps 30` to raise the fps cap (default 10) so it's smooth. Headed uses the real GPU —
actually *cooler* than headless software WebGL. Note: copse calls handlers directly, so you
see the game *react* (panels open, reels action, numbers change) — not a moving cursor or a
button-press animation. Or `--browser-url http://127.0.0.1:9222` to drive **your own** Chrome
(launched with `--remote-debugging-port=9222`) and watch it there.

`ai` runs the AI loop (plan → press/get → judge → report) via the `claude -p` CLI
(needs it logged in); `scan` is one-shot discovery. `--verbose` prints untruncated step
results; `-o <folder>` appends the run log to `<folder>/<cmd>.log`; the run ends with a
`cost: $… | N claude -p calls` line (from each call's `total_cost_usd`). (Local dev:
`node bin/copse.js …`.)

### 2. Library — programmatic / CI

The core is zero-dep; the browser + LLM edges are optional subpaths:

```js
import { runHarness } from 'copse';
import { connect } from 'copse/driver-puppeteer';     // peer dep: puppeteer-core
import { makeClaudeAgent } from 'copse/agent-claude';  // needs the `claude` CLI

const cp = await connect('http://localhost:7456/');     // launch browser + inject → Driver
const agent = makeClaudeAgent({ goal: 'open the shop and confirm gold decrements on buy' });
const report = await runHarness(cp, agent, { context: { goal: '…' }, maxRounds: 3 });
console.log(report.pass, report.summary);
await cp.close();
```

Both `cp` and `agent` are just adapters — swap `connect` for a Playwright driver, or
`makeClaudeAgent` for an Anthropic-SDK / deterministic agent. For a **deterministic**
(no-LLM) test, skip the agent and assert against `cp` directly (`cp.press`/`cp.get`/
`cp.diff`/`cp.reachable`). See [`examples/ai-driver.md`](examples/ai-driver.md).

### 3. Manual — no install

Paste `dist/copse.inject.js` (after `npm run build`) into the game's DevTools console
and call `__copse.*` by hand — or inject via Playwright `addInitScript` / a dev-build
hook. See [`examples/inject.md`](examples/inject.md).

## Develop

```bash
npm test          # node:test over a fake tree — no engine, no install
npm run typecheck # tsc --noEmit (needs `npm install` for the dev deps)
npm run build     # bundle src/cocos/inject.js → dist/copse.inject.js (one self-contained IIFE)
```

How the design got here — decisions, pitfalls, real-game findings — is in
[`DEVELOPMENT.md`](DEVELOPMENT.md).

## License

MIT
