// eval-cond.js — the shared in-page condition/eval helpers. Pure, so unit-tested directly.
// Locks the two code-review fixes: jsonSafe must NOT collapse distinct objects to one constant
// (watch change-detection depended on it), and parseDur must not silently truncate '2m'/'30sec'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonSafe, parseDur } from '../src/core/eval-cond.js';

test('jsonSafe: serialisable values pass through unchanged', () => {
  assert.equal(jsonSafe(true), true);
  assert.equal(jsonSafe(42), 42);
  assert.deepEqual(jsonSafe({ a: 1, b: [2, 3] }), { a: 1, b: [2, 3] });
});

test('jsonSafe: cyclic/unserialisable values become a DISTINCT structural clone (not a constant)', () => {
  const a = { x: 1 }; a.self = a;           // cyclic
  const b = { x: 2 }; b.self = b;           // cyclic, different
  const sa = jsonSafe(a), sb = jsonSafe(b);
  // the OLD String(v) fallback made both '[object Object]' → watch saw two different states as equal
  assert.notEqual(JSON.stringify(sa), JSON.stringify(sb), 'different states must serialise differently');
  assert.equal(JSON.stringify(jsonSafe(a)), JSON.stringify(jsonSafe(a)), 'same state is stable');
  assert.equal(sa.x, 1); assert.equal(sa.self, '[cycle]');
  // a cyclic object with a nested function → clone drops the cycle AND stringifies the fn marker
  const c = { fn() {} }; c.loop = c;
  assert.equal(jsonSafe(c).fn, '[fn]'); assert.equal(jsonSafe(c).loop, '[cycle]');
});

test('parseDur: units ms/s/m + sec/min word forms; number passthrough; default on unparseable', () => {
  assert.equal(parseDur('500ms'), 500);
  assert.equal(parseDur('1s'), 1000);
  assert.equal(parseDur('2m'), 120000);           // was silently truncated to the default before
  assert.equal(parseDur('30sec'), 30000);
  assert.equal(parseDur('90 seconds'), 90000);
  assert.equal(parseDur('3 min'), 180000);
  assert.equal(parseDur('40'), 40);               // bare number → ms
  assert.equal(parseDur(1500), 1500);             // number passthrough
  assert.equal(parseDur(undefined, 40000), 40000);
  assert.equal(parseDur('2x', 40000), 40000);     // genuinely unparseable → default
});
