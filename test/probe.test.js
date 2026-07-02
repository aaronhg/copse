// probe(cc) — the engine-coupling self-diagnostic. Over a fake `cc` whose internals mirror the REAL
// 3.8.6 shapes (validated against reference/cocos/3.8.6): CallbacksInvoker._callbackTable[type] =
// CallbackList{callbackInfos:[…]}, NodeEventProcessor.{capturingTarget,shouldHandleEventTouch},
// UITransform.cameraPriority, batcher2D.getFirstRenderCamera. Asserts probe reports WHICH arm of
// copse's `||` ladders resolved, and degrades sanely (tree-shaken globals, no scene).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probe } from '../src/cocos/probe.js';

class UITransform {}

// A CallbacksInvoker in the real 3.8.6 shape: _callbackTable keyed by event type → CallbackList.
const invokerWith = (type) => ({ _callbackTable: { [type]: { callbackInfos: [{ callback() {}, target: {} }] } } });

// node factory. opts: { ep, cameraPriority (→ a UITransform), touchField }
function nd(name, opts = {}, children = []) {
  const ut = 'cameraPriority' in opts ? Object.assign(new UITransform(), { cameraPriority: opts.cameraPriority }) : null;
  const ep = opts.ep === undefined ? null : opts.ep;
  const n = {
    name, children, _eventProcessor: ep,
    getComponent(t) {
      const wantUT = t === UITransform || t === 'cc.UITransform' || (t && t.name === 'UITransform');
      return wantUT ? ut : null;
    },
  };
  for (const c of children) c.parent = n;
  return n;
}

function mkCc(scene, { treeShaken = false, eventTouchVia = 'top' } = {}) {
  const cc = {
    ENGINE_VERSION: '3.8.6',
    Node: class Node { static EventType = { TOUCH_START: 'touch-start', TOUCH_END: 'touch-end' }; },
    Scene: class Scene {}, Button: class Button {}, Camera: class Camera {}, UIOpacity: class UIOpacity {},
    BlockInputEvents: class BlockInputEvents {}, UIRenderer: class UIRenderer {}, Touch: class Touch {},
    director: { getScene: () => scene, root: { batcher2D: { getFirstRenderCamera: () => ({}) } } },
  };
  if (!treeShaken) cc.UITransform = UITransform;
  if (eventTouchVia === 'top') cc.EventTouch = class EventTouch {};
  else if (eventTouchVia === 'event') cc.Event = { EventTouch: class EventTouch {} };
  return cc;
}

test('probe: a normal 3.8.6-shaped build → every tier resolves via the expected key', () => {
  const btn = nd('Btn', { ep: { shouldHandleEventTouch: true, capturingTarget: invokerWith('click') }, cameraPriority: 0 });
  const scene = nd('Scene', {}, [btn]);
  const r = probe(mkCc(scene));

  assert.equal(r.version, '3.8.6');
  assert.equal(r.classes.UITransform, true);
  assert.equal(r.classes.Button, true);

  assert.equal(r.reach.getFirstRenderCamera, true);
  assert.equal(r.reach.batcher2D, 'batcher2D');
  assert.equal(r.reach.cameraPriority, 'present');

  assert.equal(r.events.eventProcessor, true);
  assert.equal(r.events.shouldHandleEventTouch, 'boolean');
  assert.equal(r.events.capturingKey, 'capturingTarget'); // real 3.8.6: non-underscore
  assert.equal(r.events.tableKey, '_callbackTable');       // real 3.8.6: underscore
  assert.equal(r.events.infosKey, 'callbackInfos');        // real 3.8.6: non-underscore

  assert.equal(r.touch.EventTouch, 'cc.EventTouch');
  assert.equal(r.touch.Touch, 'present');
  assert.equal(r.touch.NodeEventType, true);
});

test('probe: a node with an _eventProcessor but NO registered listener → tableNote, not a false key', () => {
  const bare = nd('Bare', { ep: { shouldHandleEventTouch: false, capturingTarget: { _callbackTable: {} } }, cameraPriority: 0 });
  const scene = nd('Scene', {}, [bare]);
  const r = probe(mkCc(scene));
  assert.equal(r.events.eventProcessor, true);
  assert.equal(r.events.tableKey, undefined);
  assert.equal(r.events.tableNote, 'no-registered-listener-found');
});

test('probe: no live scene → events.tableNote=no-scene, still reports classes/version (fail soft)', () => {
  const r = probe(mkCc(null));
  assert.equal(r.ok, true);
  assert.equal(r.version, '3.8.6');
  assert.equal(r.events.eventProcessor, false);
  assert.equal(r.events.tableNote, 'no-scene');
  assert.equal(r.reach.cameraPriority, 'unknown'); // couldn't read a UITransform without a scene
});

test('probe: a tree-shaken build (cc.UITransform dropped, EventTouch only under cc.Event) is reported honestly', () => {
  const btn = nd('Btn', { ep: { shouldHandleEventTouch: true, capturingTarget: invokerWith('click') }, cameraPriority: 5 });
  const scene = nd('Scene', {}, [btn]);
  const r = probe(mkCc(scene, { treeShaken: true, eventTouchVia: 'event' }));
  assert.equal(r.classes.UITransform, false);          // the global class is gone…
  assert.equal(r.events.eventProcessor, true);         // …but getComponent('cc.UITransform') still resolved the tree
  assert.equal(r.reach.cameraPriority, 'present');
  assert.equal(r.touch.EventTouch, 'cc.Event.EventTouch');
  assert.equal(r.classes['Event.EventTouch'], true);
});
