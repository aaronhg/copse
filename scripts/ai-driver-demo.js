// @ts-check
// Runnable demo of the AI-driver loop — NO browser, NO real game, NO npm deps.
// Wires the REAL copse core (via `localDriver` over a hand-built fake scene) to a
// REAL `claude -p` agent, then runs `runHarness`. It exercises the whole loop
// (plan → press/get/call → judge → next → report) so you can see the report a
// live run produces; only the scene is faked. For a live game, swap `localDriver`
// for a Playwright driver over `window.__copse` (see ai-driver.md) — agent and
// runHarness unchanged.
//
// Shows the two ways to steer the AI:
//   • per-stage GUIDANCE baked into the agent via makeAgent({ goal, stopCondition, reportFormat })
//   • the same values can also ride in opts.context (passed verbatim to every stage)
//
//   Run:  node examples/ai-driver-demo.js
//   Needs: the `claude` CLI on PATH and logged in (a tool, not a package dep).
//          test/harness.test.js covers the same loop deterministically (fake agent),
//          so this is the "with a real LLM" companion, not a CI gate.
import { execFileSync } from 'node:child_process';
import { runHarness, localDriver } from '../src/index.js';

// ---- a fake "shop" scene + Runtime (same shape as test/core.test.js) --------
const node = (name, children = [], comps = []) => ({ name, children, comps, active: true, clicked: 0 });
const fakeRuntime = () => ({
  name: (n) => n.name,
  children: (n) => n.children || [],
  isActive: (n) => n.active !== false,
  components: (n) => (n.comps || []).map((c) => ({ type: c.type, raw: c })),
  getComponent: (n, t) => (n.comps || []).find((c) => c.type === t || c.type === `cc.${t}`) || null,
  readProp: (c, p) => c[p],
  callMethod: (c, m, args) => c[m](...args),
  asButton: (n) => (n.comps || []).find((c) => c.type === 'Button') || null,
  isInteractable: (b) => b.interactable !== false,
  clickHandlers: (b) => b.clickEvents || [],
  fireClickHandlers: (b) => { (b.clickEvents || []).forEach((h) => h.fire()); return (b.clickEvents || []).length; },
  emitClick: (n) => { n.clicked++; },
});

const ctrl = { type: 'ShopController', gold: 100, buy(cost) { this.gold = Math.max(0, this.gold - cost); return this.gold; } };
const scene = node('Scene', [node('Canvas', [
  node('ShopBtn', [], [{ type: 'Button', interactable: true, clickEvents: [{ fired: 0, fire() { this.fired++; } }] }]),
  node('Score', [], [{ type: 'Label', string: '100' }]),
  node('Mgr', [], [ctrl]),
])]);

const driver = localDriver(scene, fakeRuntime());

// ---- a configurable `claude -p` agent factory -------------------------------
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

const parseJson = (s) => {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fence ? fence[1] : s;
  try { return JSON.parse(body); }
  catch { const m = body.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('no JSON in: ' + s.slice(0, 300)); }
};

/** One `claude -p` call. Returns raw `.result` text; pass json:true to parse it. */
function ask(instruction, payload, model, json) {
  const prompt = `${instruction}\n\nINPUT:\n${JSON.stringify(payload)}`;
  const out = execFileSync(
    'claude',
    ['-p', '--output-format', 'json', '--system-prompt', SYS, '--model', model],
    { input: prompt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: '/tmp' }, // neutral cwd
  );
  const text = JSON.parse(out).result;
  return json ? parseJson(text) : text;
}

/**
 * Build an agent whose stages carry YOUR guidance:
 *   goal          → woven into plan + judge (what to test, what "correct" means)
 *   stopCondition → woven into next        (when to stop iterating)
 *   reportFormat  → woven into report      (what the final summary should look like)
 * Omit reportFormat to skip the report stage (report has no `summary`).
 */
function makeAgent({ model = 'sonnet', goal = '', stopCondition = '', reportFormat = '' } = {}) {
  const g = goal ? `\nTEST GOAL: ${goal}` : '';
  const agent = {
    plan: ({ context, snapshot }) => {
      process.stderr.write('  · plan  (claude -p)…\n');
      return ask(
        'Plan press/get/call steps that exercise what the diff changed, including get steps ' +
        'to capture state before/after. Return ONLY JSON {rationale, steps:[{op,ref?,sel?,args?,note?}]}.' + g,
        { diff: context.diff, snapshot }, model, true,
      );
    },
    judge: ({ context, plan, steps }) => {
      process.stderr.write('  · judge (claude -p)…\n');
      return ask(
        'Judge whether the executed steps show correct logic for the diff and goal. ' +
        'pass=false if any result contradicts expected behavior. Return ONLY JSON {pass, reason, scope:"logic"}.' + g,
        { diff: context.diff, rationale: plan.rationale, steps }, model, true,
      );
    },
  };
  if (stopCondition) {
    agent.next = ({ context, rounds }) => {
      process.stderr.write('  · next  (claude -p)…\n');
      return ask(
        `Decide whether to run another round. STOP CONDITION: ${stopCondition}. ` +
        'Return ONLY JSON {continue, reason}.' + g,
        { diff: context.diff, rounds }, model, true,
      );
    };
  }
  if (reportFormat) {
    agent.report = ({ rounds, pass }) => {
      process.stderr.write('  · report(claude -p)…\n');
      return ask(
        `Write the final test report. FORMAT: ${reportFormat}. Output only the report, no preamble.`,
        { pass, rounds }, model, false, // free text, not JSON
      );
    };
  }
  return agent;
}

// ---- run the loop -----------------------------------------------------------
const diff = `--- a/ShopController.ts
+++ b/ShopController.ts
@@ class ShopController
-  buy(cost) { this.gold -= cost; }
+  buy(cost) { this.gold = Math.max(0, this.gold - cost); }  // clamp at 0`;

const agent = makeAgent({
  goal: 'verify buy() deducts correctly AND clamps gold at 0 on overdraft (never negative)',
  stopCondition: 'stop once both the normal deduction and the clamp-at-0 path are verified',
  reportFormat: 'a short markdown report: a "## Result" heading with PASS or FAIL, then one ' +
    'bullet per step as `selector → result`, then a one-sentence verdict',
});

console.log('DIFF given to the AI:\n' + diff + '\n');
console.log('Running harness (real copse core via localDriver + real claude -p)…\n');

let report;
try {
  report = await runHarness(driver, agent, { context: { diff }, maxRounds: 2 });
} catch (e) {
  const msg = e && e.code === 'ENOENT' ? 'the `claude` CLI was not found on PATH' : (e && e.message) || String(e);
  console.error('\nDemo could not run:', msg);
  console.error('This example needs the Claude Code CLI (`claude`) installed and logged in.');
  process.exit(1);
}

console.log('\n===== STRUCTURED REPORT (always returned) =====');
console.log('pass:', report.pass);
for (const r of report.rounds) {
  console.log(`\n— round ${r.round} —`);
  console.log('rationale:', r.rationale);
  for (const { step, result } of r.steps) {
    console.log('  step ', JSON.stringify(step));
    console.log('   →   ', JSON.stringify(result));
  }
  console.log('verdict:', JSON.stringify(r.verdict));
}

console.log('\n===== report.summary (your reportFormat, written by agent.report) =====');
console.log(report.summary);

console.log('\nfinal ShopController.gold in the live tree:', ctrl.gold);
