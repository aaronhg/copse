// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT_VERSION, engineCapabilities } from '../src/capabilities.js';

test('cocos: the full profile — clickSurface + stableRefs + reachability + visual', () => {
  assert.deepEqual(engineCapabilities('cocos'),
    { contractVersion: CONTRACT_VERSION, engine: 'cocos', clickSurface: true, stableRefs: true, reachability: true, visualManifest: true });
});

test('pixi: NO clickSurface, NO stableRefs (positional refs, no serialized handlers) — but reachability + visual', () => {
  assert.deepEqual(engineCapabilities('pixi'),
    { contractVersion: CONTRACT_VERSION, engine: 'pixi', clickSurface: false, stableRefs: false, reachability: true, visualManifest: true });
});

test('no engine detected → an honest zero (never a silent cocos assumption)', () => {
  const zero = { contractVersion: CONTRACT_VERSION, engine: null, clickSurface: false, stableRefs: false, reachability: false, visualManifest: false };
  assert.deepEqual(engineCapabilities(null), zero);
  assert.deepEqual(engineCapabilities(undefined), zero);
  assert.deepEqual(engineCapabilities('nonsense'), zero); // an unknown engine is the same honest zero
});

// The compatibility half of the profile. A consumer (arbor) resolves copse DYNAMICALLY from a path, so
// nothing in npm's resolution ever checks that the two agree — this number is the only thing that can.
// deepEqual above is deliberate: it fails when the shape changes AT ALL, which is the prompt to ask
// whether the change is additive (old consumers unaffected) or breaking (bump CONTRACT_VERSION).
test('capabilities carry a contract version, on every engine including none', () => {
  assert.equal(typeof CONTRACT_VERSION, 'number');
  for (const e of ['cocos', 'pixi', null, undefined, 'nonsense']) {
    assert.equal(engineCapabilities(e).contractVersion, CONTRACT_VERSION,
      'a consumer must be able to check compatibility BEFORE it knows whether an engine resolved');
  }
});
