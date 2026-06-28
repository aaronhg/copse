// Version-adaptive geometric reachability (Rung 2+3) over a MINIMAL fake `cc` engine — the
// engine-coupled `cocosRuntime(cc).reachable` is otherwise un-exercised in CI (every other test
// stubs a fake `rt.reachable`). Screen space == world space here and `hitTest` is a rect test, so
// the geometry is fully controlled. Covers: multi-point fraction (partial overlay), the
// consumer-tier ladder (engine shouldHandleEventTouch / listener / class), the camera fallback
// (3.8-like getFirstRenderCamera vs 3.5-like camOf), null/absent camera, and occludedBy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cocosRuntime } from '../src/cocos/runtime.js';

class Vec2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  static transformMat4(out, v, m) { out.x = v.x + (m.tx || 0); out.y = v.y + (m.ty || 0); out.z = v.z; return out; }
}
class UITransform {
  constructor(rect, cameraPriority) {
    this._r = rect; this.contentSize = { width: rect.w, height: rect.h }; this.anchorPoint = { x: 0.5, y: 0.5 };
    if (cameraPriority !== undefined) this.cameraPriority = cameraPriority;
  }
  getBoundingBoxToWorld() { const r = this._r; return { x: r.x, y: r.y, width: r.w, height: r.h }; }
  hitTest(sp) { const r = this._r; return sp.x >= r.x && sp.x <= r.x + r.w && sp.y >= r.y && sp.y <= r.y + r.h; }
}
class Button {}
class BlockInputEvents {}
class UIRenderer {}
class UIOpacity { constructor(o) { this.opacity = o; } }
class Camera {
  constructor({ priority = 0, visibility = 0xffffffff } = {}) { this.priority = priority; this.visibility = visibility; this.enabled = true; this.node = { activeInHierarchy: true }; }
  worldToScreen(v, o) { o.x = v.x; o.y = v.y; o.z = v.z || 0; return o; }
}

let UID = 0;
// rect = {x,y,w,h} | null; opts: button, bie, renderer, opacity, cameraPriority, ep, camera, layer, active
function nd(name, rect, opts = {}) {
  const comps = [];
  if (rect) comps.push(new UITransform(rect, opts.cameraPriority));
  if (opts.button) comps.push(new Button());
  if (opts.bie) comps.push(new BlockInputEvents());
  if (opts.renderer) comps.push(new UIRenderer());
  if (opts.opacity !== undefined) comps.push(new UIOpacity(opts.opacity));
  if (opts.camera) comps.push(opts.camera);
  return {
    name, uuid: 'n' + UID++, layer: opts.layer ?? 0xffffffff, activeInHierarchy: opts.active !== false,
    parent: null, children: [], scale: { x: 1, y: 1 },
    worldMatrix: rect ? { tx: rect.x + rect.w / 2, ty: rect.y + rect.h / 2 } : { tx: 0, ty: 0 },
    worldPosition: rect ? { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, z: 0 } : { x: 0, y: 0, z: 0 },
    _eventProcessor: opts.ep || null,
    getComponent(type) {
      if (typeof type === 'string') { const m = type.replace(/^cc\./, ''); return comps.find((c) => c.constructor.name === m) || null; }
      return comps.find((c) => c instanceof type) || null;
    },
  };
}
const epTouch = () => ({ capturingTarget: { _callbackTable: { 'touch-start': { callbackInfos: [{ target: {}, callback: function onTap() {} }] } } } });
const epEngine = (v) => ({ shouldHandleEventTouch: v });

// render: 'authoritative' (3.6+, getFirstRenderCamera present) | 'null-camera' (returns null) |
// undefined (3.5-like, no batcher2D.getFirstRenderCamera → camOf fallback)
function mkCC(root, cam, render) {
  const batcher2D = {};
  if (render === 'authoritative') batcher2D.getFirstRenderCamera = () => cam;
  else if (render === 'null-camera') batcher2D.getFirstRenderCamera = () => null;
  return {
    ENGINE_VERSION: render ? '3.8.6' : '3.5.0',
    Vec2, Vec3, UITransform, Button, BlockInputEvents, UIRenderer, UIOpacity, Camera,
    director: { getScene: () => root, root: render ? { batcher2D } : {} },
  };
}
// build a scene = [Camera, ...content]; return reachable(target). withCamera:false omits the camera.
function reach(content, target, { render, withCamera = true } = {}) {
  const cam = new Camera();
  const kids = withCamera ? [nd('Camera', null, { camera: cam }), ...content] : content;
  const root = nd('Scene', null);
  for (const ch of kids) { ch.parent = root; root.children.push(ch); }
  return cocosRuntime(mkCC(root, cam, render)).reachable(target);
}

const RECT = { x: 0, y: 0, w: 100, h: 100 };

test('reachable: clear button → true, fraction 1, via.consumer=class', () => {
  const btn = nd('Btn', RECT, { button: true });
  const r = reach([btn], btn);
  assert.equal(r.reachable, true);
  assert.equal(r.reachableFraction, 1);
  assert.equal(r.via.consumer, 'class');
});

