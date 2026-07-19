// The deterministic flow EXECUTOR + facts, tested in Node over a fake driver — no engine, no LLM, no
// agent, no loop. Proves: `execute` runs the steps in order, captures throws, and reports the five FACT
// buckets (unreachable / errored / undriven / uncertain / visual) — never a pass/fail verdict (the loop
// and the verdict are arbor's layer now).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execute, extractFacts, localDriver } from '../src/harness.js';

// Reuse copse's fake-tree shape (mirrors test/core.test.js) so the driver runs
// through the REAL copse core — execute is exercised end-to-end over it.
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

// ---- execute: runs a step list → { steps, facts } (no agent, no loop, no verdict) ----------------
test('execute: runs the steps in order → { steps, facts }, NO pass/verdict', async () => {
  const { scene, handler } = fixture();
  const driver = localDriver(scene, fakeRuntime());
  const trace = await execute(driver, [
    { op: 'press', ref: 'Canvas/ShopBtn' },
    { op: 'call', sel: 'Canvas/Mgr:ShopController.buy', args: [30] },
    { op: 'get', sel: 'Canvas/Mgr:ShopController.gold' },
  ]);
  assert.equal(trace.steps.length, 3);                 // ran in order
  assert.equal(handler.fired, 1, 'press ran the real handler');
  assert.equal(trace.steps[1].result.value, 70);       // the call actuated
  assert.equal(trace.steps[2].result.value, 70);       // read-back agrees
  assert.ok(!('pass' in trace), 'execute reports facts, never a verdict');
  assert.deepEqual(trace.facts.errored, []);
  assert.deepEqual(trace.facts.undriven, []);
});

test('execute: a throwing / unknown-op step is captured (not fatal); a throw becomes an errored fact', async () => {
  const { scene } = fixture();
  const driver = { ...localDriver(scene, fakeRuntime()), press: () => { throw new Error('boom'); } };
  const trace = await execute(driver, [{ op: 'press', ref: 'Canvas/ShopBtn' }, { op: 'frobnicate' }]);
  assert.deepEqual(trace.steps[0].result, { ok: false, reason: 'threw', error: 'boom' });
  assert.equal(trace.steps[1].result.reason, 'unknown-op');
  assert.equal(trace.facts.errored[0].error, 'boom'); // reason:'threw' → an errored fact
});

// ---- the five FACT buckets (execStep gathers, execute reports — never a hard fail here) -----------
test('facts.unreachable: a press to a covered button (driver.reachable:false); force / reachableGate:false skip the check', async () => {
  const { scene } = fixture();
  const base = localDriver(scene, fakeRuntime());
  const driver = { ...base, reachable: (ref) => ({ ok: true, ref, reachable: false, blockedBy: 'Canvas/Popup/mask' }) };
  const t = await execute(driver, [{ op: 'press', ref: 'Canvas/ShopBtn' }]);
  assert.deepEqual(t.facts.unreachable, [{ ref: 'Canvas/ShopBtn', blockedBy: 'Canvas/Popup/mask' }]);
  assert.equal(t.steps[0].result.unreachable, 'Canvas/Popup/mask', 'surfaced on the step result too');
  // force:true (explicit) bypasses the reachability check → no fact
  assert.deepEqual((await execute(driver, [{ op: 'press', ref: 'Canvas/ShopBtn', opts: { force: true } }])).facts.unreachable, []);
  // reachableGate:false disables the check entirely
  assert.deepEqual((await execute(driver, [{ op: 'press', ref: 'Canvas/ShopBtn' }], { reachableGate: false })).facts.unreachable, []);
});

test('facts.errored: a press whose handler logged an error (engine-swallowed, caught via the log-diff)', async () => {
  const { scene } = fixture();
  // press returns ok:true/fired:1 (looks fine) BUT carries `errors` — a doesn\'t-crash fact, not an opinion.
  const driver = { ...localDriver(scene, fakeRuntime()), press: (ref) => ({ ok: true, ref, fired: 1, errors: [{ level: 'error', text: "TypeError: cannot read 'x' of undefined" }] }) };
  const t = await execute(driver, [{ op: 'press', ref: 'Canvas/ShopBtn' }]);
  assert.equal(t.facts.errored[0].ref, 'Canvas/ShopBtn');
  assert.match(t.facts.errored[0].error, /TypeError/);
});

test('facts.undriven: a press that actuated NOTHING (drove:"nothing") — a fired:0 misread is closed', async () => {
  const { scene } = fixture();
  const driver = { ...localDriver(scene, fakeRuntime()), press: (ref) => ({ ok: true, ref, fired: 0, drove: 'nothing', wired: false }) };
  const t = await execute(driver, [{ op: 'press', ref: 'Canvas/DeadBtn' }]);
  assert.deepEqual(t.facts.undriven, [{ ref: 'Canvas/DeadBtn' }]);
});

