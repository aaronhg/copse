# copse

Drive and assert a **running Cocos or PixiJS canvas game** through its **live node tree** —
no pixels, no input simulation. You walk the live scene (`cc.director.getScene()`),
find the buttons / registered events, and **call their handlers directly**, then
read component state back to check what happened.

It's the **runtime sibling to [coir](https://github.com/aaronhg/coir)**: coir reads
a project's *static* asset/dependency graph; copse reads the *running* scene's live
UI tree. Both turn an opaque engine internal (Cocos, or PixiJS 8) into structured data an AI
(or a test) can query — and both speak the **same selector grammar** (`Parent/Child:Comp.prop`,
`[i]` to disambiguate same-name siblings).

And copse is the deterministic layer **under arbor**: copse is the runtime driver + primitives +
`execute` — it reports **facts**, with no LLM, no loop, no verdict. **arbor** is the AI-QA
framework on top that owns the plan→execute→judge loop, the pass/fail verdict + veto, the
coir×copse coverage join, test selection, and capability-based branching — and it drives copse's
`execute`.

> Status: **working.** Pure engine-blind core + Cocos/PixiJS adapters + a deterministic flow
> executor (`execute`) + CLI/library/**MCP** entry, verified end-to-end on a **dev/preview build**:
> snapshot, `press → get` state round-trips (a state-delta mutation), reachability, panel
> open/close detection, and `execute` driving a panel open+close and reporting the facts — plus
> driving the running game natively from Claude Code over MCP.

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
  after an action (e.g. press a panel button → its block opens).
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
  `BlockInputEvents` / a later-drawn panel (`blockedBy`), via a geometric hitTest with
  cross-camera/Layer z-order (camera priority → sibling-index). A separate `visible` flag
  (`opacity/scale!==0`) catches opacity/scale-hidden buttons. But `reachable` answers "would a
  **touch** reach it" — a button covered by an opaque *sprite* (no input-consumer on top) still
  reads `reachable:true` (that's pixels, not the logic tree). Not a substitute for a real playtest.
- **Timing / animation / feel**, **physics / gameplay**, **audio**, and any state not
  exposed on a component (closures, locals).
- **What a button does** is opaque at runtime (you press and observe a state delta) —
  coir's *static* ClickEvent map (`click→method()`) is the complement if you want that.
  copse exposes its side of the shared key `(nodePath, method)` — `clickSurface()` (runtime
  click surface, Cocos-only) / the `click_surface` MCP tool, plus `tailMatch` and
  `resolveCoirPath`/`resolveCopseRef` to line up the two grammars; the coir×copse coverage
  **join** that consumes them lives in **arbor**.

→ Use copse for **logic/flow integration testing**, not visual or playtest QA.

## API

The pure core (`src/core/`) operates over a tiny `Runtime` adapter, so it's
testable in Node against a fake tree. `src/cocos/runtime.js` is the Cocos `cc.*` adapter
+ `install(cc)`, which exposes the bridge as `window.__copse`:

```js
__copse.snapshot()                 // slim: [{ ref, active?(only false), button?, interactable?, click?, label?, codeHandlers? }]
__copse.snapshot({ relevant:true })  // only nodes with a testable surface (button|label|codeHandlers); {components:true} adds raw types
__copse.interactive()              // buttons only, WITH reachable/blockedBy + visible:false (opacity/scale hidden)
__copse.press('Canvas/ShopBtn')    // run its clickEvents + emit CLICK → { ok, ref, fired }
__copse.press('Canvas/BuyBtn', { force: true })   // ignore interactable
__copse.get('Canvas/Score:Label.string')          // { ok, value }
__copse.call('Canvas/Mgr:ShopController.buy', 30)  // invoke any method → { ok, value }
__copse.reachable('Canvas/ShopBtn')  // { ok, reachable:true|false|'unsure', reachableFraction, partial?, blockedBy, occludedBy?, visible, via:{consumer,camera} } — centre-primary z-order
__copse.node('Canvas/Panel')                      // node intrinsics → { active, activeInHierarchy, opacity, scale, worldPos, size }
__copse.diff(before, after)                        // → { appeared, activated, deactivated (node descriptors), labelChanged, ... }
__copse.listeners('Canvas/ShopBtn')               // user node.on() handlers (best-effort; see caveat)
__copse.probe()                                    // engine-coupling self-diagnostic → { version, classes, reach, events, touch } — which version-sensitive internals resolve on THIS build
__copse.logs()                                     // captured console.* + uncaught errors → [{level,text,t,stack?}]
```

To check a panel opened ("press a panel button → its block appears"): `snapshot({includeInactive:true})`
→ press → `snapshot` → `diff` — the panel's subtree turns up in `activated`/`appeared`.

Addressing matches coir: `Parent/Child` node paths, `[i]` for same-name siblings,
`path:Comp.member`. Paths are relative to the scene root; `#N` absolute indices are
unsupported (no stable index in a live tree).

## Test scripts — freeze a flow, replay in CI

A **script** is a frozen test flow: JSON steps (the same `{op, ref/sel, …}` shape `execute`
runs) plus `expect` subset-match assertions — replayed deterministically, **zero LLM**.
Explore once (a Claude Code MCP session, or arbor's AI loop over `execute`), freeze, replay
forever — the exploration loop lives in arbor; the deterministic frozen-script replay is
copse's own `copse run`:

```bash
copse run <url> tests/shop-open-close.json     # exit 0 pass / 1 fail — CI-ready
copse run <url> tests/                         # a directory: every *.json as a suite → JUnit + exit 0/1
# over MCP: run_script({script}); the session auto-records — dump_script() exports
# every press/get/call made so far as a script skeleton to trim into expects
```

Steps with no `expect` still fail on facts: `ok:false`, a handler that threw/logged an
error, a press that actuated nothing. Format, match semantics, and the
explore→dump→trim→replay workflow: [`docs/SCRIPTS.md`](docs/SCRIPTS.md).

## Flow executor — `execute` (facts, no verdict)

`execute(driver, steps, opts?) → { steps, facts }` is the deterministic layer on top of the
primitives: it runs a step list against the live-page driver and reports **facts** —
`facts.unreachable / errored / undriven / uncertain / visual` (`extractFacts(steps)` is that same
bucketing as a pure function over a step list). **No agent, no loop, no pass/fail verdict** — a
press to a covered button, a handler that threw, a press that drove nothing are all reported as
*facts*; whether any of them *fails* a run is the consumer's call. `opts` are fact-gathering
toggles only — `{ reachableGate, visualGate, visualMax }` — never a verdict.

```js
import { execute } from 'copse';                       // also exported from 'copse/harness'
const { steps, facts } = await execute(driver, [
  { op: 'press', ref: 'Canvas/ShopBtn' },
  { op: 'get',   sel: 'Canvas/Gold:Label.string' },
]);
if (facts.unreachable.length || facts.errored.length) { /* your policy decides */ }
```

The **plan→execute→judge loop, the pass/fail verdict + veto, capability-based branching, and the
coir×copse coverage join + test selection all live in arbor** — the AI-QA framework that sits on
top and *drives* `execute`. copse stays deterministic and LLM-free. `localDriver()` builds an
in-process driver to exercise `execute` against a fake tree with no browser, and each run's
`steps` are already the `{op, ref/sel, …}` a script freezes (docs/SCRIPTS.md).

## Run it on your game

Point copse at **your own** running Cocos (or PixiJS 8) game — a dev/preview build (where the
engine is always reachable) or a release build of your own where it still is. Four on-ramps below; the debugger
edge is separate — see [**Beyond testing**](#beyond-testing--one-cdp-attach-another-lens).

### 1. CLI — quickest

```bash
npm i copse                 # the bundle ships built (from source: npm run build)
npm i -D puppeteer-core     # browser driver — peer dep, uses your system Chrome

