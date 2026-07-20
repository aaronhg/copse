# copse over MCP — drive the canvas from any agent

`copse mcp` exposes copse's bridge as **MCP tools** over stdio (hand-rolled JSON-RPC, no
extra deps). Any MCP client — **Claude Code**, a plain Anthropic tool-use loop, **browser-use**,
Stagehand, Cursor — becomes the "brain"; copse stays the eyes + hands into the Cocos canvas.

This is the high-leverage shape: the valuable part of copse is the bridge (`cc.director.getScene()`
→ a queryable, drivable semantic tree). The agent loop is replaceable — so borrow a good one.

## Why not just point an existing browser agent at the game?

Browser agents (browser-use, Stagehand, Claude for Chrome, Computer Use) perceive via the
**DOM / accessibility tree** (or pixels). A Cocos game is **one opaque `<canvas>`** to them —
nothing inside is clickable. copse reaches into the engine and gives the agent a real tree +
the ability to call the wired handler directly. Over MCP, that capability plugs into any of them.

## Compose with chrome-devtools-mcp — one Chrome, two lenses

copse deliberately does **not** re-implement generic browser control. Register the official
[`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) alongside it and
point **both at the same Chrome** — this shared-attach setup is the recommended shape:

```bash
# 1) one Chrome with a debug port (quit Chrome first so the flag takes)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222

# 2) the generic browser lens: navigate, screenshot, network, performance, DOM input
claude mcp add chrome-devtools -- npx chrome-devtools-mcp@latest --browser-url http://127.0.0.1:9222

# 3) the Cocos scene lens (this server): snapshot/press/get/call/reachable/diff/click_surface
claude mcp add copse -- npx copse mcp
```

The agent navigates / passes gates / screenshots with chrome-devtools-mcp, then drives the game
with copse: `connect({ attach: true, browserURL: "http://127.0.0.1:9222" })` attaches to the
**active tab** — the one being viewed / the one chrome-devtools-mcp is on — so no URL guessing
(add `match: "<url-substr>"` to pin a specific tab instead). Division of labour:

| | chrome-devtools-mcp | copse |
|---|---|---|
| sees | DOM / pixels / network — the canvas is one opaque element | the live Cocos node tree **inside** the canvas |
| acts | real input events, navigation, emulation | the wired handler, any component method |
| asserts | screenshot, console, network, perf trace | component state, `changed` diff, reachability, `click_surface` (the copse side of the coir join) |

Use both when one action needs rendering evidence (screenshot) **and** logic evidence (state
delta). copse's own launch mode (`connect(url)` below) still works standalone — it's the
fallback when you don't want a second server.

## Prereqs

```bash
npm run build          # produces dist/copse.inject.js (the full bundle — the one the MCP server injects)
npm i -D puppeteer-core # the browser edge (peer dep); the server launches system Chrome
```

## Tools

The default tool set is 41 testing primitives (the 7 Debugger tools below are hidden unless `--debug`).
The tool names match the library 1:1 (`connect`, `snapshot`, `press`, …) — the MCP edge is the same
surface over stdio.

`tools/list` groups these into **families**, each with one **★ headline** ("reach for this first; the
rest are variants / lower-level"), and prefixes every description with its tag — `[drive ★]`, `[drive]`,
`[see]`, … — so the flat list reads as a guided map. Nothing is hidden. The families (★ = headline):
**session** (`connect`★) · **see** (`snapshot`★) · **read** (`get`★) · **drive** (`press`★) ·
**usable** (`reachable`★) · **observe** (`watch`★) · **fix** (`patch`★) · **coverage** (`click_surface`★) ·
**script** (`run_script`★) · **orient** (`orient`★) · **escape** (`eval`, no ★ — the raw hatch, a last resort).
The core loop is the ★s of session/see/drive/read.

**Failures are typed, in the text.** An MCP client only ever sees strings, so a flag left on an Error
object may as well not exist — the tags are put *ahead of the prose*: `✗ [recoverable] [init-pending]
in-page init hasn't finished yet (phase=finding-engine, 6.0s elapsed) …`. `recoverable` means retrying
is worth it by construction (the session is still coming up, the page is mid-rebuild); its ABSENCE is
equally deliberate — a mistyped or ambiguous `match`, a wedged renderer, or a page with no engine will
only replay the same failure. `code` is the stable key to branch on: `init-pending` · `boot-failed` ·
`no-engine` · `not-installed` · `renderer-silent` · `op-timeout` · `interrupted` · `no-tab` ·
`ambiguous-tab`. `interrupted` is the one to read carefully: the page navigated while the call was
IN FLIGHT, so the op **may have taken effect** — verify before retrying anything that mutates.

Every in-page call is bounded (`opTimeout`, 60s by default) so a renderer that wedges *after* connect
can't hang a tool call forever; `eval` takes its own `{timeout}` because it is the one op whose
duration is the caller's to choose.

| tool | what it does |
|---|---|
| `connect(url, {headed?, fps?, browserURL?, attach?, match?, frameworks?})` | launch/attach Chrome, load the game, inject copse, wait until ready. **Call first.** (same op as the library's `connect()`) |
| `reload({waitUntil?})` | reload the tab + re-inject — pick up the editor's CURRENT scene after opening a different one, or recover a wedged/empty preview |
| `snapshot({relevant?=true, includeInactive?, components?})` | slim live node tree |
| `interactive()` | buttons + `reachable`/`blockedBy` |
| `click_surface({reachability?, includeInactive?})` | join-ready runtime click surface: one row per editor-wired clickEvent `{ref, method, …}` — the copse side of the coir join (see [`COVERAGE.md`](COVERAGE.md)) |
| `resolve(path)` | translate a coir STATIC nodePath into the live `ref` (symmetric tail match — absorbs coir's root prefix / a prefab mount); feed the result into `press`/`get` |
| `press(ref, {force?, reachableGate?, captureNetwork?})` | fire the wired handler (NOT a coordinate click) → `{ok, fired, changed}`; `reachableGate:true` refuses a covered button; `captureNetwork:true` attaches the requests it fired |
| `get(sel)` / `call(sel, args)` | read a member / invoke any method (`call` on a missing method → `{ok:false, reason:'no-method'}`, not a silent `value:undefined`) |
| `reachable(ref, {visual?, baseline?})` / `node(ref)` | best-effort reachability (`visual:true` adds the pixel pass → a three-state `usable`) / node intrinsics |
| `diff(before, after)` | diff two snapshots → `appeared/disappeared/activated/deactivated/labelChanged` (`press`/`call` already attach this as `changed`) |
| `listeners(ref)` | user `node.on()` handlers `[{type, fn?, target?}]` (minified builds strip names) |
| `orient()` | **one-call bearings** after connect → `{url, scene, engine, framework:{kind, registered, capabilities}, buttons, entryPoints:[refs pressable now], hint}` — instead of stitching probe + framework + interactive by hand |
| `probe()` | engine-coupling self-diagnostic: `{version, classes, reach, events, touch, framework}` — which version-sensitive internals resolve on this build (drift → visible, not a silent `'unsure'`) |
| `logs({grep?, level?, tail?, since?})` | captured `console.*` + uncaught errors (all frames), server-side filtered so a chatty game can't blow the token budget |
| `watch({exprs?, selectors?, interval?, until?, timeout?, settle?, captureNetwork?})` | diff-only state TIMELINE over time → `{timeline, stoppedBy}` (replaces hand-written polling loops) |
| `patch(sel, {before?, after?, replace?, trace?})` / `patch_clear(sel?)` / `patch_calls(sel?)` | wrap a live component method to verify a fix pre-rebuild; `trace:true` records calls. `patch_calls(sel)` reads that method's calls; **`patch_calls()` with NO sel** returns the MERGED timeline across every traced patch — one shared epoch (`t` comparable) + a sequence number stamped on ENTRY (`i`), so order by `i`, not `t`: a synchronous command chain runs inside a single millisecond |
| `pm_trace({roles?, traceMax?})` | arm the FRAMEWORK's dispatch choke points in one call — the whole app-layer flow without guessing which class to name (PureMVC: `Facade.sendNotification` / `Observer.notifyObserver` / `MacroCommand.execute`). Then `patch_calls()` reads the merged timeline and `patch_clear()` disarms. Rows carry `i` (order), `d` (nesting depth), `dt` (gap from the previous row — where the time actually went) and a `label`. See [`PM-TRACE.md`](PM-TRACE.md) |
| `framework()` / `register_framework(adapter)` | detect the app framework (PureMVC etc.) + `{proxies, mediators, commands, capabilities}` / install an adapter this session (core ships none — see [`INJECT.md`](INJECT.md)/`copse.frameworks.mjs`) |
| `pm_get(sel)` / `pm_set(sel, value)` / `pm_call(sel, args)` | READ (family `read`) / WRITE (family `drive` — an actuation, verified + carries `errors`/`changed`) proxy/mediator state OUTSIDE the cc tree / call a proxy/mediator method |
| `pm_patch(sel, {…, trace?})` / `pm_notify(name, body?, type?)` | patch a proxy/mediator/command method / **fire a notification** — the direct entry into a notification-driven flow |
| `network({grep?, status?, type?, tail?, since?})` | captured requests `[{t, method, url, status, type, payload?}]` — for "client action → server error code" bugs |
| `screenshot({selector?, path?})` | canvas PNG (inline image, or written to `path`) — pair a logic state with what's on screen |
| `visual_check(ref, {baseline?})` / `visual_baseline({refs?})` | node-anchored pixel check (drawn/matches/clear) / capture golden per-node signatures |
| `run_script({script})` | run a step sequence in ONE call — a **frozen regression script** AND your ad-hoc **batch** (full-surface ops); subset-match `expect`s → `{pass, failedAt?, steps}` (see [`SCRIPTS.md`](SCRIPTS.md)) |
| `dump_script({name?, reset?})` | export this session's recording as a script skeleton — trim `observed` into minimal `expect`s, save, replay |
| `close()` | tear down the browser (also detaches the debugger) |

`press`/`call` (and the pm actuations `pm_set`/`pm_call`/`pm_notify`) auto-attach `changed`
(what the action did after the tree settles) + `errors` (any console-error/uncaught throw during it),
so a crashing flow is never a silent green pass and opening a panel hands the agent its contents.

### Debugger tools (hidden by default)

The CDP **Debugger** edge — `break_at(urlRegex, line)` / `break_in(sel)` / `break_exceptions(state)`
to set a breakpoint (incl. by `path:Comp.method`, works minified) or pause on throws, then
`wait_pause(timeoutMs?)` / `eval_frame(frame, expr)` / `debug_step(kind)` / `clear_breakpoints()` to
read the call stack + locals and step/resume.

These are **hidden from `tools/list` by default** (they're for your OWN dev build — pausing the
runtime is intrusive, and they'd otherwise crowd the menu). Start the server with **`copse mcp --debug`**
to surface them. Full guide: [`DEBUG.md`](DEBUG.md).

`connect` is **iframe-aware**: the game's `cc` often lives in a nested (sometimes cross-origin) iframe,
so the server scans every frame (`page.frames()`) for the engine and drives that frame.

## Claude Code

Register the server (published):

```bash
claude mcp add copse -- npx copse mcp
```

…or local (this repo, no install):

```jsonc
// .mcp.json
{ "mcpServers": { "copse": { "command": "node", "args": ["/abs/path/to/copse/src/cli.js", "mcp"] } } }
```

Then just ask Claude:

> Use copse: `connect` https://your-game/ , then verify a panel window opens and closes —
> press the toggle once (read `changed` for the panel), then press the panel's close button
> once (read `changed`). Don't buy or spend.

Claude calls `mcp__copse__connect` → `snapshot` → `press` → reads `changed` → `press` close → done.
**Claude itself is the harness — no browser-use needed.**

Pre-open a fixed game instead of letting the agent choose: `npx copse mcp https://your-game/`.

## browser-use (or any MCP-capable agent)

browser-use can consume MCP servers as a tool source — register `copse mcp` and the
`connect/snapshot/press/get/call/...` tools appear in its action space. Tell it the game is inside a
canvas it can't see via the DOM, so it must perceive with `snapshot` and act with `press`/`call`.
Same idea for Stagehand / Cursor / any MCP client.

## Game behind a login / staging gate → attach to your own browser

When the build you want to test sits behind auth or a staging environment a fresh headless launch
can't reach, don't have copse launch the browser. Open the game in **your own** Chrome, sign in /
navigate to it yourself, then have copse **attach to that already-open tab** (no navigation — it
drives the tab exactly as you left it):

```bash
# 1) start YOUR Chrome with a debug port (quit it first so the flag takes)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
# 2) in it: sign in / navigate to your game so it's running
# 3) register the MCP server (plain — no connection flags on the command):
claude mcp add copse -- npx copse mcp
```

Then ask the agent to `connect` in **attach** mode — pass `browserURL` + `match` straight to the tool (no
need for any flag on `copse mcp`): `connect({ attach: true, browserURL: "http://127.0.0.1:9222", match: "your-game" })`.
Omit `match` (and `url`) to attach to the **active tab** — the one you're looking at. `close` then just
disconnects — it leaves your browser open. (Library: `connect(url, { browserURL, attach: true, match })`;
CLI: bare `--attach --browser-url …` with no `<url>`/`--match` also targets the active tab.)

Caveat: copse only drives **Cocos** games (it needs `cc`). If the attached game isn't Cocos, `connect`
finds no engine — that's an engine limit, not the environment.

## Notes

- **stdout is the JSON-RPC channel** — the server routes all logging (and any chatty page output)
  to stderr, so the protocol stream stays clean.
- One live session at a time; `connect` re-targets (closes the previous), `close` / disconnect tears down.
- Heat: same fps-cap (default 10) as the driver; `connect({headed:true, fps:30})` to watch. In attach
  mode the fps is left alone (your real browser/GPU).
- Deterministic alternative: if you don't want an LLM at all, use the library
  (`copse/driver-puppeteer`) and assert against `cp.press`/`cp.get` directly — see
  [`AI-DRIVER.md`](AI-DRIVER.md).
```