test("facts.uncertain: reachable:'unsure' → surfaced (can't confirm reachable — verify, never a silent pass)", async () => {
  const { scene } = fixture();
  const base = localDriver(scene, fakeRuntime());
  const driver = { ...base, reachable: (ref) => ({ ok: true, ref, reachable: 'unsure', blockedBy: null }) };
  const t = await execute(driver, [{ op: 'press', ref: 'Canvas/ShopBtn' }]);
  assert.deepEqual(t.facts.uncertain, [{ ref: 'Canvas/ShopBtn', why: 'unsure' }]);
  assert.equal(t.steps[0].result.uncertain, 'unsure');
});

test('facts.uncertain: a synthetic tap into a no-visible-handler button (drove:[touch], wired:false)', async () => {
  const { scene } = fixture();
  const driver = { ...localDriver(scene, fakeRuntime()), press: (ref) => ({ ok: true, ref, fired: 0, touched: true, drove: ['touch'], wired: false }) };
  const t = await execute(driver, [{ op: 'press', ref: 'Canvas/MaybeDead' }]);
  assert.deepEqual(t.facts.uncertain, [{ ref: 'Canvas/MaybeDead', why: 'touch-into-void' }]);
});

test('facts.visual: a subtree the logic diff SHOWED but did not render (via visualCheck); visualGate:false / no capability = no-op', async () => {
  const { scene } = fixture();
  const base = localDriver(scene, fakeRuntime());
  const driver = {
    ...base,
    press: (ref) => ({ ok: true, ref, fired: 1, drove: ['clickEvent'], changed: { appeared: [], activated: [{ ref: 'Canvas/Panel' }, { ref: 'Canvas/Panel/Title' }, { ref: 'Canvas/Ghost' }], deactivated: [], disappeared: [], labelChanged: [] } }),
    visualCheck: (ref) => ref === 'Canvas/Panel' ? { ref, drawn: false } : ref === 'Canvas/Ghost' ? { ref, drawn: 'unknown', reason: 'offscreen' } : { ref, drawn: true },
  };
  const t = await execute(driver, [{ op: 'press', ref: 'Canvas/ShopBtn' }]);
  assert.deepEqual(t.facts.visual, [
    { press: 'Canvas/ShopBtn', node: 'Canvas/Panel', reason: 'blank' },
    { press: 'Canvas/ShopBtn', node: 'Canvas/Ghost', reason: 'offscreen' },
  ]);
  assert.deepEqual(t.steps[0].result.blankVisual, [{ ref: 'Canvas/Panel', reason: 'blank' }, { ref: 'Canvas/Ghost', reason: 'offscreen' }]);
  // visualGate:false → nothing gathered; a driver with no visualCheck degrades to a no-op (absent, not an error)
  assert.deepEqual((await execute(driver, [{ op: 'press', ref: 'Canvas/ShopBtn' }], { visualGate: false })).facts.visual, []);
  const blind = { ...base, press: driver.press };
  assert.deepEqual((await execute(blind, [{ op: 'press', ref: 'Canvas/ShopBtn' }])).facts.visual, []);
});

test('facts.visual: visualMax caps the per-action checks and records the overflow (no silent truncation)', async () => {
  const { scene } = fixture();
  const base = localDriver(scene, fakeRuntime());
  const activated = [{ ref: 'A' }, { ref: 'B' }, { ref: 'C' }];
  let checked = 0;
  const driver = {
    ...base,
    press: (ref) => ({ ok: true, ref, fired: 1, drove: ['clickEvent'], changed: { appeared: [], activated, deactivated: [], disappeared: [], labelChanged: [] } }),
    visualCheck: (ref) => { checked++; return { ref, drawn: false }; },
  };
  const t = await execute(driver, [{ op: 'press', ref: 'Canvas/ShopBtn' }], { visualMax: 2 });
  assert.equal(checked, 2, 'only visualMax nodes are screenshotted');
  assert.equal(t.steps[0].result.visualCapped, 1, 'the dropped node is recorded, not silently skipped');
});

// ---- extractFacts (pure over a step list) --------------------------------------------------------
test('extractFacts: pure over a step list → the five fact buckets', () => {
  const f = extractFacts([
    { step: { op: 'press', ref: 'A' }, result: { drove: 'nothing' } },
    { step: { op: 'press', ref: 'B' }, result: { unreachable: 'Overlay' } },
    { step: { op: 'get', sel: 'C:X.y' }, result: { reason: 'threw', error: 'boom' } },
    { step: { op: 'press', ref: 'D' }, result: { uncertain: 'unsure' } },
  ]);
  assert.deepEqual(f.undriven, [{ ref: 'A' }]);
  assert.deepEqual(f.unreachable, [{ ref: 'B', blockedBy: 'Overlay' }]);
  assert.deepEqual(f.errored, [{ ref: 'C:X.y', error: 'boom' }]);
  assert.deepEqual(f.uncertain, [{ ref: 'D', why: 'unsure' }]);
});