npx copse scan <url>                                  # read-only: print buttons / labels / reachability
npx copse scan <url> --engine pixi                    # same on a PixiJS 8 build (default engine cocos; docs/ENGINES.md)

# one-shot primitives — connect, run one op, print JSON, close (pipe to jq, use in shell scripts):
npx copse get   <url> Canvas/Score:Label.string       # read a member  → {ok,value}
npx copse press <url> Canvas/ShopBtn [--force] [--reachable-gate]  # press a button → {ok,fired,changed?}; --reachable-gate refuses a covered one
npx copse call  <url> Canvas/Mgr:Shop.buy 30           # invoke a method (arg JSON-parsed) → {ok,value,changed?}; missing method → {ok:false,reason:'no-method'}
npx copse node  <url> Canvas/Panel                     # node intrinsics; copse reachable <url> <ref> for reachability
npx copse run   <url> tests/shop.json                  # replay a frozen test script → JSON; exit 0/1 (docs/SCRIPTS.md)
```

(`copse --version` prints the version; `copse --help` lists everything.)

**Watch it run:** add `--headed` for a visible browser window (default is headless), and
`--fps 30` to raise the fps cap (default 10) so it's smooth. Headed uses the real GPU —
actually *cooler* than headless software WebGL. Note: copse calls handlers directly, so you
see the game *react* (panels open, sprites move, numbers change) — not a moving cursor or a
button-press animation. Or `--browser-url http://127.0.0.1:9222` to drive **your own** Chrome
(launched with `--remote-debugging-port=9222`) and watch it there.

`scan` is one-shot discovery; the one-shot primitives connect, run a single op, and print JSON.
`--verbose` prints untruncated step results; `-o <folder>` appends the run log to
`<folder>/<cmd>.log`. (Local dev: `node src/cli.js …`.) The AI loop that plans and judges these
ops is arbor's — it's not a copse CLI verb.

### 2. MCP — drive the canvas from any agent

`copse mcp` exposes the bridge as **MCP tools** (`connect`/`snapshot`/`press`/`get`/`call`/`diff`/
`listeners`/…) over stdio, so **Claude Code**, a plain Anthropic tool-use loop, **browser-use**,
Stagehand or Cursor becomes the brain while copse stays the eyes + hands into the canvas. The MCP
tool names match the library 1:1 (including `connect`), so the two surfaces read the same:

