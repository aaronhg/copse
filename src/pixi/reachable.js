// @ts-check
// Reachability for Pixi 8 — "would a real tap land on this node, or is something on top of it?"
//
// This is the one place Pixi is DRAMATICALLY simpler than Cocos. src/cocos/reachable.js replays the
// engine's input z-order by hand (render-camera priority → sibling index → multi-point sampling,
// ~230 lines) because Cocos exposes no hit-test over the live tree. Pixi does:
// `renderer.events.rootBoundary.hitTest(x, y)` returns the exact Container the event system WOULD
// deliver to. So the engine answers authoritatively and we just ask it — no z-order reimplementation,
// no cross-camera tier, no version-branching.
//
// THE PREREQUISITE NOBODY DOCUMENTS (measured on 8.14.1): `hitTest` THROWS when called cold —
// "Cannot read properties of null (reading 'eventMode')" — because `EventBoundary.hitTest` reads
// `this.rootTarget`, which the EventSystem only populates when it processes a real DOM pointer
// event. Priming by assigning `rootBoundary.rootTarget` is preferred over dispatching a synthetic
// pointermove: it's a plain property (verified in the shipped EventBoundary) and, unlike a
// pointermove, does not push a hover event into the running game.
import { refOf } from '../core/refpath.js';
import { pixiName } from './pixitype.js';
import { boundsRectOf, visibleOf } from './geom.js';

/** The node's centre in Pixi WORLD/global space (what hitTest wants), or null if it has no area. */
export function centreOf(node) {
  const r = boundsRectOf(node);
  // Strictly positive, not >= 0: a degenerate box has no interior to aim a click at. visual.js keeps the
  // looser predicate on purpose — so the shared helper returns the raw rect and each caller decides.
  if (!r || !(r.width > 0) || !(r.height > 0)) return null;
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, rect: r };
}

// visibleOf (hidden / alpha 0 / scale 0, up the chain) now lives in geom.js — shared with visual.js
// and mirroring cocos/geom.js, so the two engines report the same thing under the same field name.

/** Is every ancestor still letting events through to its children? */
function childrenInteractive(node, root) {
  let p = node.parent;
  while (p && p !== root) { if (p.interactiveChildren === false) return false; p = p.parent; }
  return true;
}

/**
 * `makeReachable(app, root)` → the Runtime's optional `reachable(node)`.
 * Tri-state like the Cocos side: true | false | 'unsure', and 'unsure' always carries a `reason`
 * (fail loud — never a confident pass we can't justify).
 * @param {any} app the Pixi Application
 * @param {()=>any} root
 */
export function makeReachable(app, root) {
  /** Prime rootTarget so hitTest can't throw cold. Idempotent, and non-invasive by design. */
  const prime = () => {
    const b = app?.renderer?.events?.rootBoundary;
    if (!b) return null;
    if (!b.rootTarget) { try { b.rootTarget = root(); } catch { /* read-only on some builds */ } }
    return b.rootTarget ? b : null;
  };

  return (node) => {
    const stage = root();
    const ref = (n) => refOf(n, stage, pixiName, true) || pixiName(n);
    const visible = visibleOf(node);
    const boundary = prime();
    if (!boundary) return { reachable: /** @type {const} */ ('unsure'), blockedBy: null, reason: 'no-event-boundary', visible };
    // The event system resolves its root from renderer.lastObjectRendered on every event, so a scene
    // that has never rendered — or an app rendering to a RenderTexture — would hit-test the wrong
    // tree. The official devtools guards on exactly this; so do we, loudly.
    if (app.renderer.lastObjectRendered && app.renderer.lastObjectRendered !== stage) {
      return { reachable: /** @type {const} */ ('unsure'), blockedBy: null, reason: 'root-not-rendered', visible };
    }
    if (!childrenInteractive(node, stage)) return { reachable: false, blockedBy: null, reason: 'ancestor-interactiveChildren-false', visible };
    const c = centreOf(node);
    if (!c) return { reachable: /** @type {const} */ ('unsure'), blockedBy: null, reason: 'no-bounds', visible };

    let hit;
    try { hit = boundary.hitTest(c.x, c.y); }
    catch (e) { return { reachable: /** @type {const} */ ('unsure'), blockedBy: null, reason: 'hittest-threw: ' + ((e && e.message) || e), visible }; }
    if (!hit) return { reachable: /** @type {const} */ ('unsure'), blockedBy: null, reason: 'no-hit-at-centre', visible };

    // The event system delivers to the deepest interactive node under the point; a hit on a
    // DESCENDANT of our target still means a tap reaches the target (it bubbles).
    let p = hit;
    while (p) { if (p === node) return { reachable: true, blockedBy: null, visible, via: { hit: 'boundary' } }; p = p.parent; }
    return { reachable: false, blockedBy: String(ref(hit)), visible, via: { hit: 'boundary' } };
  };
}
