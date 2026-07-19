# The deterministic executor (`execute`)

copse ships exactly one AI-testing rail: **`execute(driver, steps, opts?)`** — it
runs a step list against the live page and reports the **FACTS** (each step's
result plus five fact buckets). It does **not** plan, loop, or judge, and it never
decides pass/fail. Like the rest of copse it's **pure and zero-dep** — decoupled
through a single `Driver` adapter, so the package never imports Playwright or an
LLM SDK; you supply the driver at the edge.

The autonomous **LOOP** — plan → execute → judge → iterate — and the pass/fail
**VERDICT / veto** live in the sibling AI-QA framework **arbor**, which *drives*
`execute`: arbor's agent plans copse steps, hands them to `execute`, reads back
the facts, and applies its own veto over them. For the full loop, per-stage
steering, and report shaping, see **arbor** — none of that lives in copse anymore.

| copse — `execute` (this doc) | arbor |
|---|---|
| runs a step list, reports FACTS | plans the steps, judges, iterates |
| no verdict — facts only | the pass/fail VERDICT + veto |
| pure over a `Driver` adapter | the AI seams (plan / judge / next / report) |

> ⚠️ `execute` observes the **node tree** (and, when the driver exposes pixels, a
> soft render check). It states what it saw as facts; it does not opine on
> logic/flow correctness — that judgement is arbor's.

## `execute` — run steps → facts

```js
import { execute, extractFacts, localDriver } from 'copse';
```

Signature:

```
execute(driver, steps, opts?) → Promise<{ steps: [{ step, result }], facts }>
```

- **`steps`** — the copse commands to run, in order (the Step vocabulary below).
- **`steps`** (returned) — each planned step paired with copse's actual return
  value: `{ step, result }`. The raw material a consumer reads back.
- **`facts`** — the five FACT buckets extracted from those results (below).

A throwing step is captured, never fatal: it becomes
`{ ok:false, reason:'threw', error }` (a doesn't-crash signal) and surfaces in
`facts.errored`. An unknown `op` returns `{ ok:false, reason:'unknown-op', op }`.

### The five FACT buckets

`facts` is **FACTS, never a verdict** — copse states what it observed and leaves
pass/fail to the consumer:

| bucket | shape | the fact |
|---|---|---|
| `unreachable` | `[{ ref, blockedBy }]` | a press to a button copse **can** call but a player **cannot** reach — covered by an overlay / off-screen. A hard reachability fact. |
| `errored` | `[{ ref, error }]` | a step that threw, or a press whose handler **logged** an error (engine-swallowed, caught via the log-diff). The doesn't-crash fact. |
| `undriven` | `[{ ref }]` | a press that actuated **nothing** (`drove:'nothing'`) — nothing was wired behind it. |
| `uncertain` | `[{ ref, why }]` | copse couldn't confirm: `reachable:'unsure'`/occluded, or a synthetic tap into a button with no visible handler (`touch-into-void`). **Surfaced to verify — not failed.** |
| `visual` | `[{ press, node, reason }]` | a node the logic diff said appeared/activated but that did **not** render (`blank` / `offscreen`). A soft pixel signal — never a hard fail. |

copse **deliberately does not decide pass/fail**. A press to a covered button, a
handler that threw, a press that drove nothing are reported as FACTS; whether any
of them fails a run is the consumer's call (arbor's veto). `extractFacts(steps)`
is exported too — the pure fact-extraction over a `[{ step, result }]` list, if
you already hold executed steps and just want the buckets.

### `opts` — fact-*gathering* toggles (not a verdict)

`opts` only decides **which facts are gathered** — it is not a verdict:

```
{ reachableGate = true, visualGate = true, visualMax = 4 }
```

- **`reachableGate`** — call `driver.reachable` before each press to gather the
  `unreachable` / `uncertain` facts. A per-step `opts:{ force:true }` bypasses the
  check for that one press.
- **`visualGate`** — after an action whose logic diff shows a subtree appeared or
  activated, run `driver.visualCheck` on those nodes to gather the `visual` fact.
- **`visualMax`** — cap the per-action visual checks (default 4). The overflow is
  recorded (`result.visualCapped`), never silently dropped.