test('reachable: a full Button overlay on top → false, blockedBy names it, fraction 0', () => {
  const btn = nd('Btn', RECT, { button: true });
  const over = nd('Overlay', RECT, { button: true }); // later sibling → higher draw order
  const r = reach([btn, over], btn);
  assert.equal(r.reachable, false);
  assert.equal(r.reachableFraction, 0);
  assert.equal(r.blockedBy, 'Overlay');
});

test('reachable: an EDGE overlay (covers a corner, NOT the centre) → still reachable:true + partial (centre is tappable)', () => {
  const btn = nd('Btn', RECT, { button: true });
  const over = nd('Overlay', { x: 80, y: 80, w: 100, h: 100 }, { button: true }); // covers the (95,95) corner only
  const r = reach([btn, over], btn);
  assert.equal(r.reachable, true);             // centre (50,50) is free → tappable
  assert.equal(r.partial, true);               // but a corner is covered
  assert.ok(r.reachableFraction > 0 && r.reachableFraction < 1, `got ${r.reachableFraction}`);
});

test('reachable: an overlay over the CENTRE (corners free) → false — the tap point is covered (centre-primary)', () => {
  const btn = nd('Btn', RECT, { button: true });
  const over = nd('Overlay', { x: 30, y: 30, w: 40, h: 40 }, { button: true }); // covers (50,50) centre, NOT the corners
  const r = reach([btn, over], btn);
  assert.equal(r.reachable, false);            // centre covered → not tappable, even though 4/5 corners are free
  assert.equal(r.blockedBy, 'Overlay');
});

test('reachable: a cc.Button overlay with shouldHandleEventTouch:FALSE still BLOCKS (engine-tier is additive, never excludes a Button)', () => {
  const btn = nd('Btn', RECT, { button: true });
  const over = nd('Overlay', RECT, { button: true, ep: epEngine(false) }); // engine getter says false, but it IS a Button
  const r = reach([btn, over], btn);
  assert.equal(r.reachable, false, 'the Button overlay must be a consumer despite shouldHandleEventTouch:false');
  assert.equal(r.blockedBy, 'Overlay');
});

test('reachable: a RAW touch-listener overlay (no cc.Button) blocks — the copse class-only check would miss it', () => {
  const btn = nd('Btn', RECT, { button: true });
  const scrim = nd('Scrim', RECT, { ep: epTouch() }); // node.on('touch-start'), no Button/BIE
  const r = reach([btn, scrim], btn);
  assert.equal(r.reachable, false, 'a touch-eating overlay must block, even without a cc.Button');
  assert.equal(r.blockedBy, 'Scrim');
});

test('reachable: engine tier — shouldHandleEventTouch:true blocks; :false does NOT', () => {
  const btn = nd('Btn', RECT, { button: true });
  const blocker = nd('Eng', RECT, { ep: epEngine(true) });
  assert.equal(reach([btn, blocker], btn).reachable, false);

  const btn2 = nd('Btn', RECT, { button: true });
  const inert = nd('Eng', RECT, { ep: epEngine(false) }); // engine says it won't handle touch
  const r2 = reach([btn2, inert], btn2);
  assert.equal(r2.reachable, true, 'a node the engine would not route touch to must not block');
});

test('reachable: 3.8-like (getFirstRenderCamera) → via.camera=render; 3.5-like (camOf) → heuristic', () => {
  const a = nd('Btn', RECT, { button: true });
  assert.equal(reach([a], a, { render: 'authoritative' }).via.camera, 'render');
  const b = nd('Btn', RECT, { button: true });
  const r = reach([b], b, { render: undefined }); // no batcher2D.getFirstRenderCamera
  assert.equal(r.via.camera, 'heuristic');
  assert.equal(r.reachable, true); // still resolves via the camOf fallback
});

test('reachable: authoritative getFirstRenderCamera === null → false, reason no-render-camera', () => {
  const btn = nd('Btn', RECT, { button: true });
  const r = reach([btn], btn, { render: 'null-camera' });
  assert.equal(r.reachable, false);
  assert.equal(r.reason, 'no-render-camera');
});

test("reachable: no camera in the scene → 'unsure', reason no-camera (fail loud, not a guess)", () => {
  const btn = nd('Btn', RECT, { button: true });
  const r = reach([btn], btn, { withCamera: false });
  assert.equal(r.reachable, 'unsure');
  assert.equal(r.reason, 'no-camera');
});

test('reachable: an opaque renderer on top sets occludedBy but does NOT flip reachable (input ignores opacity)', () => {
  const btn = nd('Btn', RECT, { button: true });
  const banner = nd('Banner', RECT, { renderer: true }); // a Sprite-like renderer, no input consumer
  const r = reach([btn, banner], btn);
  assert.equal(r.reachable, true, 'a non-consumer renderer must not block touch');
  assert.equal(r.occludedBy, 'Banner');
});

test('reachable: a node with no UITransform → unsure, reason no-uitransform', () => {
  const bare = nd('Bare', null, { button: true }); // no rect → no UITransform
  const r = reach([bare], bare);
  assert.equal(r.reachable, 'unsure');
  assert.equal(r.reason, 'no-uitransform');
});
