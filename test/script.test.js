// The deterministic script runner, tested in Node over a fake Driver — no engine, no
// browser, no LLM. Proves: subset-match semantics (primitives/objects/array-contains +
// mismatch paths), the default ok/errors/drove judgment, expect-overrides-gate, sleep,
// stop-on-first-fail vs continueOnFail, and the {step, result} report shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScript, subsetMatch } from '../src/script.js';

// A fake Driver returning canned results per ref/sel (mirrors test/mcp.test.js's fakeCp).
function fakeDriver(overrides = {}) {
  return {
    calls: [],
    snapshot(o) { this.calls.push(['snapshot', o]); return [{ ref: 'Canvas/Btn', button: true }]; },
    interactive() { this.calls.push(['interactive']); return [{ ref: 'Canvas/Btn', reachable: true }]; },
    press(ref, o) { this.calls.push(['press', ref, o]); return { ok: true, ref, fired: 1, drove: ['clickEvent'], changed: { activated: [{ ref: 'Canvas/ShopPanel', label: 'SHOP' }, { ref: 'Canvas/ShopPanel/mask' }] } }; },
    get(sel) { this.calls.push(['get', sel]); return { ok: true, value: '100' }; },
    call(sel, ...a) { this.calls.push(['call', sel, a]); return { ok: true, value: a[0] }; },
    node(ref) { this.calls.push(['node', ref]); return { ok: true, active: true, opacity: 255 }; },
    reachable(ref) { this.calls.push(['reachable', ref]); return { ok: true, reachable: false, blockedBy: 'Canvas/Mask' }; },
    logs(since = 0) { this.calls.push(['logs', since]); return []; },
    ...overrides,
  };
}

// ---------- subsetMatch ----------

test('subsetMatch: primitives ===, object subset, extra actual keys ignored', () => {
  assert.equal(subsetMatch(1, 1), null);
  assert.equal(subsetMatch({ ok: true }, { ok: true, value: 7, extra: 'x' }), null);
  const m = subsetMatch({ value: '100' }, { ok: true, value: '95' });
  assert.deepEqual(m, { path: 'value', expected: '100', actual: '95' });
});

test('subsetMatch: arrays are CONTAINS — each expected element matches SOME actual element', () => {
  const actual = { changed: { activated: [{ ref: 'A' }, { ref: 'B', label: 'hi' }] } };
  assert.equal(subsetMatch({ changed: { activated: [{ ref: 'B' }] } }, actual), null);
  const m = subsetMatch({ changed: { activated: [{ ref: 'C' }] } }, actual);
  assert.equal(m.path, 'changed.activated[0]');
  assert.deepEqual(m.expected, { ref: 'C' });
});

test('subsetMatch: type mismatches fail with a path', () => {
  assert.ok(subsetMatch([1], { a: 1 }));            // expected array, actual object
  assert.ok(subsetMatch({ a: 1 }, null));           // expected object, actual null
  assert.equal(subsetMatch(null, null), null);      // null === null
  assert.ok(subsetMatch({ a: { b: 2 } }, { a: { b: 3 } }).path === 'a.b');
});

// ---------- runScript ----------

test('a green flow: expects hold, per-step {step, ok, ms}; read ops capture their value, actuations omit it', async () => {
  const d = fakeDriver();
  const r = await runScript(d, {
    name: 'shop-open',
    steps: [
      { op: 'press', ref: 'Canvas/ShopBtn', expect: { ok: true, changed: { activated: [{ ref: 'Canvas/ShopPanel' }] } } },
      { op: 'get', sel: 'Canvas/Gold:Label.string', expect: { value: '100' } },
      { op: 'call', sel: 'Canvas/Mgr:Shop.buy', args: [30], expect: { value: 30 } },
    ],
  });
  assert.equal(r.pass, true);
  assert.equal(r.name, 'shop-open');
  assert.equal(r.failedAt, undefined);
  assert.equal(r.steps.length, 3);
  for (const s of r.steps) { assert.equal(s.ok, true); assert.equal(typeof s.ms, 'number'); }
  const [pr, g, cl] = r.steps;
  assert.equal(pr.result, undefined);                       // press: actuation → omitted
  assert.deepEqual(g.result, { ok: true, value: '100' });   // get: read → auto-captured (the whole point of a read)
  assert.equal(cl.result, undefined);                       // call: actuation → omitted
  assert.deepEqual(d.calls[2], ['call', 'Canvas/Mgr:Shop.buy', [30]]);
});

