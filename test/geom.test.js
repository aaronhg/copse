// The shared Cocos geometry/input primitives (src/cocos/geom.js) over a MINIMAL fake `cc`.
//
// `synthTap` is the fiddliest engine coupling in the repo and — until this file — had NO test at all:
// core.test.js stubs `rt.emitTouch` and runtime-lite.test.js only asserts the method NAME exists, so the
// EventTouch resolution ladder, the camera projection and the dispatch fallback were entirely unpinned.
// That is exactly how the two hand-maintained copies (baseRuntime.emitTouch / installProbe.synthTouch)
// drifted apart on which camera they projected through without anything failing. They are one function
// now; this pins the behaviour that merge chose, above all that the camera comes from `camOf`
// (layer/visibility + priority) and NOT from a position in the scene walk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { camOf, collectCameras, synthTap, visibleOf } from '../src/cocos/geom.js';

class Vec3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } }
class Touch { constructor(x, y, id) { this.x = x; this.y = y; this.id = id; } }
class EventTouch {
  constructor(touches, bubbles, type) { this.touches = touches; this.bubbles = bubbles; this.type = type; }
}
class UITransform {
  constructor(box) { this._b = box; }
  getBoundingBoxToWorld() { return this._b; }
}
class Camera {
  // `dx` makes each camera's projection distinguishable, so a test can tell WHICH one was used.
  constructor({ priority = 0, visibility = 0xffffffff, dx = 0, enabled = true } = {}) {
    this.priority = priority; this.visibility = visibility; this.dx = dx; this.enabled = enabled;
  }
  worldToScreen(v, o) { o.x = v.x + this.dx; o.y = v.y; o.z = 0; return o; }
}
class UIOpacity { constructor(o) { this.opacity = o; } }

// A node whose getComponent answers by CLASS or by the registered class-NAME string, like the engine's.
const mkNode = (props = {}) => {
  const comps = props.comps || [];
  const n = {
    name: props.name || 'N',
    layer: props.layer ?? 1,
    scale: props.scale ?? { x: 1, y: 1 },
    parent: props.parent ?? null,
    children: props.children || [],
    activeInHierarchy: props.activeInHierarchy ?? true,
    getComponent(t) {
      for (const c of comps) {
        if (typeof t === 'function' && c instanceof t) return c;
        if (typeof t === 'string') {
          if (t === 'cc.UITransform' && c instanceof UITransform) return c;
          if (t === 'cc.Camera' && c instanceof Camera) return c;
        }
      }
      return null;
    },
  };
  for (const ch of n.children) ch.parent = n;
  return n;
};
const mkCc = (over = {}) => ({ EventTouch, Touch, Vec3, UITransform, Camera, UIOpacity, Node: { EventType: { TOUCH_START: 'touch-start', TOUCH_END: 'touch-end', TOUCH_CANCEL: 'touch-cancel' } }, ...over });

// A node that records what it was dispatched, plus the camera scene around it.
const scene = ({ camA, camB, nodeLayer = 1 } = {}) => {
  const got = [];
  const target = mkNode({ name: 'Btn', layer: nodeLayer, comps: [new UITransform({ x: 10, y: 20, width: 4, height: 6 })] });
  target.dispatchEvent = (ev) => got.push(ev);
  const root = mkNode({ name: 'Scene', children: [mkNode({ name: 'CamA', comps: [camA] }), mkNode({ name: 'CamB', comps: [camB] }), target] });
  return { root, target, got };
};

test('synthTap: the actuation pair is START → TOUCH_END; the probe pair is START → TOUCH_CANCEL', () => {
  const cc = mkCc();
  const a = scene({ camA: new Camera(), camB: new Camera() });
  assert.equal(synthTap(cc, a.target, { endType: 'end', root: a.root }), true);
  assert.deepEqual(a.got.map((e) => e.type), ['touch-start', 'touch-end']);

  const b = scene({ camA: new Camera(), camB: new Camera() });
  assert.equal(synthTap(cc, b.target, { endType: 'cancel', root: b.root }), true);
  assert.deepEqual(b.got.map((e) => e.type), ['touch-start', 'touch-cancel'],
    'the probe path must NOT send TOUCH_END — that would actuate the button it is only probing');
});

test('synthTap: the camera comes from camOf (layer+priority), NOT from its position in the scene walk', () => {
  // THE regression this merge exists to prevent, and the assertion is built to FAIL for either old copy:
  // the correct camera sits in the MIDDLE of the walk, so `cams[0]` (what emitTouch used) and
  // `cams[cams.length - 1]` (what synthTouch used) both pick a wrong one. Only a layer-aware choice works.
  const cc = mkCc();
  const first = new Camera({ visibility: 0b10, dx: 1000 });   // does NOT render layer 0b01
  const right = new Camera({ visibility: 0b01, dx: 7 });      // does
  const last = new Camera({ visibility: 0b10, dx: 2000 });    // does NOT
  const target = mkNode({ name: 'Btn', layer: 0b01, comps: [new UITransform({ x: 10, y: 20, width: 4, height: 6 })] });
  const got = []; target.dispatchEvent = (e) => got.push(e);
  const root = mkNode({ name: 'Scene', children: [
    mkNode({ name: 'C0', comps: [first] }), mkNode({ name: 'C1', comps: [right] }), mkNode({ name: 'C2', comps: [last] }), target,
  ] });
  assert.equal(collectCameras(cc, root).length, 3);
  assert.equal(synthTap(cc, target, { root }), true);
  // box centre x = 10 + 4/2 = 12, through `right` (dx 7) → 19. cams[0] would give 1012, cams[last] 2012.
  assert.equal(got[0].touches[0].x, 19, 'projected through the camera that actually renders this node');
});

