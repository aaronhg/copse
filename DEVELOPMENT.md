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

The originating idea is an internal design note ("make AI see into the canvas",
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
src/cocos/          runtime.js (base+lite cc.* adapter + install/installLite) · reachable.js (z-order, full-only → tree-shaken from lite) · probe.js (self-diagnostic) · inject.js/inject-lite.js (build entries)  ← the Cocos engine port
src/harness.js      execute / extractFacts / localDriver — the deterministic FLOW EXECUTOR (facts, no loop/verdict), pure over a Driver adapter
src/drivers/        puppeteer.js — optional browser driver (peer dep)
src/mcp/            server.js + tools.js — optional MCP edge (copse as tools for any agent)
src/cli.js          the CLI (scan / mcp / run; no bin/ dir, matches coir)
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

## 4. The Build Step (`dist/copse.inject{,.lite}.js`)

To make injection one self-contained file (instead of stripping ESM on the fly), `src/cocos/
inject.js` is an **auto-installing entry**: it exposes `globalThis.copse` and polls for `cc`,
calling `install(cc)` as soon as the engine boots (so it survives `addInitScript`, which runs
*before* boot). `npm run build` = esbuild → two IIFEs: `dist/copse.inject.js` (full — the
QA/coverage surface) and `dist/copse.inject.lite.js` (lite — `snapshot`/`press`/`get`/`call`/
`node`/`diff`, with reachability tree-shaken out via a separate `reachable.js` module → ~half the
size + a smaller injected surface, for a `press`-only caller). `__copse.press`/`get`/`call`
are byte-identical across the two.

| Decision | Rationale |
|---|---|
| esbuild as a **devDep**, output an IIFE | One self-contained blob; runtime stays zero-dep |
| Inject entry imports only the **in-page** surface (not the barrel) | `execute`/drivers run Node-side; no reason to ship them in the page blob |
| Auto-install on a `cc` poll (~10s) | Works for console paste *and* pre-boot `addInitScript` |

Verified by eval-ing the built bundle against a real-`cc`-shaped fake: `__copse` auto-installs,
`snapshot`/`get`/`press`/`call` round-trip.

> Aside: the pure-core file was renamed `copse.js` → `core.js` (a classification name; the project
> already called it "the pure core"), and later moved to `src/core/index.js` in the §13 reorg.

---

## 5. The Deterministic Executor (`execute`)

copse ships exactly one AI-testing rail: **`execute(driver, steps, opts?)`** — it runs a step list
against the live page and reports the **FACTS**, and nothing else. **Pure and zero-dep**, decoupled
through a single `Driver` adapter, so the whole thing is testable in Node against fakes; the real
Playwright wiring lives only at the adapter edge.

```
execute(driver, steps)  → runs each step (press / get / call / snapshot / sleep / patch / eval) in order
                          → { steps: [{step, result}], facts }
extractFacts(steps)     → five buckets over the results: unreachable · errored · undriven · uncertain · visual
```

`execute` does **not** plan, loop, or judge, and it never decides pass/fail — a press to a covered
button, a handler that threw, a press that drove nothing are reported as FACTS; whether any of them
fails a run is the **consumer's** call. `reachableGate`/`visualGate` only toggle whether the
reachability / pixel facts are gathered (not a verdict). Key design points:

- **Policy-free**: `execute` only sequences the steps, captures every result (a throwing step is
  captured `{ok:false, reason:'threw'}`, not fatal), and extracts the facts. *What* to test and
  *whether it passed* are the consumer's.
- `localDriver(root, rt)` builds a Driver over an in-process tree — the same shape `execute`
  wants — so it's unit-tested with a fake driver, no engine.

**The boundary.** The autonomous **LOOP** (plan → execute → judge → iterate), the pass/fail
**VERDICT / veto**, and the `claude -p` agent moved to the sibling AI-QA framework **arbor** (its
`runLoop`): arbor plans copse steps, hands them to `execute`, reads back the facts, applies its own
veto, and iterates. copse stays deterministic — driver + primitives + `execute`; arbor is the brain
on top. (§6 below records the two agent backends as they were built, before they moved to arbor.)

---

## 6. Two Agent Backends (SDK + `claude -p`)

> **Moved to arbor.** The agent + both backends below moved to **arbor** with the LOOP (§5); copse no
> longer ships an agent or a `copse/agent-claude` subpath. Kept here as the record of how it was built.

The agent is an adapter, so it has two backends: the **Anthropic SDK** (`claude-opus-4-8`,
adaptive thinking, `output_config.format` schema), and the **`claude -p` CLI** — which needs **no
npm dependency** (uses the local Claude Code login) and matches gstack's `skill-e2e` "spawn
`claude -p` → LLM judge → assertion" pattern. Empirical notes when wiring `claude -p`:

- Reads the prompt from **stdin** (large snapshots need no shell escaping); `--output-format json`
  returns an envelope whose `.result` is the model text.
- The model sometimes wraps JSON in ```` ```json ```` fences → the adapter strips fences before parse.

---

## 7. Driving Games End-to-End

The validation that mattered: drive a running game via system Chrome (puppeteer-core over CDP,
kept as a throwaway driver outside the repo until §13 packaged it), on a dev/preview build where
`cc` is reachable. Escalating checks:

- **snapshot** — walked the live tree, `press('…/btn_panel')` fired the panel's `PanelUI.show`.
- **`press → get` state round-trip** through real handler logic: an action mutated a component
  field, read back off the component. Timing nuance: a directly-set value updates at action time
  while a derived total lags → assert on the direct result, not the lagging total.
- **panel open/close** — the open/close saga (§17), verified end-to-end via the AI loop.

Two pitfalls surfaced here that shaped later design:

- **Headless WebGL is hot.** Headless Chrome renders the game via SwiftShader (software WebGL) at
  ~60fps for the whole multi-minute run → it cooks the machine. Mitigation evolved (§12): fps cap,
  and originally `cc.game.pause()` during idle — but **pausing freezes a game still loading from a
  Loader scene** (a paused director won't run scene transitions / tweens), so it became **fps-cap only**.
- **Release builds minify component class names** (`constructor.name` → `e`/`n`/`t`), so the
  snapshot's raw `components` are noise — but **serialized ClickEvent handler names survive**
  (`ShopUI.openShop`, `MenuUI.toggle`), because they're serialized *data*,
  not class identifiers. `getComponent('Label')` and `@ccclass` names still resolve.

---

## 8. Reachability — the Headline Caveat, Made Checkable (probe first)

copse's headline caveat was "**calling a handler ≠ a player reaching the button**": a button
covered by an overlay / `BlockInputEvents` / a later-drawn panel **passes** here but fails for a
real player. We turned this from "can't test" into "best-effort checkable".

Mechanism (engine-coupled, `runtime.js`), now **Rung 2+3** — replay the engine's own input z-order:
- **Consumer set** (`consumerTier`): the engine's `NodeEventProcessor.shouldHandleEventTouch` (the exact
  pointer-dispatch-list membership — catches a raw `node.on(TOUCH_*)` overlay a class check misses) → a user
  click/touch listener → `Button`/`BlockInputEvents`. **ADDITIVE**: a `false` from the engine getter must NOT
  exclude a `cc.Button` (returning the raw getter value once wrongly dropped a live Button).
- **Order** = `[render-camera priority, …sibling-index]` (resolves cross-camera/Layer). The render camera is
  `batcher2D.getFirstRenderCamera(node)` — ⚠ that returns the low-level render-pipeline camera whose
  `worldToScreen` yields **(0,0)**; map it back to its `cc.Camera` **component** (whose `worldToScreen` is
  correct + is what `hitTest` inverts). `getFirstRenderCamera===null` ⇒ not rendered ⇒ not reachable (no `cams[0]` guess).
- **Sampling**: the node's own rect at multiple points, but the **CENTRE decides** (centre free → reachable,
  a covered corner only flags `partial`+`reachableFraction`; centre covered → blocked). Centre-primary, NOT
  all-points — a button packed among neighbours whose bbox corners overlap them mustn't read a false `partial`.
- **Caps**: feature-probed, never version-branched. ⚠ On a tree-shaken minified build the
  `cc.UITransform`/`Camera` GLOBALS can be `undefined` → `getComponent(undefined)`→null → every node reads
  "no UITransform" → all `'unsure'`. Fix: pass the registered class-NAME string (`cc.X || 'cc.X'`).
- **fail-LOUD**: any can't-judge → `'unsure'`+`reason`, never a confident pass. `via:{consumer,camera}` records
  which detection tier resolved it (cross-version trust).

Verified on a dev/preview build: `btn_open` `reachable:true` on Home, then `reachable:false,
blockedBy:"…/mask"` once a panel opened. The geometry has no real-engine CI, so a fake-cc fixture
(`test/reachable.test.js`) pins the ladder logic — but the camera-component and tree-shake gotchas above only
surface on a **live minified build**. Treat `reachable:false`/`'unsure'` as a strong signal, not gospel.

**Later upgraded (a multi-camera real game forced it):** the draw-order key became `[camera priority,
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

## 9. Code-Registered Handlers (`codeHandlers` / `listeners`)

Buttons don't always wire via serialized `clickEvents` — many register in code with
`node.on(CLICK, …)`. The reader:

- **`codeHandlers(node)`** reads the engine's `NodeEventProcessor` (`_eventProcessor` → capturing/
  bubbling `CallbacksInvoker._callbackTable`), filtering out engine-internal events + cc.Button's
  own touch listeners → only user handlers remain. Works retroactively (reads current state), and its
  `_callbackTable → callbackInfos → {callback,target}` walk is **L2-validated against real engine
  source** (`test/real-engine.l2.test.js` constructs a real `CallbacksInvoker` from a local
  `reference/cocos/<ver>` checkout and asserts copse parses it).

  (A `hijack`/`captured` primitive — patch `Node.prototype.on` to record registrations made *after*
  install — was removed: it overlapped `listeners`/`codeHandlers`, and patching the prototype is
  non-native, tripping the anti-tamper `isNative` guards copse otherwise avoids.)

Probe finding (and a corrected assumption): on the real game, the `click:[]` buttons turned out to be
**genuinely unwired** (only the Button's own touch listeners), not secretly code-registered.
`press` covers `on('click')` via the emitted CLICK, and now also **synthesizes a `TOUCH_START`→`END`
tap** (`rt.emitTouch`, called only when no serialized clickEvent fired) so touch-wired buttons — common
in some games — actuate too. `EventTouch` is resolved across shapes (`cc.EventTouch` /
`cc.Event.EventTouch` / `cc.internal`) for minified builds; `press` returns `touched:true` when it took that path.

---

## 10. Node Intrinsics + `diff` — Panel Open/Close Detection

"Press a panel button → its window opens" is the UI **state-machine** dimension, which buttons+labels
alone don't cover. Two additions:

- **`node(ref)`** → node intrinsics `{active, activeInHierarchy, opacity, scale, worldPos, size}`
  (the state `get`/`snapshot` didn't expose). Plus `get('path:Node.active')` via a `Node`
  pseudo-component.
- **`diff(before, after)`** → `{appeared, disappeared, activated, deactivated, labelChanged}`. The
  general way to judge a transition: snapshot, act, snapshot, diff — the panel's subtree shows up in
  `activated`/`appeared`. Verified on a real game's menu: pressing the menu toggle put **21 menu nodes**
  in `diff.activated`; `reachable(menu item)` flipped `false → true`.

A usage lesson: `node()` on an always-active *container* shows nothing; `diff()` scans the whole
tree and **finds the toggled subtree automatically** — so for "did X open", `diff` is the robust tool.

---

## 11. Snapshot Slimming (A + B)

Real trees are huge (a real game Q'd **516 nodes**, mostly spine/fbx bones) and the descriptors were
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

- **Core `copse`**: zero runtime deps; exports `execute`/`snapshot`/… + ships `dist/copse.inject.js` (full) and `dist/copse.inject.lite.js` (lite).
- **Optional subpaths**: `copse/driver-puppeteer` (`connect(url)` → a Driver; **peerDep** puppeteer-
  core, system Chrome) and `copse/harness` (`execute`/`extractFacts`/`localDriver` — the deterministic
  executor). (The old `copse/agent-claude` moved to arbor with the loop.)
- **Thin CLI** `src/cli.js` (registered as `copse`; see §14a): `copse scan <url>` / `copse mcp [url]`,
  plus `--verbose` and `-o <folder>` (**append** the run log). Grew **single-shot** verbs —
  `copse get|press|call|node|reachable <url> <sel>` (connect → one primitive → JSON → close, for
  shell/jq) — plus `copse run <url> <script.json>` (frozen-script replay) and `--version`. (The
  AI-driver loop is arbor's, not a `copse` verb.)
- `puppeteer-core` is a **peerDependency (optional)** + devDep; a `prepare` script builds the bundle;
  `files` ships `src`/`dist`.

`connect()` is the boot rig (launch system Chrome → inject → return a Driver); it waits for `cc` +
a UI scene (some interactive buttons present) before returning, fps-capped (§7/§12).

---

## 14. Directory Layout

Reorganised by concern: the pure core under `src/core/` (file = `index.js`, not the redundant
`core/core.js`); the engine layer under `src/cocos/`; optional edges under `src/drivers/`
and `src/mcp/`; `src/harness.js`, `src/index.js` (the public barrel) and `src/cli.js`
(the CLI) at the top. Public import paths were preserved through the reorg (the `exports` map:
`copse` / `copse/driver-puppeteer` / `copse/harness` / `copse/mcp` / …); only internal file locations
moved. (`copse/agent-claude` later moved to arbor with the loop.)

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
  **testing primitives** (`connect`/`reload`/`snapshot`/`interactive`/`click_surface`/`resolve`/
  `press`/`get`/`call`/`reachable`/`node`/`diff`/`listeners`/`probe`/`logs`/`close`) over a live `connect()` session in `state.cp`
  (`press`/`call` carry the auto-`changed` delta straight through; the `coverage` tool has since moved to
  arbor with the coir×copse join), plus **7 `debug:true`-tagged Debugger
  tools** (`break_*`/`wait_pause`/`eval_frame`/`debug_step`/`clear_breakpoints`, §18) that are **hidden
  from `tools/list` unless `copse mcp --debug`** (dev-build-only; pausing the runtime is intrusive). `connect`
  also takes **`attach`/`match`** to drive an already-open tab (your own game behind a login/staging gate you
  opened yourself) — no navigation, so it drives the tab exactly as you left it.
- **Layout aligned to coir at the same time**: no `bin/` dir — the CLI moved to `src/cli.js` (`bin:
  {"copse":"src/cli.js"}`), MCP is the `copse mcp [url]` subcommand (lazy `import('./mcp/server.js')`),
  and the heavy/optional imports (puppeteer driver, claude agent) became **lazy per-command** so
  `copse --help` / `copse mcp` don't require puppeteer-core. Only `dist/copse.inject.js` is ever built;
  everything else (cli, mcp, core) runs as raw ESM.
- **Tested** over a fake Driver (`test/mcp.test.js`): `initialize` / `tools/list` / `tools/call` dispatch,
  arg mapping (`force`, `call` arg-spread, `snapshot` defaulting `relevant:true`), unknown-tool and
  no-session errors, `close` teardown, notification = no-reply.
- **Verified end-to-end driving a running game natively from Claude Code** (registered via a project
  `.mcp.json`): Claude called `open` → `press` (dismiss start page, `changed.disappeared`) → `interactive`
  (**saw a toggle was still `interactable:false`, waited until it enabled** — the adaptive
  move a blind script can't make) → `press` the toggle (panel open, `changed.appeared` = title/costs/close) →
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
| Cross-version internal drift | a `cc.*` internal renamed → silent `'unsure'` | `probe()` reports which internals resolve on a build; `codeHandlers` reads are L2-validated against real engine source |
| `node()` on always-active container | no change seen on open | Use `diff` (scans the tree) instead, or target the actually-toggled node |

---

## 16. Relationship to the Originating Plan

Compared to that originating plan:

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

## 17. Worked Example: The Panel Open/Close Saga (the loop maturing)

Testing "does the panel window open and close?" took four runs, each failing differently and
each pointing at a real improvement — a good record of why the pieces above exist:

1. **sonnet, 1 round** — the AI pressed the toggle *and* redundantly called its handler ("for
   safety"); a toggle invoked twice = net no-op → false negative. Also the `next` stage **hallucinated**
   a fake success. (→ the toggle-once + "use real results" lessons; report stage stayed honest.)
2. **opus, 1 round** — pressed once (OPEN verified via `changed.appeared`), but the close-button ref
   was **mis-cased** (`ShopPanel` vs `shopPanel`) → not-found. (→ "copy refs verbatim" prompt.)
3. **opus, 1 round, descriptor-rich `changed` + verbatim prompt** — OPEN cleanly verified with
   contents read straight from `changed`; but the plan **never included a close step** — the close ref
   only exists *after* opening, which a single upfront plan can't reference.
4. **opus, 2 rounds + stop** — **PASS.** Round 0 opens (`changed.appeared` = the panel
   subtree: a title, two options with costs) and leaves it open;
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
  `break_*`/`wait_pause`/`eval_frame`/`debug_step`, **hidden unless `copse mcp --debug`** (pausing the
  runtime is intrusive → dev-build-only).

A **"how loud is each domain" ordering** holds: a passive **Network** read is quietest (below JS), **DOM**
middling, **Runtime / Debugger loudest** — they change the page's own JS-runtime behaviour, which a
hardened page can measure from the inside. copse needs Runtime to read the scene, so it sits at the loud
end. (The Network edge — a passive asset/RPC tap — was split out into the separate **mast** tool.)

---

## 19. Validation Methodology (throughout)

- **Headless tests** (`node:test`, zero deps): **90 cases** over fakes — core (addressing/`[i]`, press
  fire+emit+disabled/force **+ the touch fallback**, get/call, the `Node` pseudo-component, slim shape +
  `relevant`, `reachable`/`node`/`diff` plumbing), the geometric `reachable` over a fake `cc`, the base/lite
  runtime split (`test/runtime-lite.test.js`), the `probe()` self-diagnostic, the deterministic executor
  (`execute`/`extractFacts`: step order, throwing-step capture, the five FACT buckets — no verdict, no
  agent), and the MCP JSON-RPC dispatcher (`createDispatcher`).
- **L2 — real engine**: `test/real-engine.l2.test.js` esbuild-bundles the event source from a local
  `reference/cocos/<ver>` checkout (gitignored) and asserts copse's `codeHandlers` parses a **real**
  `CallbacksInvoker._callbackTable` — the fragile internal read, validated against real engine code, not a
  self-authored fake. Skips when no engine is checked out, so `npm test` stays green everywhere.
- **`probe()`**: engine internals (`_eventProcessor` field names, `CallbacksInvoker._callbackTable` shape,
  `UITransform.hitTest` coord space, `batcher2D.getFirstRenderCamera`) are surfaced live by `__copse.probe()`
  — run it on an unfamiliar build to see which resolve, instead of finding out via a silent `'unsure'`.
- **End-to-end**: snapshot/press/get/reachable/node/diff and the full AI loop run against a running
  game on a dev/preview build; the panel open/close flow PASSes.
- **Build / typecheck**: `npm run build` (esbuild), `npm run typecheck` (`tsc --noEmit`, JSDoc +
  `// @ts-check`; the browser-glue driver opts out — its `page.evaluate` callbacks are browser code).

---

## 23. Conventions

- **Zero runtime deps.** Engine-free pure core (`src/core/`); the `cc.*` coupling lives only in
  `src/cocos/` (Pixi in `src/pixi/`). The browser driver (`src/drivers/`, puppeteer-core) is an
  optional **peer**-dep edge, never a runtime dep.
- **Types** via JSDoc + `// @ts-check` (no `.ts`); `tsc --noEmit` with `allowJs`/`checkJs:false`/
  `strict:false` — same posture as coir.
- **Selector grammar shared with coir** — `Parent/Child:Comp.prop` + `[i]`, so the two interoperate.
- Reaching `cc`: build-setting dependent (verified on a dev/preview build); if `window.cc` is
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

## 25. Field report — a real-game feature migration (what it drove)

A retrospective, **not** a TODO. copse was used on two production Cocos Creator 3.5.2 games
(PureMVC-based, driven through a web-mobile mock) to migrate and regression-test a multi-step gameplay
feature. Recorded here: what was smooth, the pain points real use surfaced, how each was closed, and the
honest boundaries that remain. Domain/project specifics are kept out — this is about the tool.

**Smooth:** `pm_get/pm_set/pm_call/pm_notify` drive proxy/mediator directly — semantic tests with almost
no eval; `run_script` (chain + `expect` subset + `changed` appeared/deactivated/labelChanged) reads UI
side-effects intuitively; `pm_set` with the type-fix + read-back writes booleans/objects directly. Pain
clustered on **"when you need eval"** and **"session/frame stability."** Each item below: original pain →
what was closed.

### A — high-leverage (all done)

- **A1 — run_script step value.** READ steps (`get`/`pmGet`/`node`/`reachable`/`framework`/`probe`/
  `orient`/`listeners`/`patchCalls`/`diff`) now auto-capture their (truncated) value on a green step so
  you can peek without a re-fetch; actuations/large list ops stay silent unless `capture:true` (per-step
  or per-script); `capture:false` suppresses. (Before: a green step returned only `{ok,ms}`.)
- **A2 — errors-gate filtering.** `ignoreErrors` (regex|regex[], OR-joined) drops known background noise
  (SSE/MIME/aborted) from the pass gate while keeping it in `result.errors`; `errorGate:'uncaught'` fails
  only on a real throw (a `pageerror`, tolerating `console.error`), `'off'` = allowErrors. Per-step and
  per-script. (The concrete trigger: a background `EventSource … MIME type … Aborting` on a flow's LAST
  step flipped an otherwise-green run to `pass:false`; `allowErrors` was too all-or-nothing.)
- **A3 — frame-detach auto-recovery.** `isDetached()` recognises detached/context-destroyed/target-closed;
  `reboot()` re-finds the cc frame and re-injects (deduped, re-registering framework adapters); every
  in-page call auto-reboots + retries once. No manual reconnect after a navigation/reload/long poll.

### B — smoothing "when you need eval"

- **B1 — stable eval `pm.*` helper.** In-page `__copse.pm = {get,set,call,notify,patch}` (aliases of the
  camelCase members, one implementation) + `pm.proxy(name)`/`pm.mediator(name)` return the RAW live object
  to poke. NOTE the snake_case *tool* names (`pm_get`) don't exist in-page — eval uses `pm.get`. (Before:
  `__copse.pm_get(...)` threw in eval, forcing a hand-dug `puremvc.Facade.instance.retrieveProxy(...)`.)
- **B2 — walk-based node find (PARTIAL).** copse's own `snapshot`/selectors already WALK the live tree
  (`Parent/Child` relative to the scene root), so copse code never calls the flaky `cc.find(...)` — which
  covers most of the pain. Still open: a dedicated fuzzy `__copse.find(name)` on the MAIN eval surface —
  only the `probe` bundle carries a `find(name,{enabled})` today (for the `--until` driver).
- **B3 — minified-name countermeasure.** Release builds minify class names (a mediator class name → `t`),
  so `constructor.name` is useless. `framework()` enumerates proxies/mediators/commands by their REGISTRY
  name (the mediatorMap key is NOT minified) and `pm.mediator(name)`/`pm.proxy(name)` fetch by that name —
  so address by registry key, never `constructor.name`.
- **B4 — attach tab selection.** `list_tabs` (pre-attach, no navigation → `[{index,url,title,active}]`);
  `match` takes a substring, a LIST (ALL ANDed), or `{url,title}` (title matchable) so two builds sharing a
  url fragment are told apart; >1 match errors with the candidate list (or `pick:<index>`); the `connect`
  summary echoes `attachedTab`. (Before: several mock tabs shared a url fragment → silent wrong-tab attach,
  discovered late.)

### C1 — hold / pause a flow

`hold`/`release`/`hold_status`. `hold(sel,{at,pm,holdMs})` arms a ONE-SHOT freeze of the engine loop at a
trigger (a component method, or a framework command/method with `pm:true`) — `cc.game.pause`→`director.pause`,
version-adaptive, fail-loud `no-freeze-api`. The last frame stays on the canvas (`screenshot` captures it),
`get`/`pm_get`/`snapshot` still read while frozen, `release` resumes, `holdMs` auto-releases. Composes in
`run_script` (`hold`→`screenshot`→`release`). (The need: a self-running ~3s flow blows past a ~1s
intermediate state too fast to screenshot.) Boundary: freezes everything on the engine loop
(scheduler/tween/animation/engine callbacks); a bare `setTimeout`-driven state won't freeze, and a frozen
game can't be driven further until `release`.

### D — a cross-tool caveat (native-verify false positives)

Not copse — **coir**'s `native-verify`. Editor-extension components (e.g. a custom editor-tool extension,
a localized-text component) aren't loaded by native-verify's instantiate runtime, so they read
`comp-missing`/`node-missing` even on an untouched shipped prefab; and an all-nested-instance container
prefab reports ALL its children as node-missing. Easy to misread as "my copied asset is broken." Verify
with offline `coir verify` (structure) + a build + copse live instead. **Resolved in coir:** native-verify
now demotes nested-instance / unresolved-(compressed)-component mismatches to WARN (not a `valid` failure)
with a clear reason, so they no longer read as defects.

### E — not copse's job (recorded so it isn't misattributed)

- A standard mock not embedded in the real container has no `postMessage` source (`window.parent`), so a
  server-authoritative action never triggers the feature's callback — that end-to-end path can't run in a
  bare mock, only `pm_call` simulation. → environment/container.
- A self-driving mode issues a server request the backend rejects → deadlock. Use a self-contained path
  instead. → backend behavior.
- The `cc.find` / minified-name root cause is the Cocos engine/build; copse works around it via
  snapshot/selectors (B2) + registry-name access (B3).

### F — the wait budget: fail LOUD, not long

A second field report, from a long attach-driven session (a multi-project feature migration: dozens of
build → reload → verify loops). Its headline complaint was that a detached frame made every op wait 40s,
and that one `run_script` hung for **1953s (32.5 min)** before the MCP host's idle timeout killed it — not
copse. The symptom was real; **the diagnosis was wrong**, and measuring it against a real Chrome is what
found the actually-severe bug. Kept here because the corrections are more instructive than the fix:

| the report's claim | what measurement showed |
|---|---|
| every op blocks 40s after a detach | the **main frame never detaches** (not on reload, not on cross-site nav). Only an iframe does (the editor-preview shape) — and its `evaluate` throws **synchronously, 0ms**. After a healthy F5 copse already re-attached in **4ms**. |
| the 40s comes from puppeteer/CDP | **no** — it was copse's own `bootTries ?? 40` × `sleep(1000)`. Grepping for `40000` found nothing because the number is 40×1000. |
| an in-flight detach never settles | not in the reload case: puppeteer **rejects in 533ms**, and `isDetached` already matched that message. |

The 32-minute hang was real but unrelated to detaching: `ev()` opened with an unbounded `await ready`,
and attach mode deliberately never awaits it — so once `ready` stalled (renderer on a breakpoint, engine
never up) *every* later op hung forever. The proposed detach-race would not have touched it.

**The worst bug was the one the report didn't find.** When `bootInPage` couldn't find `cc` it fell back to
`page.mainFrame()` — a live frame with no game on it. Nothing about it is "detached", so `isDetached`
never fired again and the session was wedged **permanently**, not recovering even after the game came back
healthy. That, not detaching, is why the session needed a manual reconnect every time: one F5 that landed
mid-rebuild poisoned it irreversibly.

What closed it — the principle is *not* "make the numbers smaller", it is **make failure explicit and
recoverable**; short budgets are only safe once a failure can be retried:

| situation | before | after |
|---|---|---|
| first op after a healthy F5 | 4ms | **6ms** (unchanged) |
| op after attaching to a not-yet-booted tab | ≤**80s of silence** | **5.0s** + `phase=finding-engine, 6.0s elapsed` |
| reload landing mid-rebuild, single op | **∞** (wedged forever) | **15.2s** + the reason; next op fails fast in **0ms**; self-heals in **6ms** once the game returns |
| `browseTabs()` over 10 tabs | ≤**16s** (sequential, 800ms/tab) | **18ms** (parallel) |

Then three more "we already knew the answer and were still waiting" cases: `attachTries` 30s → **8s**, and
on failure it lists every open tab (a mistyped `match` went from 30s of silence to 8.3s and the answer on
screen); a reboot no longer inherits the cold-boot scene budget (each reboot phase uses `rebootTries`);
`injectStallMs` 20s → **the same number as `readyTimeout`** (connect used to block 20s before admitting it
wasn't ready, when readyGate could say so in 5s *and* name the phase). Plus a genuine infinite wait hiding
behind a clean error message: **`connect` didn't close the browser it had launched when it threw**, leaving
a live CDP websocket that kept the caller's Node process alive forever — all post-launch throws now go
through `bail()`.

Two later rounds mattered more than any number:

- **`opTimeout` (60s default).** The first pass only bounded "init never finished". A renderer that wedges
  **after** connect (a breakpoint mid-session, a JS thread in a loop) was still silent forever, because
  `readyGate` is a no-op once init settles and the `frame.evaluate` under it had no bound at all. **Half a
  guarantee is worse than none, because people trust it.** `watch` derives its own budget (or
  `watch({timeout:'2m'})` would be killed by the cap) and `eval` may pass `{timeout}` — it is the one op
  whose duration is the caller's to choose, and the reported 1953s was an eval.
- **`recoverable` + `code`.** The report asked for this; the first version shipped only well-written human
  prose. But a runner that stops at the first failure, and an agent, can then only string-match sentences —
  they cannot tell "retry me" from "your selector is wrong". Errors now carry `recoverable`/`code`
  (`init-pending` / `boot-failed` / `no-engine` / `not-installed` / `op-timeout` / `no-tab` /
  `ambiguous-tab` / `renderer-silent` / `interrupted`), through script.js and harness.js via one `errClass`
  definition, and MCP puts the tags in the **text** (`✗ [recoverable] [init-pending] …`) — an MCP client
  only ever sees text, so a flag left on the Error object may as well not exist. Deliberately **not**
  recoverable: anything a retry would only replay — a mistyped or ambiguous `match`, a wedged renderer.

A third review pass (focused on silent failures and long waits, verified on a real browser) found a layer
under that: **an operation reported as failed may still have run.** Adding deadlines broke an invariant the
old `ev` held implicitly — it never reported failure before the op was sent, so "failed ⇒ didn't run" used
to be true. `evWith` now carries a `sent` bit: not-yet-sent failures are safe to retry by construction (and
a zombie run is barred by `abandoned` from firing late), while an in-flight navigation raises
`[interrupted]` — "this may have taken effect; verify before retrying a mutating op" — instead of silently
re-firing. That also cured an **older** double-fire: the detach-retry path blindly re-sent mutating ops.
`mutate()` follows the same rule: once the actuation has happened, a failed *observation* can only annotate
`observation.lost` on the result — calling an executed press "failed, please retry" is telling an agent to
place a second bet.

**Not done:** the report's P2, a CDP `Page.frameDetached` signal to race in-flight ops against. With a
healthy F5 already self-healing in 6ms and a reload rejecting in 533ms, it would turn 533ms into ~0ms —
an optimisation, not a bug fix. **Unreconciled:** the exact 40048ms + detached-message combination never
reproduced (the closest was 50119ms with a different message); closing that needs a real editor preview.

The acceptance criteria the report proposed are now executable rather than prose: they are
`test/driver-reconnect.l2.test.js`, which launches a real Chrome and skips when none is available.