```bash
claude mcp add copse -- npx copse mcp        # then: "Use copse: connect <url>, test a panel window"
```

The default tool set is the 17 testing primitives. The CDP **debugger** tools are **hidden from the
tool list by default** (a dev-build aid — pausing the runtime only makes sense on a build you own);
start with `copse mcp --debug` to surface them (see [Beyond testing](#beyond-testing--one-cdp-attach-another-lens)).

The valuable part of copse is the bridge; the agent loop is replaceable — borrow a good one. (Existing
browser agents can't help here on their own: a Cocos game is one opaque `<canvas>` to the DOM.) See
[`docs/MCP.md`](docs/MCP.md).

**Your game behind a login or staging gate**: when the build you want to test sits behind auth
(or an environment that a fresh headless launch can't reach), don't have copse launch the browser —
open the game in **your own** Chrome (`--remote-debugging-port=9222`), sign in / navigate to it
yourself, then register a plain `copse mcp` and **attach** to that tab without navigating: the agent
calls `connect({attach:true, browserURL:"http://127.0.0.1:9222", match:"<url-substr>"})` (CLI:
`--attach --browser-url --match`). copse drives the already-open tab as-is; it never touches how you
got there. (It drives **Cocos**, or a **PixiJS 8** build with `engine:'pixi'` — see docs/ENGINES.md.)

### 3. Library — programmatic / CI

The core is zero-dep; the browser edge is an optional subpath:

```js
import { execute } from 'copse';                        // deterministic flow executor (facts, no verdict)
import { connect } from 'copse/driver-puppeteer';       // peer dep: puppeteer-core

const cp = await connect('http://localhost:7456/', { engine: 'auto' });  // launch browser + inject → Driver
const { facts } = await execute(cp, [
  { op: 'press', ref: 'Canvas/ShopBtn' },
  { op: 'get',   sel: 'Canvas/Gold:Label.string' },
]);
console.log(facts.unreachable, facts.errored, facts.undriven);  // FACTS — your policy decides pass/fail
await cp.close();
```

`cp` is a driver adapter — swap `connect` for a Playwright driver. For a **deterministic**
(no-LLM) test, read `facts` (or assert against `cp` directly: `cp.press`/`cp.get`/`cp.diff`/
`cp.reachable`). The full plan→judge loop, the verdict + veto, and capability-based branching
live in **arbor**, which drives this `execute`. The driver session also exposes a `.capabilities`
getter (`{engine, clickSurface, stableRefs, reachability, visualManifest}`; `engineCapabilities(engine)`
is the same as a pure call) so a consumer can branch on what the current engine supports.

### 4. Manual — no install

Paste `dist/copse.inject.js` (after `npm run build`) into the game's DevTools console
and call `__copse.*` by hand — or inject via Playwright `addInitScript` / a dev-build
hook. See [`docs/INJECT.md`](docs/INJECT.md). `npm run build` also emits two slimmer
bundles: `dist/copse.inject.lite.js` — the same `press`/`get`/`call` surface with
reachability tree-shaken out (~half the size, a smaller injected surface) for a
`press`-only caller — and `dist/copse.inject.probe.js` — a read+drive load-metrics
surface (`probe`/`firstClickable`/`find`/`interactive`/`reachable`/`press` + `assetsPending`)
that keeps reachability but drops snapshot-extras/`get`/`call`/`diff`/`logs`, for timing a
game's load (first-interactive / assets-idle) and driving past the intro.

## Beyond testing — one CDP attach, another lens

Testing is copse's flagship use, but the way it gets there is **one CDP attach to a running Cocos
game**. That same connection exposes one more CDP domain that's *independent of the logic core* (it
doesn't need `cc`) — a handy adjacent tool, deliberately kept off the main testing path:

### Breakpoints + call stack — CDP **Debugger**

For your **own dev build**, `copse/debug` (and the MCP debugger tools, on by default) set breakpoints over the CDP
Debugger domain: `break_in Canvas/Mgr:ShopController.buy` breaks a component method **by copse selector**
(resolved to the function, so it works minified) — trigger it, then read the call stack + locals
(`wait_pause`/`eval_frame`/`debug_step`). It's a **dev-build** aid — pausing the runtime is intrusive
enough that it only makes sense on a build you own and control. See [`docs/DEBUG.md`](docs/DEBUG.md).

## Develop

```bash
npm test          # node:test over fake trees — no engine, no install, no browser (excludes the L2 tier)
npm run test:l2   # L2 only: needs a real engine (reference/cocos/<ver> cloned) or a real Chrome; self-skips without one
npm run test:all  # both tiers
npm run typecheck # tsc --noEmit (needs `npm install` for the dev deps)
npm run build     # → dist/copse.inject.js (full) + .lite.js (press-only, no reachability) + .probe.js (load-metrics) + .pixi.js (PixiJS 8); all self-contained IIFEs
```

How the design got here — decisions, pitfalls, real-game findings — is in
[`DEVELOPMENT.md`](DEVELOPMENT.md).

## License

MIT