test('synthTap: a disabled camera never wins, and priority breaks a tie among eligible ones', () => {
  const cc = mkCc();
  const off = new Camera({ priority: 99, dx: 1000, enabled: false });
  const on = new Camera({ priority: 1, dx: 5 });
  const s = scene({ camA: off, camB: on });
  assert.equal(synthTap(cc, s.target, { root: s.root }), true);
  assert.equal(s.got[0].touches[0].x, 17, '12 + 5 — the disabled high-priority camera is skipped');
});

test('synthTap: no UITransform / no camera → still dispatches, at (0,0)', () => {
  // Geometry is best-effort: a node we cannot project is still worth touching (the handler may not care
  // where). Silently doing nothing would be the worse failure — the caller would see `true` and no event.
  const cc = mkCc();
  const bare = mkNode({ name: 'Bare' });
  const got = []; bare.dispatchEvent = (e) => got.push(e);
  const root = mkNode({ name: 'Scene', children: [bare] });
  assert.equal(synthTap(cc, bare, { root }), true);
  assert.equal(got.length, 2);
  assert.deepEqual([got[0].touches[0].x, got[0].touches[0].y], [0, 0]);
});

test('synthTap: falls back to _eventProcessor.dispatchEvent, and reports false with no dispatcher at all', () => {
  const cc = mkCc();
  const got = [];
  const viaProc = mkNode({ name: 'Old' });
  viaProc._eventProcessor = { dispatchEvent: (e) => got.push(e) };
  assert.equal(synthTap(cc, viaProc, { root: mkNode({ children: [viaProc] }) }), true);
  assert.equal(got.length, 2);

  const mute = mkNode({ name: 'Mute' });   // no dispatchEvent, no _eventProcessor
  assert.equal(synthTap(cc, mute, { root: mkNode({ children: [mute] }) }), false);
});

test('synthTap: resolves EventTouch from cc.Event/cc.internal, and reports false when the engine has none', () => {
  // Release builds move EventTouch; a missing one must degrade to false, never throw into the caller.
  const nested = mkCc({ EventTouch: undefined, Event: { EventTouch } });
  const s = scene({ camA: new Camera(), camB: new Camera() });
  assert.equal(synthTap(nested, s.target, { root: s.root }), true, 'cc.Event.EventTouch is a valid location');

  const none = mkCc({ EventTouch: undefined });
  const t = scene({ camA: new Camera(), camB: new Camera() });
  assert.equal(synthTap(none, t.target, { root: t.root }), false);
  assert.equal(t.got.length, 0);
});

test('collectCameras: finds cameras by class-NAME string too (tree-shaken release builds)', () => {
  // `cc.Camera` is undefined on some minified builds while getComponent('cc.Camera') still resolves.
  // Without the fallback this silently found ZERO cameras and every projection fell back to (0,0).
  const root = mkNode({ children: [mkNode({ comps: [new Camera()] }), mkNode({ children: [mkNode({ comps: [new Camera()] })] })] });
  assert.equal(collectCameras({ Camera }, root).length, 2);
  assert.equal(collectCameras({}, root).length, 2, 'no cc.Camera global → the name string still resolves');
});

test('camOf: null when there are no cameras at all, rather than undefined', () => {
  assert.equal(camOf(mkNode(), []), null);
});

test('visibleOf: opacity 0 or scale 0 ANYWHERE up the chain collapses the node', () => {
  const cc = { UIOpacity };
  const leaf = mkNode({ name: 'leaf' });
  const parent = mkNode({ name: 'p', children: [leaf] });
  mkNode({ name: 'root', children: [parent] });
  assert.equal(visibleOf(cc, leaf), true);

  const hidden = mkNode({ name: 'leaf2' });
  const dim = mkNode({ name: 'p2', comps: [new UIOpacity(0)], children: [hidden] });
  mkNode({ name: 'root2', children: [dim] });
  assert.equal(visibleOf(cc, hidden), false, 'an ancestor at opacity 0 hides the descendant');

  const flat = mkNode({ name: 'leaf3' });
  const zero = mkNode({ name: 'p3', scale: { x: 0, y: 1 }, children: [flat] });
  mkNode({ name: 'root3', children: [zero] });
  assert.equal(visibleOf(cc, flat), false, 'scale 0 on an ancestor collapses it too');
});
