// The AI-driver loop, tested in Node over a fake driver + a fake (deterministic)
// agent — no engine, no LLM. Proves: plan steps run in order, the judge sees the
// results, throwing steps are captured not fatal, and agent.next bounds iteration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHarness, localDriver } from '../src/harness.js';

// Reuse copse's fake-tree shape (mirrors test/core.test.js) so the driver runs
// through the REAL copse core — the harness is exercised end-to-end over it.
const node = (name, children = [], comps = []) => ({ name, children, comps, active: true, clicked: 0 });
const fakeRuntime = () => ({
  name: (n) => n.name,
  children: (n) => n.children || [],
  isActive: (n) => n.active !== false,
  components: (n) => (n.comps || []).map((c) => ({ type: c.type, raw: c })),
  getComponent: (n, type) => (n.comps || []).find((c) => c.type === type || c.type === `cc.${type}`) || null,
  readProp: (c, p) => c[p],
  callMethod: (c, m, args) => c[m](...args),
  asButton: (n) => (n.comps || []).find((c) => c.type === 'Button') || null,
  isInteractable: (b) => b.interactable !== false,
  clickHandlers: (b) => b.clickEvents || [],
  fireClickHandlers: (b) => { (b.clickEvents || []).forEach((h) => h.fire()); return (b.clickEvents || []).length; },
  emitClick: (n) => { n.clicked++; },
});

function fixture() {
  const handler = { fired: 0, fire() { this.fired++; } };
  const shopBtn = node('ShopBtn', [], [{ type: 'Button', interactable: true, clickEvents: [handler] }]);
  const score = node('Score', [], [{ type: 'Label', string: '0' }]);
  const ctrl = node('Mgr', [], [{ type: 'ShopController', gold: 100, buy(n) { this.gold -= n; return this.gold; } }]);
  const canvas = node('Canvas', [shopBtn, score, ctrl]);
  return { scene: node('Scene', [canvas]), handler };
}

test('runs the plan in order; judge sees the results; buy flow passes', async () => {
  const { scene, handler } = fixture();
  const driver = localDriver(scene, fakeRuntime());

  // AI ① the oracle: from a (pretend) diff, drive the buy flow and read gold back.
  const agent = {
    plan: ({ context }) => ({
      rationale: `diff touched ${context.diff}; exercise the buy flow`,
      steps: [
        { op: 'press', ref: 'Canvas/ShopBtn' },
        { op: 'call', sel: 'Canvas/Mgr:ShopController.buy', args: [30] },
        { op: 'get', sel: 'Canvas/Mgr:ShopController.gold' },
      ],
    }),
    // AI ② judgment: the call returned 70 AND the read-back agrees.
    judge: ({ steps }) => {
      const buy = steps.find((s) => s.step.op === 'call');
      const read = steps.find((s) => s.step.op === 'get');
      const ok = buy?.result?.value === 70 && read?.result?.value === 70;
      return { pass: ok, reason: `gold→${read?.result?.value}`, scope: 'logic' };
    },
  };

  const report = await runHarness(driver, agent, { context: { diff: 'ShopController.buy()' } });

  assert.equal(report.pass, true);
  assert.equal(report.rounds.length, 1);
  assert.equal(handler.fired, 1, 'press ran the real handler');
  const [pressR, callR, getR] = report.rounds[0].steps.map((s) => s.result);
  assert.deepEqual(pressR, { ok: true, ref: 'Canvas/ShopBtn', fired: 1 });
  assert.equal(callR.value, 70);
  assert.equal(getR.value, 70);
  assert.equal(report.rounds[0].verdict.scope, 'logic');
});

test('a throwing step is captured, not fatal; judge can fail on it', async () => {
  const { scene } = fixture();
  // Driver whose press throws — simulates a handler blowing up (a doesn't-crash test).
  const base = localDriver(scene, fakeRuntime());
  const driver = { ...base, press: () => { throw new Error('boom'); } };

  const agent = {
    plan: () => ({ steps: [{ op: 'press', ref: 'Canvas/ShopBtn' }, { op: 'frobnicate' }] }),
    judge: ({ steps }) => ({ pass: steps.every((s) => s.result.ok !== false), reason: 'no errors' }),
  };

  const report = await runHarness(driver, agent);
  assert.equal(report.pass, false, 'thrown + unknown-op steps make the judge fail');
  assert.deepEqual(report.rounds[0].steps[0].result, { ok: false, reason: 'threw', error: 'boom' });
  assert.equal(report.rounds[0].steps[1].result.reason, 'unknown-op');
});