test('capture: read ops auto-capture on green; capture:false opts out; an actuation captures only with capture:true', async () => {
  const d = fakeDriver();
  const r = await runScript(d, {
    steps: [
      { op: 'get', sel: 'x' },                           // read → auto-capture (truncated)
      { op: 'node', ref: 'Canvas/Panel' },               // read → auto-capture
      { op: 'get', sel: 'y', capture: false },           // read but opted OUT → omitted
      { op: 'press', ref: 'Canvas/ShopBtn' },            // actuation → omitted by default
      { op: 'press', ref: 'Canvas/ShopBtn', capture: true }, // actuation forced → captured
    ],
  });
  assert.equal(r.pass, true);
  assert.deepEqual(r.steps[0].result, { ok: true, value: '100' });
  assert.deepEqual(r.steps[1].result, { ok: true, active: true, opacity: 255 });
  assert.equal(r.steps[2].result, undefined);
  assert.equal(r.steps[3].result, undefined);
  assert.equal(r.steps[4].result.ok, true);              // forced capture on a passing actuation
});

test('a mismatch fails the step with a path, carries the full result, and stops the run', async () => {
  const d = fakeDriver();
  const r = await runScript(d, {
    steps: [
      { op: 'get', sel: 'Canvas/Gold:Label.string', expect: { value: '95' } },
      { op: 'press', ref: 'Canvas/Never' },
    ],
  });
  assert.equal(r.pass, false);
  assert.equal(r.failedAt, 0);
  assert.equal(r.steps.length, 1);                       // stopped — press never ran
  assert.deepEqual(r.steps[0].mismatch, { path: 'value', expected: '95', actual: '100' });
  assert.deepEqual(r.steps[0].result, { ok: true, value: '100' });
  assert.equal(d.calls.length, 1);
});

test('continueOnFail runs every step; failedAt is the FIRST failure', async () => {
  const d = fakeDriver();
  const r = await runScript(d, {
    continueOnFail: true,
    steps: [
      { op: 'get', sel: 'a', expect: { value: 'wrong' } },
      { op: 'get', sel: 'b', expect: { value: '100' } },
      { op: 'get', sel: 'c', expect: { value: 'also-wrong' } },
    ],
  });
  assert.equal(r.pass, false);
  assert.equal(r.failedAt, 0);
  assert.equal(r.steps.length, 3);
  assert.deepEqual(r.steps.map((s) => s.ok), [false, true, false]);
});

test('no expect: ok:false fails, ok:true passes; a thrown step is captured as a fail', async () => {
  const d = fakeDriver({
    get(sel) { return sel === 'bad' ? { ok: false, reason: 'no-node' } : { ok: true, value: 1 }; },
    call() { throw new Error('kaboom'); },
  });
  const good = await runScript(d, { steps: [{ op: 'get', sel: 'fine' }] });
  assert.equal(good.pass, true);
  const bad = await runScript(d, { steps: [{ op: 'get', sel: 'bad' }] });
  assert.equal(bad.pass, false);
  assert.equal(bad.steps[0].result.reason, 'no-node');
  const threw = await runScript(d, { steps: [{ op: 'call', sel: 'x:Y.z' }] });
  assert.equal(threw.pass, false);
  assert.equal(threw.steps[0].result.reason, 'threw');
  assert.match(threw.steps[0].result.error, /kaboom/);
});

test('a thrown step keeps the driver error CLASS, not just its sentence', async () => {
  // The runner stops at the first failed step and has no retry, so "the game was still booting" and "your
  // selector is wrong" must be distinguishable as DATA. Prose is unusable here — nobody should have to
  // regex an error sentence to decide whether a rerun is worth it.
  const boom = (recoverable, code) => Object.assign(new Error('nope'), { copse: true, recoverable, code });
  const d = {
    get: async () => { throw boom(true, 'init-pending'); },
    call: async () => { throw boom(false, 'op-timeout'); },
  };
  const r1 = await runScript(d, { steps: [{ op: 'get', sel: 'x' }] });
  assert.equal(r1.steps[0].result.recoverable, true);
  assert.equal(r1.steps[0].result.code, 'init-pending');

  const r2 = await runScript(d, { steps: [{ op: 'call', sel: 'x:Y.z' }] });
  assert.equal(r2.steps[0].result.code, 'op-timeout');
  // absent, not `false` — a plain error carries no claim either way, and inventing one would be a lie
  assert.equal('recoverable' in r2.steps[0].result, false);

  const plain = await runScript({ get: async () => { throw new Error('kaboom'); } }, { steps: [{ op: 'get', sel: 'x' }] });
  assert.equal('recoverable' in plain.steps[0].result, false);
  assert.equal('code' in plain.steps[0].result, false);
});

