// The lite/full runtime split (the enabler for dist/copse.inject.lite.js): the LITE runtime carries
// the base driving/reading surface but OMITS `reachable`, so a caller that only needs `press` (mast)
// gets a bundle esbuild can tree-shake the reachability code out of. Pins that contract + a `press`
// smoke over the lite runtime (the surface mast's `press:` stages actually use). The full runtime's
// reachable is exercised separately by reachable.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cocosRuntime, cocosRuntimeLite } from '../src/cocos/runtime.js';
import { press } from '../src/core/index.js';

// A minimal fake `cc` — just enough to CONSTRUCT the runtimes (method-presence + the split, not
// engine geometry). reachable.test.js covers the real reachable over a geometric fake.
const fakeCc = () => ({
  Button: class Button {}, UITransform: class UITransform {}, Camera: class Camera {},
  Vec2: class Vec2 {}, Vec3: class Vec3 {}, BlockInputEvents: class BlockInputEvents {},
  director: { getScene: () => ({ children: [] }), root: {} },
});

// The base surface both runtimes must share.
const BASE_METHODS = [
  'name', 'children', 'isActive', 'components', 'getComponent', 'readProp', 'callMethod',
  'asButton', 'isInteractable', 'clickHandlers', 'fireClickHandlers', 'emitClick', 'emitTouch',
  'codeHandlers', 'nodeInfo',
];

test('cocosRuntimeLite: base methods present, `reachable` OMITTED (the tree-shake seam)', () => {
  const rt = cocosRuntimeLite(fakeCc());
  for (const m of BASE_METHODS) assert.equal(typeof rt[m], 'function', `lite missing base method ${m}`);
  assert.equal(rt.reachable, undefined, 'lite runtime must NOT carry reachable');
});

test('cocosRuntime (full): same base methods + `reachable` attached', () => {
  const rt = cocosRuntime(fakeCc());
  for (const m of BASE_METHODS) assert.equal(typeof rt[m], 'function', `full missing base method ${m}`);
  assert.equal(typeof rt.reachable, 'function', 'full runtime must carry reachable');
});

test('press over the LITE runtime fires serialized clickEvents (the surface mast drives)', () => {
  let fired = 0, clicked = 0;
  const Button = class Button {};
  const btnComp = new Button();
  btnComp.interactable = true;
  btnComp.clickEvents = [{ emit() { fired++; } }];
  const btnNode = {
    name: 'Btn', children: [], activeInHierarchy: true, parent: null, _eventProcessor: null,
    emit() { clicked++; },
    getComponent(t) { const name = typeof t === 'string' ? t.replace(/^cc\./, '') : t.name; return name === 'Button' ? btnComp : null; },
  };
  const cc = {
    Button, UITransform: class UITransform {}, Camera: class Camera {}, Vec3: class Vec3 {},
    director: { getScene: () => root },
  };
  const root = { children: [btnNode] };

  const rt = cocosRuntimeLite(cc);
  const res = press(root, rt, 'Btn');
  assert.equal(res.ok, true);
  assert.equal(res.fired, 1, 'the serialized clickEvent must have fired');
  assert.equal(fired, 1);
  assert.equal(clicked, 1, 'emitClick must still reach code-registered on(click) listeners');
  // No reachableGate passed → press never touches rt.reachable, so lite (no reachable) is fine.
  assert.deepEqual(res.drove, ['clickEvent']);
});
