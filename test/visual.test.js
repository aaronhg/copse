// The node-anchored visual layer, browser-free. Two halves:
//   1. src/sensors/pixel.js — the PURE perceptual sensor over synthetic RGBA buffers (no PNG, no GPU):
//      signature / detail / compareSignatures / the three-state visualVerdict.
//   2. src/cocos/visual.js — the in-page geometry manifest over a MINIMAL fake `cc` (screen space ==
//      world space, hitTest-free), the same controlled-geometry pattern reachable.test.js uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signature, compareSignatures, detail, visualVerdict, DEFAULT_GRID } from '../src/sensors/pixel.js';
import { screenRectOf, makeVisualManifest, frameRectToViewport } from '../src/cocos/visual.js';

// ---- pixel.js: synthetic RGBA helpers --------------------------------------------------------------
const W = 32, H = 32;
function solid([r, g, b]) {
  const a = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { a[i * 4] = r; a[i * 4 + 1] = g; a[i * 4 + 2] = b; a[i * 4 + 3] = 255; }
  return a;
}
// left half c1, right half c2 — spatial content, so `detail` is high
function split(c1, c2) {
  const a = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = x < W / 2 ? c1 : c2; const i = (y * W + x) * 4;
    a[i] = c[0]; a[i + 1] = c[1]; a[i + 2] = c[2]; a[i + 3] = 255;
  }
  return a;
}
const BLACK = [0, 0, 0], WHITE = [255, 255, 255], RED = [255, 0, 0];

test('signature: length is grid*grid*3; values normalized 0..1', () => {
  const sig = signature(solid(WHITE), W, H);
  assert.equal(sig.length, DEFAULT_GRID * DEFAULT_GRID * 3);
  for (const v of sig) assert.ok(v >= 0 && v <= 1);
  assert.ok(Math.abs(sig[0] - 1) < 1e-9, 'white → ~1');
});

test('detail: a SOLID region (even a saturated colour) is ~flat; a split is busy', () => {
  assert.ok(detail(signature(solid(RED), W, H)) < 0.01, 'solid red must read flat (per-channel, not fooled by colour)');
  assert.ok(detail(signature(split(BLACK, WHITE), W, H)) > 0.2, 'half/half must read as content');
});

test('compareSignatures: identical → 0; a wiped region → far over threshold', () => {
  const golden = signature(split(BLACK, WHITE), W, H);
  assert.equal(compareSignatures(golden, golden), 0);
  const wiped = signature(solid(BLACK), W, H); // the white half went missing (didn't render / got occluded)
  assert.ok(compareSignatures(golden, wiped) > 0.1, 'a materially different region must exceed the match threshold');
});

test('compareSignatures: length mismatch throws (guards a grid mixup)', () => {
  assert.throws(() => compareSignatures(new Float64Array(3), new Float64Array(6)), /length mismatch/);
});

test('visualVerdict: NO baseline → drawn resolved, matches/clear unknown, reason no-baseline', () => {
  const v = visualVerdict({ ref: 'Canvas/Panel', sig: signature(split(BLACK, WHITE), W, H) });
  assert.equal(v.drawn, true);
  assert.equal(v.matches, 'unknown');
  assert.equal(v.clear, 'unknown');
  assert.equal(v.reason, 'no-baseline');
  assert.equal(v.via, 'geometric');
});

test('visualVerdict: a blank rect with no baseline → drawn:false (the "tree says active, screen is empty" catch)', () => {
  const v = visualVerdict({ ref: 'Canvas/Panel', sig: signature(solid(BLACK), W, H) });
  assert.equal(v.drawn, false);
});

test('visualVerdict: matching baseline → matches/clear TRUE, via pixel-confirmed, score ~0', () => {
  const sig = signature(split(BLACK, WHITE), W, H);
  const baseline = signature(split(BLACK, WHITE), W, H);
  const v = visualVerdict({ ref: 'Canvas/BuyBtn', sig, baseline });
  assert.equal(v.matches, true);
  assert.equal(v.clear, true);
  assert.equal(v.via, 'pixel-confirmed');
  assert.ok(v.score <= 0.1);
});

