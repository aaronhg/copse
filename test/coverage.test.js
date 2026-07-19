// The coir↔copse selector RESOLVERS (resolveCoirPath / resolveCopseRef) — translate a coir static
// nodePath ↔ a copse runtime ref against a live view (the symmetric tail match absorbs coir's scene/
// prefab-file root prefix and a prefab's instantiation mount). These stay in copse because they resolve
// against a LIVE runtime view. The coverageJoin buckets moved to arbor (test/join.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCoirPath, resolveCopseRef } from '../src/coverage.js';

// ---- selector resolvers (coir path ↔ copse ref) ----------------------------------------
test('resolveCoirPath: coir path → live ref, dropping the scene-root prefix (the live-game case)', () => {
  const rows = [{ ref: 'Canvas/Menu/lower/buttons/layout/ShopBtn' }, { ref: 'Canvas/Menu/upper/MsgBtn' }];
  assert.deepEqual(resolveCoirPath('main/Canvas/Menu/lower/buttons/layout/ShopBtn', rows),
    { ref: 'Canvas/Menu/lower/buttons/layout/ShopBtn', mount: '', dropped: 'main' });
});

test('resolveCoirPath: prefab-internal coir path → live ref with the inferred mount', () => {
  const rows = [{ ref: 'Canvas/SettingsPanel/CloseBtn' }];
  assert.deepEqual(resolveCoirPath('SettingsPanel/CloseBtn', rows),
    { ref: 'Canvas/SettingsPanel/CloseBtn', mount: 'Canvas', dropped: '' });
});

test('resolveCoirPath: >1 tail match → ambiguous; no match → null', () => {
  const two = [{ ref: 'Canvas/A/Item/Btn' }, { ref: 'Canvas/B/Item/Btn' }];
  assert.deepEqual(resolveCoirPath('Item/Btn', two), { ambiguous: ['Canvas/A/Item/Btn', 'Canvas/B/Item/Btn'] });
  assert.equal(resolveCoirPath('Nope/Gone', [{ ref: 'Canvas/X' }]), null);
});

test('resolveCoirPath: min-overlap — a 1-segment leaf does NOT resolve to a deep ref, but an identical 1-segment does', () => {
  assert.equal(resolveCoirPath('btn', [{ ref: 'Canvas/Panel/btn' }]), null);     // weak partial → no guess
  assert.deepEqual(resolveCoirPath('Btn', [{ ref: 'Btn' }]), { ref: 'Btn', mount: '', dropped: '' }); // full alignment
});

test('resolveCopseRef: reverse — live ref → coir nodePath (real handler class lives on that row)', () => {
  const staticRows = [{ nodePath: 'main/Canvas/Menu/lower/buttons/layout/ShopBtn', handlerClass: 'MenuUI' }];
  assert.deepEqual(resolveCopseRef('Canvas/Menu/lower/buttons/layout/ShopBtn', staticRows),
    { nodePath: 'main/Canvas/Menu/lower/buttons/layout/ShopBtn', mount: '', dropped: 'main' });
});