Both gates default on and degrade to a no-op when the driver doesn't expose the
matching capability (`reachable` / `visualCheck`) — so a bare driver just gathers
fewer facts, never errors.

## The `Driver` adapter

`execute` is pure over one adapter — the **`Driver`** — so the package stays
Playwright-free and browser-free. You supply the driver; copse sequences the steps
through it. Methods may be **sync or async** — `execute` awaits either.

```
Driver
  snapshot(opts?)      the node tree
  interactive()        just the interactable nodes
  press(ref, opts?)    fire a button's handler
  get(sel)             read a component member
  call(sel, ...args)   invoke a component method
  reachable(sel)?      OPTIONAL — surfaces the `unreachable` / `uncertain` facts
  visualCheck(ref)?    OPTIONAL — surfaces the `visual` fact (shown-but-not-drawn)
```

In production each method is a `page.evaluate` against the injected
`window.__copse` (build with `npm run build`, inject per
[`inject.md`](INJECT.md)). That impure half stays in **your** test project, not in
the package:

```js
// driver.js (your test project — depends on Playwright; copse does not)
export const playwrightDriver = (page) => ({
  snapshot:    (opts) => page.evaluate((o) => window.__copse.snapshot(o), opts),
  interactive: ()     => page.evaluate(() => window.__copse.interactive()),
  press: (ref, opts)  => page.evaluate(([r, o]) => window.__copse.press(r, o), [ref, opts]),
  get:   (sel)        => page.evaluate((s) => window.__copse.get(s), sel),
  call:  (sel, ...a)  => page.evaluate(([s, args]) => window.__copse.call(s, ...args), [sel, a]),
  // OPTIONAL — add to unlock the reachability facts:
  reachable: (sel)    => page.evaluate((s) => window.__copse.reachable(s), sel),
});
```

For a batteries-included driver that wires all of the above (plus `visualCheck`
via screenshots) against Puppeteer, see `connect()` in
[`src/drivers/puppeteer.js`](../src/drivers/puppeteer.js).

## The Step vocabulary

Each Step is one copse command:

| field | for | value |
|---|---|---|
| `op` | — | `'press' \| 'get' \| 'call' \| 'snapshot' \| 'interactive' \| 'sleep' \| 'patch' \| 'eval'` |
| `ref` | `press` | node path |
| `sel` | `get` / `call` / `patch` | `NodePath:Component.member` (see [SELECTORS](SELECTORS.md)) |
| `args` | `call` | argument array |
| `opts` | `press` (`{force:true}`) / `snapshot` | options |
| `ms` | `sleep` | duration in ms |
| `hooks` | `patch` | `{ before?, after?, replace? }` |
| `expr` | `eval` | expression |
| `note` | any | free-text intent, surfaced to the log |

`sleep` / `patch` / `eval` let a plan pace a turn-based/animated game (sleep
between presses), pin RNG (`patch`), or read arbitrary state (`eval`). `patch` /
`eval` degrade to `{ ok:false, reason:'unsupported-op' }` when the driver lacks
them.

Selector grammar — node paths, the `[i]` same-name-sibling index, and the
`NodePath:Component.member` member form — lives in [SELECTORS](SELECTORS.md).

## Testing without a browser or an LLM

`execute` is pure over the `Driver` adapter, so the whole thing is testable in
Node against a fake tree — no engine, no browser, no LLM, no agent, no loop.
`localDriver(root, rt)` builds an **in-process** driver (same shape as the
Playwright one, but synchronous and engine-free) over a hand-built scene +
Runtime:

```js
import { execute, localDriver } from 'copse';

const driver = localDriver(scene, runtime);   // in-process, synchronous
const { steps, facts } = await execute(driver, [
  { op: 'press', ref: 'Canvas/ShopBtn' },
  { op: 'call',  sel: 'Canvas/Mgr:ShopController.buy', args: [30] },
  { op: 'get',   sel: 'Canvas/Mgr:ShopController.gold' },
]);
// steps[i].result = copse's actual return per step; facts = the five buckets.
```

See [`test/harness.test.js`](../test/harness.test.js) for the buy-flow
round-trip, the throwing-step capture, and each of the five fact buckets — all
deterministic, no LLM. For a real browser game, swap `localDriver` for a
Playwright/Puppeteer driver over `window.__copse` (above).