test('visualVerdict: occluded/wrong baseline → matches:false, clear:false, reason baseline-mismatch', () => {
  const sig = signature(solid(BLACK), W, H);                 // what's on screen now (button art gone)
  const baseline = signature(split(BLACK, WHITE), W, H);     // golden: the button's own art
  const v = visualVerdict({ ref: 'Canvas/BuyBtn', sig, baseline });
  assert.equal(v.matches, false);
  assert.equal(v.clear, false);
  assert.equal(v.reason, 'baseline-mismatch');
});

test('visualVerdict: an empty / wrong-length baseline does NOT throw — falls back to unknown, reason baseline-shape', () => {
  const sig = signature(split(BLACK, WHITE), W, H);
  const empty = visualVerdict({ ref: 'Canvas/X', sig, baseline: [] }); // [] is truthy but length 0 — must not reach compareSignatures
  assert.equal(empty.matches, 'unknown');
  assert.equal(empty.clear, 'unknown');
  assert.equal(empty.reason, 'baseline-shape');
  assert.equal(empty.drawn, true, 'drawn is still resolved from the signature');
  const wrongLen = visualVerdict({ ref: 'Canvas/X', sig, baseline: new Array(30).fill(0.5) }); // e.g. a baseline from a different grid
  assert.equal(wrongLen.reason, 'baseline-shape');
});

test('visualVerdict: no signature at all → all unknown, via unavailable (degrade LOUD, never silent pass)', () => {
  const v = visualVerdict({ ref: 'Canvas/X', sig: null });
  assert.equal(v.drawn, 'unknown');
  assert.equal(v.matches, 'unknown');
  assert.equal(v.via, 'unavailable');
  assert.equal(v.reason, 'no-signature');
});

test('signature: rect samples a sub-region (left content vs right blank)', () => {
  // left half carries a black/white split (busy), right half is uniform grey (flat)
  const a = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4; let c;
    if (x < W / 2) c = (x < W / 4) ? BLACK : WHITE; else c = [128, 128, 128];
    a[i] = c[0]; a[i + 1] = c[1]; a[i + 2] = c[2]; a[i + 3] = 255;
  }
  const left = signature(a, W, H, { rect: { x: 0, y: 0, w: W / 2, h: H } });
  const right = signature(a, W, H, { rect: { x: W / 2, y: 0, w: W / 2, h: H } });
  assert.ok(detail(left) > 0.2, 'left sub-region is busy');
  assert.ok(detail(right) < 0.01, 'right sub-region is flat');
});

// ---- visual.js: minimal fake cc (screen space == world space) --------------------------------------
class Vec3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } }
class UITransform {
  constructor(rect) { this._r = rect; }
  getBoundingBoxToWorld() { const r = this._r; return { x: r.x, y: r.y, width: r.w, height: r.h }; }
}
class Camera {
  constructor() { this.priority = 0; this.visibility = 0xffffffff; this.enabled = true; this.node = { activeInHierarchy: true }; }
  worldToScreen(v, o) { o.x = v.x; o.y = v.y; o.z = v.z || 0; return o; }
}
class Label {}
class UIOpacity { constructor(o) { this.opacity = o; } }

let UID = 0;
// rect = {x,y,w,h} | null; opts: label, opacity, camera, layer, active
function nd(name, rect, opts = {}) {
  const comps = [];
  if (rect) comps.push(new UITransform(rect));
  if (opts.label) comps.push(new Label());
  if (opts.opacity !== undefined) comps.push(new UIOpacity(opts.opacity));
  if (opts.camera) comps.push(opts.camera);
  return {
    name, uuid: 'n' + UID++, layer: opts.layer ?? 0xffffffff, activeInHierarchy: opts.active !== false,
    parent: null, children: [], scale: { x: 1, y: 1 },
    getComponent(type) {
      if (typeof type === 'string') { const m = type.replace(/^cc\./, ''); return comps.find((c) => c.constructor.name === m) || null; }
      return comps.find((c) => c instanceof type) || null;
    },
  };
}
function mkCC(root) { return { Vec3, UITransform, Camera, Label, UIOpacity, director: { getScene: () => root } }; }
// scene = [Camera, ...content]; wire parents
function scene(content) {
  const root = nd('Scene', null);
  const kids = [nd('Camera', null, { camera: new Camera() }), ...content];
  for (const ch of kids) { ch.parent = root; root.children.push(ch); }
  return root;
}

