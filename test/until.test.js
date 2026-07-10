// __copse.until(specs) — the `--until` HELD state machines (scene-switch / assets-idle / label-filled),
// ported into copse from mast's until.js pageEvalSource so both the CLI and the extension share one source.
// Over a minimal fake `cc`: asserts the baselines/latches (boot scene, downloads-were-active, empty→filled).
// reachable/.dispatch aren't exercised here (they lean on the full reachability layer — see reachable.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installProbe } from '../src/cocos/runtime.js';

// minimal node: name, uuid, children, getComponent(cc.Label)→{string}
function node(name, { uuid, label } = {}, children = []) {
  const labelComp = label !== undefined ? { string: label } : null;
  return { name, uuid, children, getComponent(t) {
    const wantLabel = t === 'cc.Label' || t === 'Label' || (t && t.name === 'Label');
    return wantLabel ? labelComp : null;
  } };
}

// fake cc with a swappable scene + a mutable asset-pending count
function mkCc() {
  const dl = { _downloading: { count: 0 }, _queue: [] };
  const state = { scene: null };
  const cc = { Label: class Label {}, director: { getScene: () => state.scene }, assetManager: { downloader: dl } };
  return { cc, setScene: (s) => { state.scene = s; }, setPending: (p) => { dl._downloading.count = p; } };
}
const spec = (id) => [{ id, mods: [], arg: '', key: id }];
const ids = (r) => (r && r.held || []).map((h) => h.id);

test('until scene-switch: holds once the scene name changes from the boot scene', () => {
  const m = mkCc(); m.setScene(node('Loading'));
  const api = installProbe(m.cc, {});
  assert.deepEqual(ids(api.until(spec('scene-switch'))), [], 'boot scene → not held');
  m.setScene(node('Main'));
  assert.deepEqual(ids(api.until(spec('scene-switch'))), ['scene-switch'], 'scene changed → held');
});

test('until assets-idle: holds only after pending was >0 then returns to 0', () => {
  const m = mkCc(); m.setScene(node('S'));
  const api = installProbe(m.cc, {});
  m.setPending(0); assert.deepEqual(ids(api.until(spec('assets-idle'))), [], 'idle from the start → not held (never active)');
  m.setPending(3); assert.deepEqual(ids(api.until(spec('assets-idle'))), [], 'downloading → not held');
  m.setPending(0); assert.deepEqual(ids(api.until(spec('assets-idle'))), ['assets-idle'], 'drained after being active → held');
});

test('until label-filled: holds when a Label goes empty → meaningful', () => {
  const m = mkCc();
  const lbl = node('Score', { uuid: 'u1', label: '' });
  m.setScene(node('S', {}, [lbl]));
  const api = installProbe(m.cc, {});
  assert.deepEqual(ids(api.until(spec('label-filled'))), [], 'empty label → baseline, not held');
  lbl.getComponent('cc.Label').string = '1200';
  assert.deepEqual(ids(api.until(spec('label-filled'))), ['label-filled'], 'label filled → held');
});

test('until: unknown/empty specs and a null scene fail soft (no throw)', () => {
  const m = mkCc();
  const api = installProbe(m.cc, {});
  assert.deepEqual(api.until([]).held, [], 'no specs → empty held');
  assert.equal(api.until(spec('scene-switch')).scene, null, 'null scene → scene:null, no throw');
});
