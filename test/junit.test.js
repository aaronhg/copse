// The JUnit emitter + the multi-script runner, tested in Node over fake results / a fake
// driver — no engine, no XML lib. Proves: valid well-formed XML, one <testcase> per step,
// a failing step emits <failure> with the mismatch reason, counts add up, XML-escaping,
// and runScripts resets between scripts (driver.reload) but no-ops on a reload-less driver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toJUnit } from '../src/junit.js';
import { runScripts } from '../src/script.js';

// A tiny well-formedness check without a dep: Node has no XML parser, so assert the shape
// with regex + bracket balance, and lean on the counts we compute.
function wellFormed(xml) {
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<testsuites /);
  const open = (xml.match(/<testsuite /g) || []).length;
  const close = (xml.match(/<\/testsuite>/g) || []).length;
  assert.equal(open, close, 'balanced <testsuite>');
  const tcOpen = (xml.match(/<testcase /g) || []).length;
  const tcSelfOrClose = (xml.match(/<\/testcase>/g) || []).length;
  assert.equal(tcOpen, tcSelfOrClose, 'every <testcase> is closed');
  return { suites: open, cases: tcOpen };
}

test('toJUnit: green suite → one testcase per step, no failures, counts add up', () => {
  const xml = toJUnit([{
    name: 'shop-open',
    result: { pass: true, steps: [
      { step: { op: 'press', ref: 'Canvas/Btn', note: 'open shop' }, ok: true, ms: 157 },
      { step: { op: 'get', sel: 'Canvas/Gold:Label.string' }, ok: true, ms: 3 },
    ] },
  }]);
  const { suites, cases } = wellFormed(xml);
  assert.equal(suites, 1);
  assert.equal(cases, 2);
  assert.match(xml, /<testsuites name="copse" tests="2" failures="0"/);
  assert.match(xml, /name="shop-open · open shop"/);        // note wins as the label
  assert.match(xml, /name="shop-open · get Canvas\/Gold:Label.string"/); // op+sel fallback
  assert.doesNotMatch(xml, /<failure/);
});

test('toJUnit: a failing step emits <failure> with the mismatch reason, counts the failure', () => {
  const xml = toJUnit([{
    name: 'buy',
    result: { pass: false, failedAt: 0, steps: [
      { step: { op: 'get', sel: 'Canvas/Gold:Label.string' }, ok: false, ms: 2,
        mismatch: { path: 'value', expected: '100', actual: '95' }, result: { ok: true, value: '95' } },
    ] },
  }]);
  wellFormed(xml);
  assert.match(xml, /tests="1" failures="1"/);
  assert.match(xml, /<failure message="expected &quot;100&quot; at value, got &quot;95&quot;">/);
});

test('toJUnit: empty script surfaces as a failing case (proves nothing), and XML-escapes', () => {
  const xml = toJUnit([{ name: 'a<b>&"x', result: { pass: false, steps: [] } }]);
  const { cases } = wellFormed(xml);
  assert.equal(cases, 1);
  assert.match(xml, /failures="1"/);
  assert.match(xml, /name="a&lt;b&gt;&amp;&quot;x/);        // escaped in the suite name
  assert.match(xml, /no steps — proves nothing/);
});

// ---------- runScripts ----------

function fakeDriver() {
  return {
    reloads: 0,
    reload() { this.reloads++; return { ok: true }; },
    get(sel) { return { ok: true, value: sel === 'bad' ? '0' : '100' }; },
  };
}

test('runScripts: aggregates, resets between scripts (not before the first), reports each', async () => {
  const d = fakeDriver();
  const agg = await runScripts(d, [
    { name: 's1', script: { steps: [{ op: 'get', sel: 'ok', expect: { value: '100' } }] } },
    { name: 's2', script: { steps: [{ op: 'get', sel: 'ok', expect: { value: '100' } }] } },
    { name: 's3', script: { steps: [{ op: 'get', sel: 'bad', expect: { value: '100' } }] } }, // fails
  ]);
  assert.equal(agg.total, 3);
  assert.equal(agg.failed, 1);
  assert.equal(agg.pass, false);
  assert.equal(d.reloads, 2);                 // reset between the 3 scripts, not before the first
  assert.deepEqual(agg.suites.map((s) => [s.name, s.result.pass]), [['s1', true], ['s2', true], ['s3', false]]);
  // the aggregate feeds toJUnit directly
  const xml = toJUnit(agg.suites);
  wellFormed(xml);
  assert.match(xml, /tests="3" failures="1"/);
});

test('runScripts: reset:false does not reload; a reload-less driver is a no-op', async () => {
  const noReload = { get: () => ({ ok: true, value: '100' }) };
  const agg = await runScripts(noReload, [
    { name: 'a', script: { steps: [{ op: 'get', sel: 'x' }] } },
    { name: 'b', script: { steps: [{ op: 'get', sel: 'x' }] } },
  ], { reset: true }); // reset requested, but driver has no reload → no throw
  assert.equal(agg.pass, true);

  const d = fakeDriver();
  await runScripts(d, [
    { name: 'a', script: { steps: [{ op: 'get', sel: 'x' }] } },
    { name: 'b', script: { steps: [{ op: 'get', sel: 'x' }] } },
  ], { reset: false });
  assert.equal(d.reloads, 0);                 // reset:false chains on shared state
});
