// @ts-check
// Driving a Pixi button — and the ONE place copse's press semantics deliberately diverge per engine.
//
// Cocos `press` CALLS the wired handler (`src/core/index.js:190`), so it drives the logic whether or
// not a player could reach the button; reachability is an opt-in gate. Pixi has no serialized
// handlers to call, so the faithful move is to dispatch REAL DOM PointerEvents at the canvas and let
// the engine's own pipeline route them — which means hit testing runs, and press is INHERENTLY
// reachability-gated. The gate is therefore ON by default here, the opposite of Cocos. `force:true`
// falls back to a direct `emit`, which skips propagation, hit testing and EventBoundary state — so
// it's reported as `drove:'emit-unsafe'` rather than silently passing for the real thing.
//
// EVERY STEP BELOW IS LOAD-BEARING — each was measured against pixi 8.14.1 (docs/ENGINES.md §4):
//   • hitTest throws cold                       → prime first (reachable.js)
//   • pointerup dispatched anywhere but the CANVAS becomes `pointerupoutside`; no tap is synthesized
//   • down/up with different pointerId          → up fires, but NO pointertap/click
//   • omitting pointerType:'mouse'              → pointertap fires but `click` NEVER does, and real
//     buttons measured in the wild listen for `click`/`mousedown`, not pointer events
//   • synchronous back-to-back events hit-test against stale transforms (pixijs#11321) → yield a frame
import { resolve } from '../core/index.js';
import { centreOf } from './reachable.js';

/** Pixi global/world point → viewport CSS px (the inverse of the public `mapPositionToPoint`). */
export function toClient(app, gx, gy) {
  // Guard BEFORE dereferencing. findPixi can synthesize an app from the `__PIXI_STAGE__` convention
  // (`{stage, renderer, canvas: renderer.canvas, ticker: null}`), where canvas or renderer.events may
  // be absent — this used to throw a raw TypeError past the bridge instead of returning the null that
  // press/visualManifest are written to translate into `reason:'no-canvas-size'`.
  const canvas = app && app.canvas;
  const events = app && app.renderer && app.renderer.events;
  if (!canvas || !events || typeof canvas.getBoundingClientRect !== 'function') return null;
  const rect = canvas.getBoundingClientRect();
  const res = events.resolution ?? 1;
  if (!rect || !canvas.width || !canvas.height) return null;
  return {
    clientX: rect.left + (gx * res) * (rect.width / canvas.width),
    clientY: rect.top + (gy * res) * (rect.height / canvas.height),
  };
}

// A frame yield that CANNOT hang. rAF is the right signal (it means the renderer actually advanced,
// which is what pixijs#11321 requires between phases) but Chrome throttles it to ZERO in a hidden or
// background tab — exactly the tab `connect({attach:true, match})` is documented to drive. Testing
// `typeof requestAnimationFrame === 'function'` does not help: it exists, it just never fires, so the
// old fallback was unreachable and a press in a background tab hung forever with no error. Race it
// against a timer and take whichever lands first.
const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(undefined); } };
  try { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish); } catch { /* */ }
  setTimeout(finish, 50);
});

/**
 * Dispatch a full synthetic tap at a viewport point. All three phases go to the CANVAS with one
 * shared pointerId — both are required for the engine to synthesize `pointertap`/`click`.
 * @param {any} app @param {{clientX:number, clientY:number}} pt
 */
export async function dispatchTap(app, pt) {
  const canvas = app.canvas;
  if (!canvas || typeof canvas.dispatchEvent !== 'function') return false;
  const PE = typeof PointerEvent === 'function' ? PointerEvent : null;
  if (!PE) return false;
  const base = {
    bubbles: true, cancelable: true, clientX: pt.clientX, clientY: pt.clientY,
    pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0,
    ...(typeof window !== 'undefined' ? { view: window } : {}),
  };
  canvas.dispatchEvent(new PE('pointerover', { ...base, buttons: 0 }));
  await nextFrame();
  canvas.dispatchEvent(new PE('pointerdown', { ...base, buttons: 1 }));
  await nextFrame();
  canvas.dispatchEvent(new PE('pointerup', { ...base, buttons: 0 }));
  await nextFrame();
  return true;
}

/**
 * The Pixi `press`. Returns copse's press shape (`{ok, ref, drove, …}`) so callers, scripts and the
 * MCP layer stay engine-agnostic. ASYNC (the frame yields are required), unlike the Cocos press —
 * the bridge awaits it, and every caller already goes through a promise boundary.
 * @param {any} app @param {()=>any} root @param {import('../core/index.js').Runtime} rt
 * @param {string} path @param {{force?:boolean, reachableGate?:boolean}} [opts]
 */
export async function pixiPress(app, root, rt, path, { force = false, reachableGate = true } = {}) {
  const node = resolve(root(), rt, path);
  if (!node) return { ok: false, ref: path, reason: 'not-found' };
  const btn = rt.asButton(node);
  if (!btn) return { ok: false, ref: path, reason: 'not-a-button' };
  if (!force && !rt.isInteractable(btn)) return { ok: false, ref: path, reason: 'disabled' };

  const r = rt.reachable ? rt.reachable(node) : null;
  if (reachableGate && !force && r && r.reachable === false) {
    return { ok: false, ref: path, reason: 'unreachable', blockedBy: r.blockedBy ?? null };
  }

  // force: the escape hatch. Bypasses the whole event pipeline, so it proves the handler runs but
  // NOT that a player could trigger it — and it leaves the boundary's press/hover state inconsistent.
  if (force) {
    let fired = 0;
    for (const type of ['pointertap', 'click', 'tap']) {
      try { if (node.emit && (node._events || {})[type]) { node.emit(type, { type, target: node, currentTarget: node, simulated: true }); fired++; } } catch { /* a throwing handler must surface below */ }
    }
    return { ok: true, ref: path, drove: fired ? 'emit-unsafe' : 'nothing', fired, forced: true, reachable: r ? r.reachable : null };
  }

  const c = centreOf(node);
  if (!c) return { ok: false, ref: path, reason: 'no-bounds' };
  const pt = toClient(app, c.x, c.y);
  if (!pt) return { ok: false, ref: path, reason: 'no-canvas-size' };
  const dispatched = await dispatchTap(app, pt);
  if (!dispatched) return { ok: false, ref: path, reason: 'no-dispatch-target' };

  return {
    ok: true, ref: path, fired: 0,
    drove: ['pointer'],                       // the engine's own pipeline ran; `changed` confirms the effect
    via: 'dom-events',
    reachable: r ? r.reachable : null,
    at: { x: Math.round(pt.clientX), y: Math.round(pt.clientY) },
    // `wired` mirrors the Cocos press contract: did the node have ANY handler at all? drove +
    // wired:false means we tapped something with no listener — suspect, verify with `changed`.
    wired: Object.keys(node._events || {}).length > 0,
  };
}