const RECT = { x: 10, y: 20, w: 100, h: 50 };

test('screenRectOf: projects a node to its screen rect (identity camera → its world AABB)', () => {
  const btn = nd('Btn', RECT);
  const cc = mkCC(scene([btn]));
  assert.deepEqual(screenRectOf(cc, btn), { x: 10, y: 20, w: 100, h: 50 });
});

test('screenRectOf: no UITransform → null (driver degrades loud)', () => {
  const bare = nd('Bare', null);
  const cc = mkCC(scene([bare]));
  assert.equal(screenRectOf(cc, bare), null);
});

test('visualManifest: rect + ref + visible; a dynamic Label child becomes a maskRect', () => {
  const label = nd('Score', { x: 20, y: 30, w: 40, h: 20 }, { label: true });
  const panel = nd('Panel', RECT);
  panel.children.push(label); label.parent = panel;
  const cc = mkCC(scene([panel]));
  const m = makeVisualManifest(cc)(panel);
  assert.equal(m.ref, 'Panel');
  assert.deepEqual(m.rect, { x: 10, y: 20, w: 100, h: 50 });
  assert.equal(m.visible, true);
  assert.equal(m.maskRects.length, 1, 'the Label child is dynamic → masked');
  assert.deepEqual(m.maskRects[0], { x: 20, y: 30, w: 40, h: 20 });
});

test('visualManifest: opacity 0 → visible:false (separate signal, like reachable)', () => {
  const panel = nd('Panel', RECT, { opacity: 0 });
  const cc = mkCC(scene([panel]));
  const m = makeVisualManifest(cc)(panel);
  assert.equal(m.visible, false);
  assert.deepEqual(m.rect, { x: 10, y: 20, w: 100, h: 50 }); // still projectable — visibility ≠ geometry
});

test('visualManifest: unprojectable node → rect null, reason no-rect', () => {
  const bare = nd('Bare', null);
  const cc = mkCC(scene([bare]));
  const m = makeVisualManifest(cc)(bare);
  assert.equal(m.rect, null);
  assert.equal(m.reason, 'no-rect');
  assert.equal(m.maskRects.length, 0);
});

// ---- frameRectToViewport: the frame(bottom-left) → viewport-CSS(top-left) transform ----------------
test('frameRectToViewport: identity metrics → just the y-flip', () => {
  const m = { fw: 100, fh: 100, left: 0, top: 0, cssW: 100, cssH: 100 };
  // frame rect bottom edge y=20, height 40 → top edge at frame-y 60 → css-y 100-60 = 40
  assert.deepEqual(frameRectToViewport({ x: 10, y: 20, w: 30, h: 40 }, m), { x: 10, y: 40, w: 30, h: 40 });
});

test('frameRectToViewport: canvas offset + backing-store≠CSS scale is absorbed by fw/fh normalization', () => {
  const m = { fw: 200, fh: 100, left: 5, top: 7, cssW: 100, cssH: 50 }; // 2× backing store, canvas at (5,7)
  assert.deepEqual(frameRectToViewport({ x: 20, y: 10, w: 40, h: 20 }, m), { x: 15, y: 42, w: 20, h: 10 });
});

test('frameRectToViewport: bad metrics → null (driver degrades loud)', () => {
  assert.equal(frameRectToViewport({ x: 0, y: 0, w: 1, h: 1 }, { fw: 0, fh: 100, left: 0, top: 0, cssW: 1, cssH: 1 }), null);
  assert.equal(frameRectToViewport({ x: 0, y: 0, w: 1, h: 1 }, null), null);
});
