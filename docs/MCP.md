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

# 3) the Cocos scene lens (this server): snapshot/press/get/call/reachable/diff/coverage
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
| asserts | screenshot, console, network, perf trace | component state, `changed` diff, reachability, coir coverage |

Use both when one action needs rendering evidence (screenshot) **and** logic evidence (state
delta). copse's own launch mode (`connect(url)` below) still works standalone — it's the
fallback when you don't want a second server.

## Prereqs

```bash
npm run build          # produces dist/copse.inject.js (the full bundle — the one the MCP server injects)
npm i -D puppeteer-core # the browser edge (peer dep); the server launches system Chrome
```

## Tools

The default tool set is the 17 testing primitives below. The tool names match the library 1:1
(`connect`, `snapshot`, `press`, …) — the MCP edge is the same surface over stdio.

| tool | what it does |
|---|---|
| `connect(url, {headed?, fps?, browserURL?, attach?, match?})` | launch/attach Chrome, load the game, inject copse, wait until ready. **Call first.** (same op as the library's `connect()`) |
| `reload({waitUntil?})` | reload the tab + re-inject — pick up the editor's CURRENT scene after opening a different one, or recover a wedged/empty preview |
| `snapshot({relevant?=true, includeInactive?, components?})` | slim live node tree |
| `interactive()` | buttons + `reachable`/`blockedBy` |
| `click_surface({reachability?, includeInactive?})` | join-ready runtime click surface: one row per editor-wired clickEvent `{ref, method, …}` — the copse side of the coir join (see [`COVERAGE.md`](COVERAGE.md)) |
| `resolve(path)` | translate a coir STATIC nodePath into the live `ref` (symmetric tail match — absorbs coir's root prefix / a prefab mount); feed the result into `press`/`get` |
| `press(ref, {force?, reachableGate?})` | fire the wired handler (NOT a coordinate click) → `{ok, fired, changed}`; `reachableGate:true` refuses a covered (`reachable:false`) button — the same gate `runHarness` applies |
| `get(sel)` / `call(sel, args)` | read a member / invoke any method (`call` on a missing method → `{ok:false, reason:'no-method'}`, not a silent `value:undefined`) |
| `reachable(ref)` / `node(ref)` | best-effort reachability / node intrinsics |
| `coverage(staticRows)` | join coir's static ClickEvent rows against the live click surface → buckets `{covered, blocked, uncertain, unreached, ambiguous, codeRegistered, codeOnly}` — the coir×copse capability in one call (see [`COVERAGE.md`](COVERAGE.md)) |
| `diff(before, after)` | diff two snapshots → `appeared/disappeared/activated/deactivated/labelChanged` (for manual before→act→after comparisons; `press`/`call` already attach this as `changed`) |
| `listeners(ref)` | user `node.on()` handlers `[{type, fn?, target?}]` (minified builds strip names) |
| `probe()` | engine-coupling self-diagnostic: `{version, classes, reach, events, touch}` — which version-sensitive internals resolve on this build (drift → visible, not a silent `'unsure'`) |
| `logs(since?)` | captured `console.*` + uncaught errors (all frames) `[{level, text, t, stack?}]` — check if an action errored with no visible UI change |
| `run_script({script})` | **replay a frozen test script** deterministically (no LLM): JSON steps + subset-match `expect`s → `{pass, failedAt?, steps}` — the regression half of the loop (see [`SCRIPTS.md`](SCRIPTS.md)) |
| `dump_script({name?, reset?})` | export this session's recording (every press/get/call/… since `connect`, each with `observed`) as a script skeleton — trim `observed` into minimal `expect`s, save, replay |
| `close()` | tear down the browser (also detaches the debugger) |

`press`/`call` auto-attach `changed` (what the action did after the tree settles), so opening a
panel hands the agent its contents with no follow-up snapshot.

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
