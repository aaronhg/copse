# Development History — Runtime Cocos UI Driver / AI Tester

This document records the development history of **copse**: how the requirements evolved,
what technical decisions were made, what pitfalls we hit, and where the design eventually
landed. It is the **runtime sibling to [coir](https://github.com/aaronhg/coir)** — coir reads
a project's *static* asset graph; copse drives the *running* scene's live UI tree. Both turn
an opaque Cocos internal into structured data an AI (or a test) can query, and both share the
selector grammar `Parent/Child:Comp.prop` + `[i]`.

---

## 0. The Goal in One Sentence

Drive and assert a **running Cocos Creator canvas game** through its **live node tree**
(`cc.director.getScene()`) — **no pixels, no input simulation**: find the buttons / wired
events and **call their handlers directly** (serialized `clickEvents` via `EventHandler.emit`
+ an emitted `CLICK` for code-registered listeners), then read component state back to assert.
In effect, integration/flow testing of the game's logic layer through the live object graph —
fast, deterministic, no GPU.

The originating idea is `../aaron/canvas-ai-testing-plan.md` ("make AI see into the canvas",
inspired by gstack's `/qa`). copse is the **runtime-pure-logic** route from it — see §16 for
how the realisation diverged from that plan.

---

## 1. Starting Point (the MVP)

The project began as a validated scaffold: a pure core (`snapshot`/`resolve`/`press`/`get`/
`call`) over a minimal `Runtime` adapter, a Cocos `cc.*` adapter, an inject bridge, and 8
`node:test` cases over a fake tree. It had been proven once end-to-end against a live Cocos
3.8.6 preview (`press('…/Button')` → `{ok:true, fired:1}`). Everything below is the path from
that scaffold to a packaged tool that AI-drives **real, remote** games.

---

## 2. Architecture: Decouple the Core (copse's `Runtime` = coir's `FileProvider`)

The one load-bearing decision, mirroring coir: **the logic is decoupled from the engine through
a minimal `Runtime` adapter**, so the pure core is testable in Node against plain-object trees.

```
src/core/index.js   snapshot / resolve / press / get / call / reachable / node / diff   ← pure, no engine
src/cocos/          runtime.js (the cc.* adapter + install→window.__copse) + inject.js  ← the ONLY engine layer
src/harness.js      runHarness — the AI loop, pure over a Driver + Agent adapter
src/drivers/        puppeteer.js — optional browser driver (peer dep)
src/agents/         claude.js   — optional claude -p agent (no npm dep)
src/mcp/            server.js + tools.js — optional MCP edge (copse as tools for any agent)
src/cli.js          the CLI (ai / scan / mcp; no bin/ dir, matches coir)
```

The `Runtime` contract is the whole engine surface copse needs (`name`/`children`/`isActive`/
`components`/`getComponent`/`readProp`/`callMethod`/`asButton`/`isInteractable`/`clickHandlers`/
`fireClickHandlers`/`emitClick`, later `codeHandlers`/`reachable`/`nodeInfo`). Tests implement it
over fake objects; `cocosRuntime(cc)` implements it over `cc.*`.

---

## 3. The Bridge: Injected JS, Not a JSON Endpoint

The originating plan favoured a **JSON HTTP endpoint** in a debug build. copse went the other
way: an **injected JS bridge**. `install(cc)` walks the live tree in-process and exposes
`window.__copse` (`snapshot`/`interactive`/`press`/`get`/`call`/…). Injection is one of: console
paste, Playwright `addInitScript`, or a dev-build hook. Consequences:

- No HTTP server, **no production endpoint to secure** (nothing is left running; it's injected at
  test time).
- Same *data source* the plan wanted (`cc.director.getScene()`), different *transport*.
- The biggest divergence is the **drive mechanism** (§16): copse calls handlers directly, so the
  plan's hardest open question — **coordinate mapping** (CSS≠logical, DPR, camera) — never arises.

---

## 4. The Build Step (`dist/copse.inject.js`)

To make injection one self-contained file (instead of stripping ESM on the fly), `src/cocos/
inject.js` is an **auto-installing entry**: it exposes `globalThis.copse` and polls for `cc`,
calling `install(cc)` as soon as the engine boots (so it survives `addInitScript`, which runs
*before* boot). `npm run build` = esbuild → a 6.5KB IIFE.

| Decision | Rationale |
|---|---|
| esbuild as a **devDep**, output an IIFE | One self-contained blob; runtime stays zero-dep |
| Inject entry imports only the **in-page** surface (not the barrel) | `runHarness`/drivers run Node-side; no reason to ship them in the page blob |
| Auto-install on a `cc` poll (~10s) | Works for console paste *and* pre-boot `addInitScript` |

Verified by eval-ing the built bundle against a real-`cc`-shaped fake: `__copse` auto-installs,
`snapshot`/`get`/`press`/`call` round-trip.

> Aside: the pure-core file was renamed `copse.js` → `core.js` (a classification name; the project
> already called it "the pure core"), and later moved to `src/core/index.js` in the §13 reorg.

---

## 5. The AI-Driver Harness (`runHarness`)

The autonomous loop, **pure and zero-dep**, decoupled through two adapters so the whole thing is
testable in Node against fakes; the real Playwright wiring and the real LLM call live only at the
adapter edges. The AI intervention points are literal adapter methods:

```
agent.plan(ctx)   → AI ①  read diff + live snapshot → what to test + the EXPECTED outcome (oracle) → steps
driver.<op>(...)  → 機械   press / get / call against the live page (deterministic copse rail)
agent.judge(ctx)  → AI ②  state delta vs expectation → pass / fail
agent.next(ctx)   → AI ③  coverage / iterate decision (optional; absent ⇒ stop after one round)
agent.report(ctx) → AI ④  shape the final report in your format (optional; → report.summary)
```

One round = **one plan → execute its steps → judge** (+ a `next` decision). A plan can hold many
steps. `report` runs once after all rounds. Key design points:

- **Policy-free**: the agent decides *what* and *whether*; the harness only sequences, captures
  every result, bounds the rounds. A throwing step is captured `{ok:false, reason:'threw'}`, not fatal.
- **Prompt-agnostic**: `opts.context` is passed verbatim to every stage, so per-run guidance (goal
  / stop condition / report format) rides there; static guidance is baked into the agent via a factory.
- `localDriver(scene, rt)` builds a Driver over an in-process tree — the same shape `runHarness`
  wants — so the loop is unit-tested with a fake driver + a deterministic agent.

---

## 6. Two Agent Backends (SDK + `claude -p`)

The agent is an adapter, so it has two backends: the **Anthropic SDK** (`claude-opus-4-8`,
adaptive thinking, `output_config.format` schema), and the **`claude -p` CLI** — which needs **no
npm dependency** (uses the local Claude Code login) and matches gstack's `skill-e2e` "spawn
`claude -p` → LLM judge → assertion" pattern. Empirical notes when wiring `claude -p`:

- Reads the prompt from **stdin** (large snapshots need no shell escaping); `--output-format json`
  returns an envelope whose `.result` is the model text.
- The model sometimes wraps JSON in ```` ```json ```` fences → the adapter strips fences before parse.

---

## 7. Driving Real Games

The validation that mattered: drive **real** games via system Chrome (puppeteer-core over CDP,
kept as a throwaway driver outside the repo until §13 packaged it). Three games, escalating:

| Game | Finding |
|---|---|
| a web-mobile release build | `cc` **reachable on a release build** (`window.cc` present) — contradicting the documented "released builds tree-shake cc". Q'd 62 nodes; `press('…/btn_panel')` fired `PanelUI.show`. |
| a remote slot | A real **`press → get` state round-trip through real handler logic**: `press(action)` → balance `1,000,000 → 999,700` (−300 = the amount). Win-rollup timing nuance: the `wins` label updates at result time but the **balance credit lags** → assert on the result label, not balance. |
| a second remote slot | The buy-feature saga (§17) — open/close verified end-to-end via the AI loop. |

Two pitfalls surfaced here that shaped later design:

- **Headless WebGL is hot.** Headless Chrome renders the game via SwiftShader (software WebGL) at
  ~60fps for the whole multi-minute run → it cooks the machine. Mitigation evolved (§12): fps cap,
  and originally `cc.game.pause()` during idle — but **pausing freezes a game still loading from a
  Loader scene** (a paused director won't run scene transitions / tweens), so it became **fps-cap only**.
- **Release builds minify component class names** (`constructor.name` → `e`/`n`/`t`), so the
  snapshot's raw `components` are noise — but **serialized ClickEvent handler names survive**
  (`ShopUI.openShop`, `SlotUI.action`), because they're serialized *data*,
  not class identifiers. `getComponent('Label')` and `@ccclass` names still resolve.

---

## 8. Reachability — the Headline Caveat, Made Checkable (probe first)

copse's headline caveat was "**calling a handler ≠ a player reaching the button**": a button
covered by an overlay / `BlockInputEvents` / a later-drawn panel **passes** here but fails for a
real player. We turned this from "can't test" into "best-effort checkable".

Mechanism (engine-coupled, `runtime.js`): the node's world-bbox centre → `camera.worldToScreen`
→ a screen point; walk all active input-consumers (Button / `BlockInputEvents`), `UITransform.
hitTest(point)`; resolve the **top-most** by a draw-order key (sibling-index path, lexicographic);
if the top hit isn't the node (or an ancestor/descendant), it's **blocked** → report `blockedBy`.

**We verified the engine internals on the real build before shipping** — a separate throwaway
probe confirmed: `UITransform.hitTest` works with `worldToScreen` points; `cc.BlockInputEvents`
exists; the draw-order heuristic resolves the real case. Result on web-mobile: `btn_open`
`reachable:true` on Home, then `reachable:false, blockedBy:"Canvas/Popup/mask"` once a panel
opened. Caveats kept honest: it's a geometric heuristic — treat `reachable:false` as a strong signal, not gospel.

**Later upgraded (a multi-camera real slot forced it):** the draw-order key became `[camera priority,
…sibling-index]` — `camOf(node)` picks the node's rendering camera (visibility-mask ∩ `node.layer`, top
`priority`) and projects with *that* camera, not always `cams[0]`; so it resolves **cross-camera/Layer
z-order**. A two-agent review then caught a wrong turn: an opacity filter I'd added to skip transparent
blockers — but **input ignores opacity** (a transparent `BlockInputEvents` still swallows touches), so it
was reverted. The lasting lesson: `reachable` answers "would a **touch** reach it", NOT "is it visible".
A button covered by an opaque *sprite* (no input-consumer on top) is still `reachable:true` — that's
pixels, outside the logic tree. So a **separate** `visible` signal (`opacity/scale===0` up the chain,
exact-zero, never folded into the reachable boolean) was added for opacity/scale-hidden buttons; combine
`reachable && visible`. Opaque-sprite visual occlusion remains out of reach (it needs render-order pixel
analysis — pixels, not the logic tree).

---

## 9. Code-Registered Handlers (`codeHandlers` / `listeners` / `hijack`)

Buttons don't always wire via serialized `clickEvents` — many register in code with
`node.on(CLICK, …)`. Two complementary readers:

- **`codeHandlers(node)`** reads the engine's `NodeEventProcessor` (`_eventProcessor` → capturing/
  bubbling `CallbacksInvoker._callbackTable`), filtering out engine-internal events + cc.Button's
  own touch listeners → only user handlers remain. Works retroactively (reads current state).
- **`hijack(cc)`** monkey-patches `Node.prototype.on` ("先過 inject 的 on,再往下拋") into a
  `WeakMap` registry — captures registrations live, but **only those made after install** (so it
  needs pre-boot injection to catch scene-load wiring).

Probe finding (and a corrected assumption): on the slot, the `click:[]` buttons turned out to be
**genuinely unwired** (only the Button's own touch listeners), not secretly code-registered.
`press` covers `on('click')` via the emitted CLICK, and now also **synthesizes a `TOUCH_START`→`END`
tap** (`rt.emitTouch`, called only when no serialized clickEvent fired) so touch-wired buttons — common
in real-money slots — actuate too. `EventTouch` is resolved across shapes (`cc.EventTouch` /
`cc.Event.EventTouch` / `cc.internal`) for minified builds; `press` returns `touched:true` when it took that path.

---

## 10. Node Intrinsics + `diff` — Panel Open/Close Detection

"Press mainfeature → its window opens" is the UI **state-machine** dimension, which buttons+labels
alone don't cover. Two additions:

- **`node(ref)`** → node intrinsics `{active, activeInHierarchy, opacity, scale, worldPos, size}`
  (the state `get`/`snapshot` didn't expose). Plus `get('path:Node.active')` via a `Node`
  pseudo-component.
- **`diff(before, after)`** → `{appeared, disappeared, activated, deactivated, labelChanged}`. The
  general way to judge a transition: snapshot, act, snapshot, diff — the panel's subtree shows up in
  `activated`/`appeared`. Verified on the slot menu: pressing the menu toggle put **21 menu nodes**
  in `diff.activated`; `reachable(menu item)` flipped `false → true`.

A usage lesson: `node()` on an always-active *container* shows nothing; `diff()` scans the whole
tree and **finds the toggled subtree automatically** — so for "did X open", `diff` is the robust tool.

---

## 11. Snapshot Slimming (A + B)

Real trees are huge (a slot Q'd **516 nodes**, mostly spine/fbx bones) and the descriptors were
verbose, so a verbose run logged 368KB. Slimmed two ways:

- **A — filter noise**: `snapshot({relevant:true})` keeps only nodes with a testable surface
  (button | label | codeHandlers) → 396 → ~30.
- **B — trim fields**: drop `name` (= ref tail), omit `active` when true, make raw `components`
  **opt-in** (`{components:true}` — minified noise on release), drop empty `click` target/data, omit
  `blockedBy` when not blocked.

Coupling caught: with `active:true` omitted, `diff` had to switch to `active !== false` semantics so
inactive→active still registers as `activated`.

---

## 12. Settle + Auto-Delta (timing / tweens / ergonomics)

Two related questions drove this:

- **Q3 — no wait between steps?** Steps ran back-to-back; only a fixed `sleep(1500)` after `press`.
  For a tween / scene transition the next read sees an unsettled tree. → **wait-until-stable**: after
  a mutating action, poll the tree's **structural signature** (refs + active + interactable, *ignoring
  ticking label text* like clocks/timers) until two reads match, bounded by 3s. Fast for instant
  changes, exactly long enough for tweens. Replaces the fixed sleep; `{settle:false}` to disable.
- **Q2 — must the agent manage snapshots?** `diff` needs two snapshots; making the agent do
  `snapshot→press→snapshot→diff` by hand is clunky and bloats the log. → **auto-delta**: `press`/
  `call` capture a `relevant` snapshot before/after (around settle) and attach a `changed` summary to
  the result. Then **descriptor-rich `changed`**: `appeared`/`activated`/… carry the node descriptors
  (ref + label/button/click), so opening a panel hands you its contents directly — no follow-up
  snapshot to read labels.

So a mutating step is now `press → settle → auto-diff → {…, changed}`. The `snapshot` step didn't
disappear — its role narrowed to **initial discovery / reading values**; *detecting an action's
effect* became the delta.

---

## 13. Packaging: Library + CLI (core stays zero-dep)

To make it a usable tool for outside users without polluting the zero-dep core:

- **Core `copse`**: zero runtime deps; exports `runHarness`/`snapshot`/… + ships `dist/copse.inject.js`.
- **Optional subpaths**: `copse/driver-puppeteer` (`connect(url)` → a Driver; **peerDep** puppeteer-
  core, system Chrome) and `copse/agent-claude` (`makeClaudeAgent({goal,stopCondition,reportFormat})`
  → an Agent over the `claude -p` CLI, **no npm dep**).
- **Thin CLI** `src/cli.js` (registered as `copse`; see §14a): `copse ai <url> --goal "…"` /
  `copse scan <url>` / `copse mcp [url]`, plus `--verbose` and `-o <folder>` (**append** the run log).
  Later grew **single-shot** verbs — `copse get|press|call|node|reachable <url> <sel>` (connect → one
  primitive → JSON → close, for shell/jq), and `--version`.
- `puppeteer-core` is a **peerDependency (optional)** + devDep; a `prepare` script builds the bundle;
  `files` ships `src`/`dist`.

`connect()` is the boot rig (launch system Chrome → inject → return a Driver); it waits for `cc` +
a UI scene (some interactive buttons present) before returning, fps-capped (§7/§12).

---

## 14. Directory Layout

Reorganised by concern: the pure core under `src/core/` (file = `index.js`, not the redundant
`core/core.js`); the engine layer under `src/cocos/`; optional edges under `src/drivers/`,
`src/agents/` and `src/mcp/`; `src/harness.js`, `src/index.js` (the public barrel) and `src/cli.js`
(the CLI) at the top. Public import paths are unchanged (the `exports` map preserves `copse` /
`copse/driver-puppeteer` / `copse/agent-claude`); only internal file locations moved.

## 14a. copse-MCP — the bridge as tools for any agent

The realisation (validated by the comparison work) that **copse's value is the inject/bridge, not
its harness**: the harness is a generic plan/judge loop; mature agent loops (browser-use, Stagehand,
Claude Code) are smarter. But those are all **DOM/vision-based → blind to a Cocos `<canvas>`**. So the
high-leverage move is to **decouple the bridge from the brain**: expose copse's surface as **MCP tools**
and let any MCP client drive it. `copse mcp` then makes Claude Code itself (or browser-use, Stagehand, a
plain tool-use loop) the harness — no need to grow copse's own loop.

- **Hand-rolled, mirroring coir** (chosen over the official SDK to keep zero new deps): `src/mcp/server.js`
  is JSON-RPC 2.0 over stdio (newline-delimited), `PROTOCOL_VERSION 2025-06-18`, all logging forced to
  **stderr** (stdout is the protocol channel — puppeteer / the inject bundle / a chatty page must not
  corrupt it), a **serialized** handler chain (two browser ops never overlap), and `createDispatcher(state)`
  split out so the protocol is unit-testable without a browser. `src/mcp/tools.js` is the registry — the
  **14 testing primitives** (`open`/`snapshot`/`interactive`/`press`/`get`/`call`/`reachable`/`node`/
  `diff`/`listeners`/`hijack`/`captured`/`logs`/`close`) over a live `connect()` session in `state.cp`
  (`press`/`call` carry the auto-`changed` delta straight through), plus **7 `debug:true`-tagged Debugger
  tools** (`break_*`/`wait_pause`/`eval_frame`/`debug_step`/`clear_breakpoints`, §18) that are **hidden
  from `tools/list` unless `copse mcp --debug`** (dev-build-only; pausing trips anti-debug). `connect` also
  takes **`attach`/`match`** to drive an already-open tab (Cloudflare/login sites a human got past) — no
  navigation, so the gate isn't re-triggered.
- **Layout aligned to coir at the same time**: no `bin/` dir — the CLI moved to `src/cli.js` (`bin:
  {"copse":"src/cli.js"}`), MCP is the `copse mcp [url]` subcommand (lazy `import('./mcp/server.js')`),
  and the heavy/optional imports (puppeteer driver, claude agent) became **lazy per-command** so
  `copse --help` / `copse mcp` don't require puppeteer-core. Only `dist/copse.inject.js` is ever built;
  everything else (cli, mcp, core) runs as raw ESM.
- **Tested** over a fake Driver (`test/mcp.test.js`): `initialize` / `tools/list` / `tools/call` dispatch,
  arg mapping (`force`, `call` arg-spread, `snapshot` defaulting `relevant:true`), unknown-tool and
  no-session errors, `close` teardown, notification = no-reply.
- **Verified end-to-end driving a live slot game natively from Claude Code** (registered via a project
  `.mcp.json`): Claude called `open` → `press` (dismiss start page, `changed.disappeared`) → `interactive`
  (**saw the BUY FEATURE toggle was still `interactable:false`, waited until it enabled** — the adaptive
  move a blind script can't make) → `press` boost (panel open, `changed.appeared` = title/costs/close) →
  `press` close (`changed.disappeared`) → `close`. The payoff of the whole design: **Claude itself is the
  harness, copse the eyes+hands, no browser-use.** See `docs/MCP.md`.
- **Pitfall (config write-back race)**: adding the server to `~/.claude.json` via `claude mcp add` while a
  session was running got clobbered when that session wrote its in-memory config on exit. Fix: a project
  `.mcp.json` (read fresh at startup, not rewritten by the session) — robust across restarts.

---

## 15. Pitfalls (and Their Fixes)

| Pitfall | Symptom | Fix |
|---|---|---|
| `snapshot(null)` | `Cannot read 'onlyInteractive' of null` | A default param applies only to `undefined`, not `null` → pass `{}` |
| Pause-for-heat freezes loading | Game stuck on the Loader scene | Don't pause a progressively-loading game; **fps-cap only** |
| Minified component names | `components:["e","e"]` | Use ClickEvent handler names (serialised, survive minify); make `components` opt-in |
| `get('…:cc.Label.string')` → no-component | OPEN read failed | The `cc.` prefix didn't resolve in that build; use the bare `Label`. AI also self-corrected |
| Slim shape vs `diff` | activate not detected | Treat omitted `active` as active (`!== false`) in `diff` |
| `Node.prototype.on` hijack timing | misses scene-load handlers | Only captures post-install registrations → pair with `_eventProcessor` introspection; pre-boot inject for full capture |
| `node()` on always-active container | no change seen on open | Use `diff` (scans the tree) instead, or target the actually-toggled node |

---

## 16. Relationship to the Originating Plan

Compared to `canvas-ai-testing-plan.md`:

- **Same thesis, validated**: AI + structured UI data + diff-awareness = autonomous QA; the AI
  decides *what* to test. copse's `plan`/`judge` is exactly this, and it ran on real games.
- **Biggest divergence — handler calls, not coordinate clicks.** The plan's bridge was coordinate-
  based (`canvas-snapshot` with `(x,y)`, `click @ref` → canvas coordinate click) and listed
  coordinate mapping as the hardest open question. copse invokes the wired handler directly → that
  whole problem **dissolves**. The trade-off (a coordinate click naturally fails on a covered button)
  is recovered separately by `reachable()` (§8).
- **Open questions, now answered empirically**: pausing is *harmful* (don't), coordinates are
  *unnecessary*, headless WebGL is *hot but works*, and `cc` can be reachable on a release build.
- **Levels**: L1 (game UI automation) done and exceeded (state round-trips, panel diff, reachability);
  L2 (editor automation), L3 (physics/feel playtesting), L4 (cross-engine) intentionally untouched —
  the plan's "Ocean". copse is the **runtime-pure-logic** realisation: it narrows "see the screen" to
  "see the live logic-layer object tree", trading away visual/physics/feel (the Ocean) for dissolving
  the coordinate/pixel problems entirely.

---

## 17. Worked Example: The Buy-Feature Saga (the loop maturing)

Testing "does the BUY FEATURE window open and close?" took four runs, each failing differently and
each pointing at a real improvement — a good record of why the pieces above exist:

1. **sonnet, 1 round** — the AI pressed the toggle *and* redundantly called its handler ("for
   safety"); a toggle invoked twice = net no-op → false negative. Also the `next` stage **hallucinated**
   a fake success. (→ the toggle-once + "use real results" lessons; report stage stayed honest.)
2. **opus, 1 round** — pressed once (OPEN verified via `changed.appeared`), but the close-button ref
   was **mis-cased** (`MainFeaturePanel` vs `mainFeaturePanel`) → not-found. (→ "copy refs verbatim" prompt.)
3. **opus, 1 round, descriptor-rich `changed` + verbatim prompt** — OPEN cleanly verified with
   contents read straight from `changed`; but the plan **never included a close step** — the close ref
   only exists *after* opening, which a single upfront plan can't reference.
4. **opus, 2 rounds + stop** — **PASS.** Round 0 opens (`changed.appeared` = the `mainFeaturePanel`
   subtree: title "BUY FEATURE", two options with costs) and leaves it open;
   round 1 re-observes, presses the now-visible close button verbatim, and `changed.disappeared`
   confirms CLOSE. No purchase, no hallucination.

The throughline: **open→close is a two-round task by nature** (a later step's target appears only
after an earlier step runs). The multi-round loop isn't decoration — "observe → plan" has to come
around again. Forcing one round was the mistake.

---

## 18. CDP Beyond Runtime — the Debugger Edge

The core uses one CDP domain — **Runtime** (`Runtime.evaluate` to inject + walk
`cc.director.getScene()`). The realisation: the *same* CDP connection can drive other domains for
adjacent jobs that never touch `cc`. copse keeps one such edge:

- **Debugger** → `src/debug.js`: breakpoints + call stack. `breakIn('path:Comp.method')` resolves the
  method via `window.__copse` (the live component) → breaks on call, so it **works on minified builds**
  (never matches source text). iframe-aware (page + iframe/OOPIF targets). Exposed as MCP tools
  `break_*`/`wait_pause`/`eval_frame`/`debug_step`, **hidden unless `copse mcp --debug`** (pausing trips
  anti-debug → dev-build-only).

A **"how loud is each domain" ordering** holds: a passive **Network** read is quietest (below JS), **DOM**
middling, **Runtime / Debugger loudest** — they change the page's own JS-runtime behaviour, which a
hardened page can measure from the inside. copse needs Runtime to read the scene, so it sits at the loud
end. (The Network edge — a passive asset/RPC tap — was split out into the separate **mast** tool.)

---

## 19. Validation Methodology (throughout)

- **Headless tests** (`node:test`, zero deps): **32 cases** over fakes — core (addressing/`[i]`, press
  fire+emit+disabled/force **+ the touch fallback**, get/call, the `Node` pseudo-component, slim shape +
  `relevant`, `reachable`/`node`/`diff` plumbing), the harness loop (plan/execute/judge, throwing-step
  capture, the reachability hard-fail gate, iteration bound, the `report` stage), the MCP JSON-RPC
  dispatcher (`createDispatcher`: tool dispatch, arg-mapping, debug-tool routing, error/teardown), and the
  claude-agent factory shape (no LLM call).
- **Probe-before-ship**: engine internals (`_eventProcessor` field names, `UITransform.hitTest` coord
  space, hijack timing) were verified on the real build with throwaway probes before being written into
  `runtime.js`.
- **Real-game end-to-end**: snapshot/press/get/reachable/node/diff and the full AI loop run against a
  web-mobile build and remote live games; the buy-feature flow PASSes open+close.
- **Build / typecheck**: `npm run build` (esbuild), `npm run typecheck` (`tsc --noEmit`, JSDoc +
  `// @ts-check`; the browser-glue driver opts out — its `page.evaluate` callbacks are browser code).

---

## 23. Conventions

- **Zero runtime deps.** Engine-free pure core (`src/core/`); the `cc.*` coupling lives only in
  `src/cocos/`. The browser driver (`src/drivers/`, puppeteer-core) and LLM agent (`src/agents/`) are
  optional **peer**-dep edges, never runtime deps.
- **Types** via JSDoc + `// @ts-check` (no `.ts`); `tsc --noEmit` with `allowJs`/`checkJs:false`/
  `strict:false` — same posture as coir.
- **Selector grammar shared with coir** — `Parent/Child:Comp.prop` + `[i]`, so the two interoperate.
- Reaching `cc`: build-setting dependent (verified on a web-mobile release build); if `window.cc` is
  missing, try `System.import('cc')` and pass the module to `install(...)`.

---

## 24. To Do

- Optional alpha hit-testing in `reachable` (cross-camera / Layer draw-order is done; opaque-sprite
  visual occlusion stays out of scope — that's pixels, not the logic tree).
- Adaptive re-planning within a round (so result-dependent steps don't always need another round).
- A deterministic `node:test` harness example (assert against `cp` directly) for CI.
- State reset between rounds (reload / close panels) for clean multi-round toggles.

(Done since the initial plan: synthetic `TOUCH_*` tap (§9); the CDP Debugger edge (§18); the
reachability hard-fail gate in the harness. The Network/asset-foraging edge was split into **mast**.)
