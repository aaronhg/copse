# Test scripts — freeze an explored flow into a deterministic replay

## Why

Interactive testing (Claude Code driving the game over MCP, or `copse ai`) is
**exploratory** — great for finding what to test, wasteful to re-run on every commit.
Scripts close the loop:

```
AI explores once (MCP session)                deterministic replay (every CI run)
┌──────────────────────────────┐              ┌──────────────────────────────┐
│ connect → snapshot → press → │ dump_script  │ copse run game.json          │
│ get → … (session recorded)   │ ───────────→ │ or MCP: run_script({script}) │
│ agent trims observed→expect  │  freeze JSON │ → {pass, steps, failedAt}    │
└──────────────────────────────┘              └──────────────────────────────┘
```

A script is **data (JSON), not code** — it travels over MCP, lives in git, can be
generated/edited by an agent, and replays with zero LLM involvement.

## Script format

A script step **is the harness's `Step` shape** (`src/harness.js` `@typedef Step`:
`{op, ref?, sel?, args?, opts?, note?}`) plus the assertion fields `expect` /
`allowErrors` — so steps freeze 1:1 out of a `runHarness` round (see
[Freezing from a harness run](#freezing-from-a-harness-run)) and out of recorded MCP
tool calls, which use the same named fields.

```jsonc
{
  "name": "shop-open-close",
  "continueOnFail": false,          // default false: a failed step stops the run
                                    // (later steps depend on earlier state)
  "steps": [
    { "op": "press", "ref": "Canvas/lower/btn_shop", "note": "open the shop",
      "expect": { "ok": true, "changed": { "activated": [{ "ref": "Canvas/ShopPanel" }] } } },

    { "op": "get", "sel": "Canvas/Gold:Label.string",
      "expect": { "value": "100" } },

    { "op": "sleep", "ms": 800 },                           // the only non-driver op

    { "op": "press", "ref": "Canvas/ShopPanel/close", "opts": { "reachableGate": true },
      "expect": { "changed": { "deactivated": [{ "ref": "Canvas/ShopPanel" }] } } }
  ]
}
```

- **`op`** — a driver primitive. The harness's five (`press` / `get` / `call` /
  `snapshot` / `interactive`) plus `node` / `reachable` / `eval` / `logs`, and `sleep`
  (`{op:"sleep", ms}`; handled by the runner itself — for animations the settle window
  misses). `ref` addresses a node (press/node/reachable), `sel` a member/method
  (get/call), `args` are `call`'s arguments, `opts` passes through (e.g. press
  `{force}` / `{reachableGate}`), `expr` is `eval`'s expression, `since` is `logs`'
  index, `note` is free-text intent for the report.