test('errors gate: result.errors fails even a matching expect; allowErrors or an explicit errors expect opts out', async () => {
  const d = fakeDriver({ press(ref) { return { ok: true, ref, fired: 1, drove: ['clickEvent'], errors: [{ level: 'error', text: 'TypeError: boom' }] }; } });
  const gated = await runScript(d, { steps: [{ op: 'press', ref: 'X', expect: { ok: true } }] });
  assert.equal(gated.pass, false);
  assert.equal(gated.steps[0].gate, 'errors');
  const allowed = await runScript(d, { steps: [{ op: 'press', ref: 'X', allowErrors: true }] });
  assert.equal(allowed.pass, true);
  const asserted = await runScript(d, { steps: [{ op: 'press', ref: 'X', expect: { errors: [{ text: 'TypeError: boom' }] } }] });
  assert.equal(asserted.pass, true);                     // explicitly asserting the error IS the test
});

test('errors gate: ignoreErrors drops matching background noise (step or script level); a non-matching error still fails', async () => {
  const sse = { level: 'error', text: 'EventSource\'s response has a MIME type ("text/plain")… Aborting the connection.' };
  const d = fakeDriver({ press: (ref) => ({ ok: true, ref, fired: 1, drove: ['clickEvent'], errors: [sse] }) });
  // unfiltered → the background SSE error gates the step
  assert.equal((await runScript(d, { steps: [{ op: 'press', ref: 'X' }] })).steps[0].gate, 'errors');
  // step-level pattern → passes (and the error is still on the result for visibility)
  const stepIg = await runScript(d, { steps: [{ op: 'press', ref: 'X', ignoreErrors: 'EventSource|MIME type' }] });
  assert.equal(stepIg.pass, true);
  // script-level pattern (array) → applies to every step
  assert.equal((await runScript(d, { ignoreErrors: ['EventSource'], steps: [{ op: 'press', ref: 'X' }] })).pass, true);
  // a real error that does NOT match the filter still fails through the same gate
  const d2 = fakeDriver({ press: (ref) => ({ ok: true, ref, fired: 1, drove: ['clickEvent'], errors: [{ level: 'pageerror', text: 'TypeError: boom' }] }) });
  assert.equal((await runScript(d2, { steps: [{ op: 'press', ref: 'X', ignoreErrors: 'EventSource' }] })).steps[0].gate, 'errors');
});

test("errorGate:'uncaught' tolerates a console.error but still fails on a real throw; 'off' disables the gate", async () => {
  const consoleErr = { level: 'error', text: '[GameLog] a recoverable warning logged via console.error' };
  const thrown = { level: 'pageerror', text: 'TypeError: cannot read x of undefined' };
  const withErrs = (errs) => fakeDriver({ press: (ref) => ({ ok: true, ref, fired: 1, drove: ['clickEvent'], errors: errs }) });
  assert.equal((await runScript(withErrs([consoleErr]), { steps: [{ op: 'press', ref: 'X', errorGate: 'uncaught' }] })).pass, true);          // console.error tolerated
  assert.equal((await runScript(withErrs([thrown]), { steps: [{ op: 'press', ref: 'X', errorGate: 'uncaught' }] })).steps[0].gate, 'errors'); // a real throw still fails
  assert.equal((await runScript(withErrs([thrown]), { steps: [{ op: 'press', ref: 'X', errorGate: 'off' }] })).pass, true);                    // 'off' → nothing gates
});

test("drove gate: a press that actuated nothing fails; an explicit drove expect overrides", async () => {
  const d = fakeDriver({ press(ref) { return { ok: true, ref, fired: 0, drove: 'nothing' }; } });
  const gated = await runScript(d, { steps: [{ op: 'press', ref: 'X' }] });
  assert.equal(gated.pass, false);
  assert.equal(gated.steps[0].gate, 'drove');
  const asserted = await runScript(d, { steps: [{ op: 'press', ref: 'X', expect: { drove: 'nothing' } }] });
  assert.equal(asserted.pass, true);                     // asserting "this button is dead" is a valid test
});

test('sleep waits and passes; unknown / driver-unsupported ops fail loud', async () => {
  const d = fakeDriver();
  const t0 = Date.now();
  const slept = await runScript(d, { steps: [{ op: 'sleep', ms: 30 }, { op: 'get', sel: 'x' }] });
  assert.equal(slept.pass, true);
  assert.ok(Date.now() - t0 >= 25, 'actually slept');
  const unknown = await runScript(d, { steps: [{ op: 'frobnicate' }] });
  assert.equal(unknown.pass, false);
  assert.equal(unknown.steps[0].result.reason, 'unknown-op');
  const unsupported = await runScript({ get: d.get.bind(d) }, { steps: [{ op: 'press', ref: 'X' }] });
  assert.equal(unsupported.pass, false);
  assert.equal(unsupported.steps[0].result.reason, 'unsupported-op');
});

test('an empty script proves nothing → pass:false', async () => {
  assert.equal((await runScript(fakeDriver(), { steps: [] })).pass, false);
  assert.equal((await runScript(fakeDriver(), {})).pass, false);
});
