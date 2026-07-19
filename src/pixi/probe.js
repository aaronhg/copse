// @ts-check
// probe(app, target): a live, READ-ONLY self-diagnostic of copse's Pixi coupling — the same job
// src/cocos/probe.js does for `cc.*`. For each version-sensitive thing the Pixi layer depends on,
// report WHETHER it resolved, so cross-version drift becomes a visible report instead of copse
// quietly degrading to 'unsure'. Patches nothing; walks and reads only.
//
// Every entry below is something the layer actually needs (grep src/pixi/): the event system and its
// rootBoundary.hitTest (reachable), rootTarget priming (the cold-throw prerequisite), the canvas +
// resolution (press/visual coordinate mapping), the eventemitter3 `_events` table (codeHandlers),
// renderPipeId (pixitype — the whole addressing scheme), and the AppScreen anchors (§3).
import { describe } from '../core/framework.js';
import { pixiType, gameLabel, isText } from './pixitype.js';
import { makePixiSurface, findAnchors, isAnchor } from './anchors.js';

const present = (v) => v !== undefined && v !== null;

/**
 * @param {any} app the Pixi Application
 * @param {any} [target] where the framework registry lives (globalThis in-page)
 * @param {string} [version] the version string captured by the init hook, if any
 */
export function probe(app, target = globalThis, version) {
  const out = { engine: 'pixi', version: version || '?' };
  const stage = app && app.stage;
  out.app = { present: present(app), stage: present(stage), ticker: present(app && app.ticker), canvas: present(app && app.canvas) };
  if (!stage) { out.ok = false; out.reason = 'no-stage'; return out; }

  // --- events: the reachability + press substrate ---
  const ev = app.renderer && app.renderer.events;
  const boundary = ev && ev.rootBoundary;
  out.events = {
    system: present(ev),
    features: ev && ev.features ? { ...ev.features } : null,   // a game CAN disable click/move wholesale
    resolution: ev ? (ev.resolution ?? null) : null,
    rootBoundary: present(boundary),
    hitTest: !!(boundary && typeof boundary.hitTest === 'function'),
    // the documented cold-throw prerequisite: null until primed / until a real pointer event lands
    rootTargetPrimed: !!(boundary && boundary.rootTarget),
    rootIsStage: !!(app.renderer && app.renderer.lastObjectRendered === stage),
    lastObjectRendered: present(app.renderer && app.renderer.lastObjectRendered),
  };
  out.canvas = (() => {
    const c = app.canvas;
    if (!c) return null;
    const r = c.getBoundingClientRect && c.getBoundingClientRect();
    return { backing: [c.width, c.height], css: r ? [Math.round(r.width), Math.round(r.height)] : null, laidOut: !!(r && r.width > 0 && r.height > 0) };
  })();

  // --- tree shape: what addressing actually has to work with on THIS build ---
  let total = 0, labelled = 0, pixiDefaultLabels = 0, interactive = 0, withListeners = 0, texts = 0, eventsTableSeen = false;
  const types = {};
  (function walk(n, d) {
    if (!n || d > 64) return;
    total++;
    const t = pixiType(n); types[t] = (types[t] || 0) + 1;
    if (typeof n.label === 'string' && n.label) { if (gameLabel(n)) labelled++; else pixiDefaultLabels++; }
    if (n.eventMode === 'static' || n.eventMode === 'dynamic') {
      interactive++;
      if (n._events && Object.keys(n._events).length) withListeners++;
    }
    if (n._events) eventsTableSeen = true;
    if (isText(n)) texts++;
    for (const c of n.children || []) walk(c, d + 1);
  })(stage, 0);

  const surface = makePixiSurface(stage);
  const anchors = findAnchors(stage, () => null);
  out.tree = {
    nodes: total, types,
    gameLabels: labelled,                    // labels the GAME set (identity)
    pixiDefaultLabels,                       // labels PIXI set (decoys — see pixitype.js)
    interactive,                             // eventMode static|dynamic
    pressable: withListeners,                // …and carrying listeners: what asButton actually accepts
    texts,                                   // what snapshot/diff labelChanged can observe
    anchors: anchors.length,                 // AppScreen-shaped nodes (show/hide/resize)
    stageIsAnchor: isAnchor(stage),
  };
  out.coupling = {
    renderPipeId: Object.keys(types).some((t) => t !== 'Container' && t !== 'Unknown'), // duck-typing works
    eventsTable: eventsTableSeen,            // eventemitter3 `_events` → codeHandlers
    pixiSurfaceLearned: { protos: surface.protoNames.size, fields: surface.fieldNames.size },
  };
  out.framework = describe(target, target.__copseFrameworks || []);

  // Honest verdict: enough resolved to drive, or not?
  out.ok = !!(out.events.system && out.events.hitTest && out.canvas && out.canvas.laidOut);
  if (!out.ok) {
    out.reason = !out.events.system ? 'no-event-system'
      : !out.events.hitTest ? 'no-hittest'
        : !out.canvas ? 'no-canvas' : 'canvas-not-laid-out';
  }
  return out;
}