- Selectors are copse's usual grammar (`Parent/Child:Comp.prop`, `[i]`) — coir-interoperable.
- **`expect`** — optional subset match (below). **Omitted** → the step passes when
  `result.ok !== false`. Two FACT gates then apply on top of either judgment (the same
  facts `runHarness` hard-gates over the judge's opinion): a result carrying `errors`
  fails the step (errorGate — a handler that threw/logged is never a silent pass), and a
  press with `drove:'nothing'` fails (driveGate — nothing was exercised). An **explicit
  assertion overrides its gate**: an `expect` naming `errors` (asserting the crash IS
  the test) or `drove` (asserting a dead button) wins; `"allowErrors": true` also opts
  out of the error gate. Reachability gating stays on the driver's own
  `opts.reachableGate`. An empty `steps` array proves nothing → `pass:false`.
- **Errors gate — narrowing it without going all-or-nothing.** `allowErrors` is the blunt
  opt-out; two finer levers (on a step, or on the whole script — a step's own wins) keep a real
  crash failing while a chatty game's background noise doesn't:
  - **`ignoreErrors`** — a regex string or array (OR-joined). Errors whose `text` matches are
    dropped from the *gate* (still kept in `result.errors` for visibility). The exact fix for a
    flow whose LAST step gets red-flagged by an unrelated `EventSource … MIME type ("text/plain") …
    Aborting` while its core assertions passed: `"ignoreErrors": ["EventSource", "MIME type"]`.
  - **`errorGate`** — the source floor. `"all"` (default: any console-error or uncaught throw),
    `"uncaught"` (only a real throw — a driver `pageerror` — fails; a `console.error` is tolerated),
    `"off"` (= `allowErrors`). Because the driver already tags each error's `level`
    (`error` = console.error, `pageerror` = uncaught), `"uncaught"` is a reliable "only a genuine
    crash fails" mode.

## Match semantics — subset match, one rule, no DSL

- **Primitives**: `===`.
- **Objects**: every key in `expect` must subset-match the same key in the actual result;
  extra actual keys are ignored — so an `expect` on `changed` names only what you care about.
- **Arrays = contains**: every element of the expected array must subset-match *some*
  element of the actual array (21 activated nodes? asserting
  `[{ "ref": "…/ShopPanel" }]` passes).
- No regexes, no comparators, no wildcards. Want an exact value — write the exact value.

A mismatch reports its path: `{ path: "changed.activated", expected: …, actual: … }`.

## Runner — pure, zero-dep

```js
// src/script.js — same posture as harness.js: consumes the Driver adapter only,
// so it's testable in Node against a fake tree (localDriver), no engine/browser.
runScript(driver, script) → {
  pass: false,
  name: "shop-open-close",
  failedAt: 1,                        // step index; absent when pass:true
  steps: [
    { step: { op: "press", ref: "…" }, ok: true,  ms: 312 },
    { step: { op: "get",   sel: "…" }, ok: false, ms: 8,
      mismatch: { path: "value", expected: "100", actual: "95" },
      result: { ok: true, value: "95" } }   // failed steps carry the full result
  ]
}
// per-step `{step, result}` mirrors runHarness's rounds[].steps — same reading habits.
// a gate failure carries `gate: 'errors' | 'drove'` instead of `mismatch`.
```

## Peeking at values on a green run — `capture`

A failing step always carries its full `result` (for debugging). A **passing** step's result is
governed by `capture`:

- **Read ops auto-capture.** `get` / `pmGet` / `node` / `reachable` / `framework` / `probe` /
  `orient` / `listeners` / `patchCalls` / `diff` ride their (truncated) value along even on green —
  the value *is* the point of a read, so a green `pmGet` no longer forces a redundant single-shot
  `pm_get`/`eval` just to see "active is… what?". Suppress a noisy one with `"capture": false`.
- **Actuations and big list ops stay silent** (`press` / `call` / `pmCall` / `snapshot` /
  `interactive` / `watch` / `network` / `logs` / …) — their result is large and usually asserted via
  `expect`, not eyeballed. Opt a specific one in with `"capture": true` on the step, or set
  `"capture": true` on the whole script to capture *every* passing step.

Captured results use the SAME truncation as `dump_script`'s `observed` (long arrays → first 12,
long strings sliced, depth-bounded), so a live-run value and a dumped step read identically.

## Recording — the MCP session becomes the script

- `tools.js` pushes a step (`{op, ref?/sel?/args?/opts?}` — MCP tool args are already
  these named fields) plus `observed` onto `state.history` after every successful
  `press`/`get`/`call`/`node`/`reachable`/`eval` (and `snapshot`/`interactive`) tool call —
  `observed` is that call's actual result, large payloads truncated. `connect`/`reload`/
  `close` are transport, not steps: never recorded.
- New tool **`dump_script({name?, reset?})`** → `{name, steps:[{…step, observed}]}`.
- **`observed` is NOT auto-promoted to `expect`.** A full-result golden is brittle
  (node lists, timing-adjacent values). The agent that just drove the flow trims each
  `observed` down to the minimal `expect` (usually one or two keys) and saves the file —
  judgment stays where judgment lives.

## Freezing from a harness run

The second freeze path: because a script step IS the harness `Step` shape, a
`runHarness` result converts mechanically —

```js
const steps = report.rounds.flatMap((r) => r.steps);   // [{step, result}, …]
// each s.step is already a script step; trim each s.result into its `expect`
```

— so an exploratory `copse ai` run can be frozen the same way a recorded MCP session
is: keep the steps, distil the observed results into minimal assertions.

## Entry points — three surfaces, 1:1 as always

| surface | usage |
|---|---|
| MCP | `run_script({ script })` → runner result JSON; `dump_script()` exports the recording |
| CLI | `copse run <url> <script.json>` (or `--attach`) → result JSON; exit code `pass ? 0 : 1` for CI |
| library | `import { runScript } from 'copse'` — deterministic CI without MCP |

## Layout

```
src/script.js          — runScript + subsetMatch (pure, @ts-check)
test/script.test.js    — fake driver: subset/contains/sleep/stop-on-fail/errors-fail/allowErrors
src/mcp/tools.js       — run_script, dump_script, history recording (~40 lines)
src/cli.js             — `copse run` subcommand (lazy-imported, as usual)
docs/SCRIPTS.md        — this file (format + semantics + explore→dump→trim→replay workflow)
```

## Relation to the harness

`runHarness` stays untouched — it remains the **exploratory** loop (plan/judge with an
LLM). `runScript` is the **frozen regression** loop. Both consume the same Driver
adapter; a flow found by the former is replayed forever by the latter.