test('agent.next drives iteration, bounded by maxRounds; re-snapshots each round', async () => {
  const { scene } = fixture();
  const driver = localDriver(scene, fakeRuntime());
  let snapshots = 0;
  const counting = { ...driver, snapshot: (o) => { snapshots++; return driver.snapshot(o); } };

  const agent = {
    plan: () => ({ steps: [{ op: 'call', sel: 'Canvas/Mgr:ShopController.buy', args: [10] }] }),
    judge: () => ({ pass: true }),
    next: () => ({ continue: true }), // always wants more — maxRounds is the bound
  };

  const report = await runHarness(counting, agent, { maxRounds: 3 });
  assert.equal(report.rounds.length, 3, 'capped at maxRounds despite next:true');
  // initial snapshot + a re-snapshot after each continuing round (rounds 0 and 1);
  // round 2 hits the cap before re-snapshotting → 1 + 2 = 3
  assert.equal(snapshots, 3, 're-discovered the tree between rounds');
});

test('agent.report: {pass,summary} sets the overall verdict + summary; absent ⇒ no summary; plain return ⇒ summary only', async () => {
  const { scene } = fixture();
  const driver = localDriver(scene, fakeRuntime());
  const base = {
    plan: () => ({ steps: [{ op: 'interactive' }] }),
    judge: () => ({ pass: true }),
  };

  const r1 = await runHarness(driver, base, { context: { goal: 'g' } });
  assert.equal('summary' in r1, false, 'no report stage ⇒ no summary key');

  // {pass, summary}: report's pass is the OVERALL verdict (here it overrides the passing rounds to fail)
  let seen;
  const withReport = {
    ...base,
    report: ({ context, rounds, pass }) => { seen = { context, n: rounds.length, pass }; return { pass: false, summary: { fmt: 'mine' } }; },
  };
  const r2 = await runHarness(driver, withReport, { context: { goal: 'g' } });
  assert.equal(r2.pass, false, 'report.pass overrides the per-round AND');
  assert.deepEqual(r2.summary, { fmt: 'mine' });
  assert.deepEqual(seen, { context: { goal: 'g' }, n: 1, pass: true }, 'report stage sees context + rounds + the per-round pass');

  // a plain (non-{pass}) return is treated as the summary; overall pass stays per-round
  const r3 = await runHarness(driver, { ...base, report: () => 'just text' }, {});
  assert.equal(r3.pass, true);
  assert.equal(r3.summary, 'just text');
});

test('a press to an UNREACHABLE button is a hard fail — overrides a passing judge AND report', async () => {
  const { scene } = fixture();
  const base = localDriver(scene, fakeRuntime());
  // simulate a covered button: the driver's reachability says it's blocked by an overlay
  const driver = { ...base, reachable: (ref) => ({ ok: true, ref, reachable: false, blockedBy: 'Canvas/Popup/mask' }) };
  const agent = {
    plan: () => ({ steps: [{ op: 'press', ref: 'Canvas/ShopBtn' }] }),
    judge: () => ({ pass: true }),                         // the handler fired → judge is happy
    report: () => ({ pass: true, summary: 'looks good' }), // report tries to pass too
  };
  const report = await runHarness(driver, agent);
  assert.equal(report.pass, false, 'a player could not reach the button → hard fail, even over judge+report');
  assert.deepEqual(report.unreachable, [{ ref: 'Canvas/ShopBtn', blockedBy: 'Canvas/Popup/mask' }]);
  assert.equal(report.rounds[0].steps[0].result.unreachable, 'Canvas/Popup/mask', 'surfaced on the step result');

  // force:true (an explicit override) bypasses the reachability gate
  const r2 = await runHarness(driver, { plan: () => ({ steps: [{ op: 'press', ref: 'Canvas/ShopBtn', opts: { force: true } }] }), judge: () => ({ pass: true }) });
  assert.equal(r2.pass, true, 'force:true overrides the reachability gate');
  // reachableGate:false disables it entirely
  const r3 = await runHarness(driver, agent, { reachableGate: false });
  assert.equal(r3.pass, true, 'reachableGate:false disables the gate');
});

test('agent.next absent ⇒ exactly one round (default policy)', async () => {
  const { scene } = fixture();
  const driver = localDriver(scene, fakeRuntime());
  const agent = {
    plan: () => ({ steps: [{ op: 'interactive' }] }),
    judge: () => ({ pass: true }),
  };
  const report = await runHarness(driver, agent, { maxRounds: 5 });
  assert.equal(report.rounds.length, 1, 'no next ⇒ stop after round 0 even with maxRounds 5');
});
