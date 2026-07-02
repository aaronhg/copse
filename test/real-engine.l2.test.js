// L2 — copse's engine-coupled reads against a REAL Cocos engine, not a hand fake. Constructs a REAL
// CallbacksInvoker (bundled from reference/cocos/<ver> source) and wires it into a node's
// _eventProcessor exactly as the engine does, then asserts copse's `codeHandlers` walk parses the
// REAL `_callbackTable → callbackInfos → {callback,target}` shape and applies the Button-own filter.
// This is the test the geometric/unit fakes CAN'T be: if a future engine renames _callbackTable or
// restructures CallbackInfo, THIS fails where the fake (built from copse's own assumptions) would pass.
//
// Skips when no engine is checked out (reference/cocos/<ver> is gitignored) → `npm test` stays green
// everywhere; the real-engine assertions run only where the source is present. Clone with:
//   git clone --depth 1 --branch v3.8.6 https://github.com/cocos/cocos-engine reference/cocos/3.8.6
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cocosRuntime } from '../src/cocos/runtime.js';
import { availableEngines, bundleReal } from './helpers/real-engine.js';

const versions = availableEngines();

// A minimal `cc` for cocosRuntime — codeHandlers only needs Button (for the own-listener filter).
// The event internals under test come from the REAL bundled CallbacksInvoker, not from here.
const fakeCc = (Button) => ({
  Button, UITransform: class UITransform {}, Camera: class Camera {}, Vec3: class Vec3 {},
  director: { getScene: () => ({ children: [] }) },
});
// A node whose _eventProcessor.capturingTarget is the REAL invoker — the exact wiring cocos builds.
const nodeWith = (invoker, btn) => ({
  name: 'Btn', children: [], activeInHierarchy: true, parent: null,
  _eventProcessor: { capturingTarget: invoker },
  getComponent: (t) => (btn && (t === btn.constructor || (t && t.name === 'Button') || t === 'cc.Button') ? btn : null),
});

if (!versions.length) {
  test('L2 real-engine: SKIPPED — no reference/cocos/<ver> checked out (clone to enable)', { skip: true }, () => {});
}

for (const ver of versions) {
  test(`L2 [${ver}]: codeHandlers parses a REAL CallbacksInvoker _callbackTable (real field names)`, async () => {
    const mod = await bundleReal(ver, 'cocos/core/event/callbacks-invoker.ts');
    assert.ok(mod && mod.CallbacksInvoker, 'expected a real CallbacksInvoker export');
    const { CallbacksInvoker } = mod;

    // Register real listeners the way NodeEventProcessor does: invoker.on(type, callback, target).
    const cap = new CallbacksInvoker();
    cap.on('click', function onBuy() {}, { constructor: { name: 'ShopCtrl' } });
    cap.on('touch-start', function onTap() {}, { constructor: { name: 'Mask' } });

    const rt = cocosRuntime(fakeCc(class Button {}));
    const handlers = rt.codeHandlers(nodeWith(cap, null));

    assert.deepEqual(handlers.map((h) => h.type).sort(), ['click', 'touch-start']);
    const click = handlers.find((h) => h.type === 'click');
    assert.equal(click.fn, 'onBuy', 'real CallbackInfo.callback surfaced');
    assert.equal(click.target, 'ShopCtrl', 'real CallbackInfo.target surfaced');
  });

  test(`L2 [${ver}]: the Button's OWN listener is filtered out (identity filter vs real CallbackInfo.target)`, async () => {
    const mod = await bundleReal(ver, 'cocos/core/event/callbacks-invoker.ts');
    const { CallbacksInvoker } = mod;
    class Button {}
    const btn = new Button();                 // the node's Button component…

    const cap = new CallbacksInvoker();
    cap.on('touch-start', function buttonInternal() {}, btn);            // …its OWN touch listener → must be dropped
    cap.on('click', function userClick() {}, { constructor: { name: 'UserCtrl' } }); // a real user handler → kept

    const rt = cocosRuntime(fakeCc(Button));
    const handlers = rt.codeHandlers(nodeWith(cap, btn));

    assert.equal(handlers.length, 1, 'the Button-own touch listener must be filtered, leaving only the user handler');
    assert.equal(handlers[0].type, 'click');
    assert.equal(handlers[0].fn, 'userClick');
  });
}
