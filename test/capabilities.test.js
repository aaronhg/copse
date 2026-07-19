// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineCapabilities } from '../src/capabilities.js';

test('cocos: the full profile — clickSurface + stableRefs + reachability + visual', () => {
  assert.deepEqual(engineCapabilities('cocos'),
    { engine: 'cocos', clickSurface: true, stableRefs: true, reachability: true, visualManifest: true });
});

test('pixi: NO clickSurface, NO stableRefs (positional refs, no serialized handlers) — but reachability + visual', () => {
  assert.deepEqual(engineCapabilities('pixi'),
    { engine: 'pixi', clickSurface: false, stableRefs: false, reachability: true, visualManifest: true });
});

test('no engine detected → an honest zero (never a silent cocos assumption)', () => {
  const zero = { engine: null, clickSurface: false, stableRefs: false, reachability: false, visualManifest: false };
  assert.deepEqual(engineCapabilities(null), zero);
  assert.deepEqual(engineCapabilities(undefined), zero);
  assert.deepEqual(engineCapabilities('nonsense'), zero); // an unknown engine is the same honest zero
});
