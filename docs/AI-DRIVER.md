# The AI-driver harness

`runHarness(driver, agent, opts)` (in `src/harness.js`) is the autonomous test
loop — **pure and zero-dep**, like the rest of copse. It's decoupled through two
adapters, so the package never imports Playwright or an LLM SDK; you supply those
at the edges. The AI intervention points are literal adapter methods:

```
agent.plan(ctx)   → AI ①  read diff + live snapshot → what to test + EXPECTED outcome (the oracle) → steps
driver.<op>(...)  → 機械   press / get / call against the live page (deterministic copse rail)
agent.judge(ctx)  → AI ②  state delta vs expectation → pass / fail
agent.next(ctx)   → AI ③  coverage / iterate decision (optional; absent ⇒ stop after one round)
agent.report(ctx) → AI ④  shape the final report in your format (optional; → report.summary)
```

The loop: `snapshot → (plan → execute → judge) → maybe iterate → report`, bounded
by `maxRounds`. It's policy-free — the agent decides *what* and *whether*; the
harness only sequences, captures every result, and caps the rounds. A throwing
step is captured as `{ok:false, reason:'threw', error}` (a doesn't-crash signal),
never fatal.

**Steering each stage.** The harness stays prompt-agnostic — it passes
`ctx.context` (whatever you put in `opts.context`) verbatim to every stage. So
per-run direction rides there, and static direction is baked into the agent. A
factory makes both ergonomic — see **Steering each stage** below.

> ⚠️ The agent is fed the **node tree, not pixels** — its verdict is scoped to
> *logic/flow correctness*, never rendering or reachability. A covered/off-screen
> button passes here but fails for a real player. Have the judge say so in `scope`.

## 1. The driver — copse over Playwright

Each method is a `page.evaluate` against the injected `window.__copse` (build it
with `npm run build`, inject per [`inject.md`](INJECT.md)). This is the only
"impure" half on the copse side — and it stays in your test project, not in the
package.

```js
// driver.js (your test project — depends on Playwright, copse does not)
export const playwrightDriver = (page) => ({
  snapshot:    (opts) => page.evaluate((o) => window.__copse.snapshot(o), opts),
  interactive: ()     => page.evaluate(() => window.__copse.interactive()),
  press: (ref, opts)  => page.evaluate(([r, o]) => window.__copse.press(r, o), [ref, opts]),
  get:   (sel)        => page.evaluate((s) => window.__copse.get(s), sel),
  call:  (sel, ...a)  => page.evaluate(([s, args]) => window.__copse.call(s, ...args), [sel, a]),
});
```

## 2. The agent — the three AI seams as Claude calls

Uses `@anthropic-ai/sdk` with `claude-opus-4-8` + adaptive thinking, and
constrains each call to a JSON schema via `output_config.format` so the plan /
verdict come back validated. (Again: a dep of your test project, not of copse.)

```js
// agent.js (your test project)
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();           // reads ANTHROPIC_API_KEY
const MODEL = 'claude-opus-4-8';

const STEP = {
  type: 'object', additionalProperties: false,
  properties: {
    op:   { type: 'string', enum: ['press', 'get', 'call', 'snapshot', 'interactive'] },
    ref:  { type: 'string' }, sel: { type: 'string' },
    args: { type: 'array', items: {} }, note: { type: 'string' },
  },
  required: ['op'],
};
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { rationale: { type: 'string' }, steps: { type: 'array', items: STEP } },
  required: ['steps'],
};
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    pass:   { type: 'boolean' },
    reason: { type: 'string' },
    scope:  { type: 'string', enum: ['logic'] },   // never claims visual/reachability
  },
  required: ['pass', 'reason', 'scope'],
};

// Constrained JSON call → parsed object. Adaptive thinking on; short output, so non-streaming is fine.
async function ask(system, payload, schema) {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  });
  const text = res.content.find((b) => b.type === 'text')?.text ?? '{}';
  return JSON.parse(text);
}

const SYS =
  'You drive a LIVE Cocos game through copse — call wired handlers and read component ' +
  'state; you do NOT see pixels. Test LOGIC/FLOW only (a covered/off-screen button still ' +
  '"passes" here).\n' +
  'Selector grammar: a node path is Parent/Child relative to the scene root; [i] picks the ' +
  'i-th same-name sibling; a MEMBER selector is "NodePath:Component.member".\n' +
  'Field rules per step op (copy these shapes exactly):\n' +
  '  press → { "op":"press", "ref":"Canvas/ShopBtn" }                (ref = node path)\n' +
  '  get   → { "op":"get",  "sel":"Canvas/Mgr:ShopController.gold" } (sel = FULL NodePath:Component.member)\n' +
  '  call  → { "op":"call", "sel":"Canvas/Mgr:ShopController.buy", "args":[30] }\n' +
  'For get/call the whole "NodePath:Component.member" goes in sel — NEVER put the node ' +
  'path in ref or split it off from the member.';

export const claudeAgent = {
  // AI ① the oracle: decide what to test + the expected result, emit copse steps.
  plan: ({ context, snapshot }) =>
    ask(
      SYS + ' Given the diff and the live snapshot, plan press/get/call steps that ' +
      'exercise what the diff changed, including get steps to capture state before/after.',
      { diff: context.diff, snapshot },
      PLAN_SCHEMA,
    ),

  // AI ② judgment: did the observed state delta match what the diff implies?
  judge: ({ context, plan, steps }) =>
    ask(
      SYS + ' Judge whether the executed steps show correct logic for the diff. ' +
      'Return pass=false if any result contradicts the expected behavior.',
      { diff: context.diff, rationale: plan.rationale, steps },
      VERDICT_SCHEMA,
    ),

  // AI ③ (optional) coverage: another round, or done? Drop this to stop after one.
  next: async ({ context, rounds }) => {
    const v = await ask(
      SYS + ' Given the rounds so far, is there an untested branch worth a follow-up ' +
      'round (edge case, idempotency, a sibling flow)? Keep it bounded.',
      { diff: context.diff, rounds },
      { type: 'object', additionalProperties: false,
        properties: { continue: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['continue'] },
    );
    return v;
  },
};
```

## 2b. Alternative agent — `claude -p` (no SDK, no API key)

The agent is just an adapter, so you can back it with the **Claude Code CLI in
print mode** instead of the SDK. Upsides: no `@anthropic-ai/sdk` dependency
(stays zero-dep), no `ANTHROPIC_API_KEY` to manage — it uses your local Claude
Code login/subscription, and `total_cost_usd` comes back in the envelope. Trade-
off: no `output_config.format` schema enforcement, so you instruct "JSON only"
and parse it yourself (the CLI also sometimes wraps the JSON in ```` ```json ````
fences — strip them), and each call pays CLI + agent-loop startup overhead.

`claude -p` reads the prompt from **stdin** (so a large snapshot needs no shell
escaping) and `--output-format json` returns an envelope whose `.result` field is
the model's text. Verified against Claude Code 2.1.x.

```js
// agent-cli.js (your test project) — same Agent shape, driven by `claude -p`.
import { execFileSync } from 'node:child_process';

const MODEL = 'opus'; // alias (opus|sonnet|haiku) or a full id like claude-opus-4-8

const SYS =
  'You drive a LIVE Cocos game through copse — call wired handlers and read component ' +
  'state; you do NOT see pixels. Test LOGIC/FLOW only (a covered/off-screen button still ' +
  '"passes" here).\n' +
  'Selector grammar: a node path is Parent/Child relative to the scene root; [i] picks the ' +
  'i-th same-name sibling; a MEMBER selector is "NodePath:Component.member".\n' +
  'Field rules per step op (copy these shapes exactly):\n' +
  '  press → { "op":"press", "ref":"Canvas/ShopBtn" }                (ref = node path)\n' +
  '  get   → { "op":"get",  "sel":"Canvas/Mgr:ShopController.gold" } (sel = FULL NodePath:Component.member)\n' +
  '  call  → { "op":"call", "sel":"Canvas/Mgr:ShopController.buy", "args":[30] }\n' +
  'For get/call the whole "NodePath:Component.member" goes in sel — NEVER put the node ' +
  'path in ref or split it off from the member.';

// Strip ```json fences the model sometimes adds, then parse.
const parseJson = (s) => {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return JSON.parse(m ? m[1] : s);
};

function askCli(instruction, shape, payload) {
  const prompt =
    `${instruction}\n\nReturn ONLY a JSON object of the form ${shape} — ` +
    `no prose, no code fences.\n\nINPUT:\n${JSON.stringify(payload)}`;
  const out = execFileSync(
    'claude',
    ['-p', '--output-format', 'json', '--system-prompt', SYS, '--model', MODEL],
    { input: prompt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return parseJson(JSON.parse(out).result); // envelope.result → the model's JSON text
}

export const claudeCliAgent = {
  // AI ① the oracle
  plan: ({ context, snapshot }) =>
    askCli(
      'Plan press/get/call steps that exercise what the diff changed, including ' +
      'get steps to capture state before/after.',
      '{rationale, steps:[{op,ref?,sel?,args?,note?}]}',
      { diff: context.diff, snapshot },
    ),
  // AI ② judgment
  judge: ({ context, plan, steps }) =>
    askCli(
      'Judge whether the executed steps show correct logic for the diff. ' +
      'pass=false if any result contradicts expected behavior.',
      '{pass, reason, scope:"logic"}',
      { diff: context.diff, rationale: plan.rationale, steps },
    ),
  // AI ③ (optional) coverage
  next: ({ context, rounds }) =>
    askCli(
      'Is there an untested branch worth a bounded follow-up round?',
      '{continue, reason?}',
      { diff: context.diff, rounds },
    ),
};
```

`execFileSync` blocks while the model thinks — fine for a test harness (you're
between page actions). Swap to `spawn` + stdin if you need it non-blocking. The
print-mode agent has tools enabled by default; this task is self-contained so it
answers in one turn, but add `--disallowedTools` if you want to forbid them.

Then in the test, import `claudeCliAgent` instead of `claudeAgent` — `runHarness`
is identical either way.

## 3. Wire it into a Playwright test

```js
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { runHarness } from 'copse';
import { playwrightDriver } from './driver.js';
import { claudeAgent } from './agent.js';   // or: import { claudeCliAgent } from './agent-cli.js' (no SDK)

const bridge = fs.readFileSync('./node_modules/copse/dist/copse.inject.js', 'utf8'); // npm run build first

test('AI drives the flow the diff touched', async ({ page }) => {
  await page.addInitScript(bridge);
  await page.goto('http://localhost:7456/');          // Cocos preview
  await page.waitForFunction(() => !!window.__copse);  // auto-installs once cc boots

  const diff = execSync('git diff --stat HEAD~1').toString();   // what changed
  const report = await runHarness(playwrightDriver(page), claudeAgent, {
    context: { diff },
    maxRounds: 3,
  });

  console.log(JSON.stringify(report.rounds, null, 2));  // the AI's plan + results + verdicts
  expect(report.pass).toBe(true);
});
```

## Steering each stage — goal, stop condition, report format

Prompts live in the agent, not the harness. Two ways to inject your direction:

1. **Per-run, via `context`** — the harness passes `opts.context` verbatim to
   every stage, so put run-specific guidance there and read it in the agent:
   ```js
   runHarness(driver, agent, {
     context: {
       diff,
       goal: 'verify buy() clamps gold at 0 on overdraft',
       stopCondition: 'stop once normal + clamp paths are both verified',
       reportFormat: 'a markdown table of step→result, then PASS/FAIL + one-line reason',
     },
     maxRounds: 3,
   });
   ```
2. **Static, via an agent factory** — bake guidance into each stage once:
   ```js
   function makeAgent({ model = 'opus', goal = '', stopCondition = '', reportFormat = '' } = {}) {
     const g = goal ? `\nTEST GOAL: ${goal}` : '';
     const agent = {
       plan:  ({ context, snapshot }) => ask('Plan steps…' + g, { diff: context.diff, snapshot }, PLAN_SCHEMA),
       judge: ({ context, steps })    => ask('Judge pass/fail…' + g, { diff: context.diff, steps }, VERDICT_SCHEMA),
     };
     if (stopCondition) agent.next   = ({ context, rounds }) => ask(`Another round? STOP WHEN: ${stopCondition}.`, { rounds }, NEXT_SCHEMA);
     if (reportFormat)  agent.report = ({ rounds, pass })    => askText(`Write the report. FORMAT: ${reportFormat}.`, { pass, rounds });
     return agent;
   }
   ```
   `goal` steers plan + judge (what to test, what "correct" means), `stopCondition`
   steers next (when to stop), `reportFormat` steers report (what you want to see).

### What the report looks like

`runHarness` always returns this **structured** object — the raw material you can
reshape in code however you like:

```js
{
  pass: boolean,            // rounds.length > 0 && every round's verdict.pass !== false
  rounds: [
    {
      round: number,        // 0-based
      rationale: string,    // from agent.plan — why these steps
      steps: [ { step, result } ],   // each planned step + copse's actual return value
      verdict: { pass, reason, scope },   // from agent.judge
    },
  ],
  snapshot: any,            // the last live snapshot taken
  summary?: any,            // ONLY if you provide agent.report — its return value, in your format
}
```

So you get the report your way two ways: post-process the structured object in
code, or set `reportFormat` and let `agent.report` write `summary` (free text,
JSON, JUnit-ish — whatever your `report` method returns). A runnable example that
sets all of goal / stopCondition / reportFormat is
[`ai-driver-demo.js`](../scripts/ai-driver-demo.js).

## How a plan is produced

The plan is not a script — it's a single LLM call (`agent.plan`) given **the rules +
your goal + the current live snapshot**, returning `{rationale, steps}`. Pipeline:

```
harness takes a fresh snapshot:  driver.snapshot()  → page.evaluate → __copse.snapshot()
        │   (state-dependent: 62 nodes on the home scene; 110 after a panel opened)
        ▼
agent.plan(ctx):
  1. trim(snapshot)        keep button|label|interactable nodes; drop the minified components
  2. prompt = instruction + GOAL + "INPUT:\n" + JSON(trimmed snapshot)
  3. claude -p / SDK call with system = SYS  (selector grammar + per-op field rules)
  4. parse → { rationale, steps:[{op, ref?, sel?, args?}] }
```

Three inputs shape every plan (all reach the stage via `ctx`):

| input | what it is | role |
|---|---|---|
| **SYS** (system prompt) | copse selector grammar + field rules (`press→ref`, `get/call→sel="Path:Comp.member"`) | how to phrase commands |
| **GOAL** (in `ctx.context` or baked by the factory) | "test the buy clamp" / "explore the home UI, avoid spending" | what to achieve |
| **snapshot** (the live tree) | `ref / button / interactable / label / click` per node | what's actually on screen *now* |

So the model picks targets **from the current snapshot**. Worked example — a
dev/preview run, Round 0: the snapshot showed `…/btn_panel` with
`click:[{component:"PanelUI", handler:"show"}]` and `…/coinLabel` with
`label:"1000"`, so the plan chose `press btn_panel` (to open a panel) and
`get …/coinLabel:Label.string` (to read state) — both inferred from the snapshot,
nothing hardcoded.

**Proof it's state-driven, not a fixed script:** Round 1's plan differed from Round 0's
*because the snapshot it was given differed* — pressing `btn_panel` grew the tree 62 → 110
nodes (the panel stacked on Home), so Round 1 planned against the new state
(and even targeted `Canvas/Popup/btn_close`, which only exists once the panel is open).

One line: **plan = LLM(copse selector rules + your goal + current live snapshot) → copse steps.**

## Testing the loop without a browser or an LLM

`runHarness` is pure, so the whole loop is testable in Node against fakes — a
fake driver and a deterministic agent. `localDriver(scene, runtime)` builds the
driver over an in-process tree (same shape as the Playwright one). See
[`test/harness.test.js`](../test/harness.test.js) for the buy-flow round-trip,
the throwing-step capture, and the iteration-bound tests (deterministic, no LLM).

For a runnable end-to-end demo with a **real** LLM but no browser/game, see
[`ai-driver-demo.js`](../scripts/ai-driver-demo.js): `localDriver` over a fake shop scene +
the `claude -p` agent. `node scripts/ai-driver-demo.js` prints the same `report`
shape a live run produces (plan → results → verdict). Needs the `claude` CLI
logged in; swap `localDriver` → a Playwright driver to point it at a real game.
