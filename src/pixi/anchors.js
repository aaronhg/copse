// @ts-check
// Pixi's binding of the engine-neutral anchor machinery (src/core/anchors.js).
//
// Pixi has NO component system, so the candidate object for a node is the node ITSELF.
//
// EVERY node is a surface sample, keyed by its `renderPipeId` (or 'container' for the plain ones).
// The engine's share is then whatever all instances of a kind have in common (see makeSurface), so:
//   • Graphics' ~50 drawing methods are shared by every Graphics → subtracted (the original point);
//   • `class Hero extends Sprite` sits ABOVE the tail every plain Sprite shares → its own methods
//     and fields survive, and — critically — are no longer subtracted from every OTHER node too.
// The earlier `renderPipeId ? [n] : []` sampling got that second case backwards and silently emptied
// `anchors()` on any game that subclasses a renderable.
import { makeSurface, findAnchors as findAnchorsCore, anchorInfo, gameApi, namedRefs, LIFECYCLE } from '../core/anchors.js';

export { anchorInfo, gameApi, namedRefs, LIFECYCLE };

/** The Pixi engine surface, calibrated across every node of each display kind. @param {any} root */
export const makePixiSurface = (root) => makeSurface(root, { samplesOf: (n) => [{ obj: n, kind: n.renderPipeId || 'container' }] });

/** Anchors in a Pixi tree — the node itself is the candidate (no components to look inside). */
export function findAnchors(root, refOf, opts = {}) {
  return findAnchorsCore(root, refOf, { ...opts, surface: opts.surface || makePixiSurface(root) });
}

/** Back-compat boolean; prefer `anchorInfo`, which reports WHY. @param {any} n @param {any} [surface] */
export function isAnchor(n, surface) {
  if (!surface) return !!(n && typeof n.show === 'function' && typeof n.hide === 'function' && typeof n.resize === 'function');
  return anchorInfo(n, surface).anchor;
}
