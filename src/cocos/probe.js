// @ts-check
// probe(cc): a live, READ-ONLY self-diagnostic of copse's engine-coupling surface. For each
// version-sensitive INTERNAL `cc.*` path copse reads, report WHETHER it resolved and via WHICH
// key/tier, plus the engine version. Turns silent cross-version drift into a visible report —
// run it once on an unfamiliar build and it names exactly which internal shape moved, instead of
// copse quietly degrading to 'unsure'. Patches NOTHING (walks + reads only), so it's fully
// non-invasive. This is the runtime companion to reachable.js's fail-loud floor: the floor stops a
// stale read from being trusted; probe tells you WHICH read went stale on this version.
//
// Every path below is one copse actually depends on (grep the cocos/ layer): the NodeEventProcessor
// callback-table shape (codeHandlers / consumerTier), `shouldHandleEventTouch` (the engine consumer
// tier), `batcher2D.getFirstRenderCamera` + `UITransform.cameraPriority` (reachable's render/z-order
// tiers), and the EventTouch/Touch classes (emitTouch). Field names verified against real 3.8.6 source
// (reference/cocos/3.8.6): NodeEventProcessor.{capturingTarget,bubblingTarget,shouldHandleEventTouch},
// CallbacksInvoker._callbackTable → CallbackList.callbackInfos — the primaries in copse's `||` ladders.

import { describe } from '../core/framework.js';

const present = (v) => v !== undefined && v !== null;

// Walk the live scene depth-first, calling fn(node) until it returns true (or the tree is exhausted).
// fn records what it found via closure side-effects; returning true stops the walk early.
const walkUntil = (root, fn) => {
  let done = false;
  (function rec(n) {
    if (done || !n) return;
    if (fn(n)) { done = true; return; }
    for (const c of (n.children || [])) { rec(c); if (done) return; }
  })(root);
  return done;
};

/**
 * @param {any} cc
 * @param {any} [win] the install target the framework registry lives on (install passes its `target`);
 *                    defaults to globalThis. Must match install's target, or the framework read misdiagnoses.
 * @returns {{version:string, classes:Record<string,boolean>, reach:object, events:object, touch:object, framework:object, ok:boolean}}
 */
export function probe(cc, win = (typeof globalThis !== 'undefined' ? globalThis : {})) {
  const version = (cc && cc.ENGINE_VERSION) || '?';

  // (0) app framework — is the game's logic state reachable OUTSIDE the cc tree (PureMVC etc.)?
  // Reads the registry off the SAME target install stored it on (win) — not always globalThis (an
  // embedding/test may install into a non-global surface). Adapters come from copse.frameworks.mjs / registerFramework.
  const framework = (() => {
    try { const store = (win && win.__copseFrameworks) || []; return { ...describe(win, store), registered: store.length }; }
    catch { return { kind: 'unknown' }; }
  })();

  // (1) class globals — a tree-shaken release build drops some `cc.*` globals (`cc.UITransform` was
  // UNDEFINED on a real 3.8.6 preview). getComponent falls back to the registered class-NAME string,
  // but a dropped global means the GLOBAL-class path (and `instanceof`) is unavailable on this build.
  const classes = /** @type {Record<string, boolean>} */ ({});
  for (const k of ['Node', 'Scene', 'Button', 'UITransform', 'Camera', 'UIOpacity', 'BlockInputEvents', 'UIRenderer', 'Renderable2D', 'EventTouch', 'Touch']) {
    classes[k] = present(cc[k]);
  }
  classes['Event.EventTouch'] = !!(cc.Event && cc.Event.EventTouch);
  classes['internal.EventTouch'] = !!(cc.internal && cc.internal.EventTouch);

  // (2) reachability render tier — batcher2D + getFirstRenderCamera (3.6+), else the camOf heuristic.
  const rroot = cc.director && cc.director.root;
  const b = (rroot && (rroot.batcher2D || rroot._batcher)) || null;
  const reach = {
    batcher2D: b ? (rroot.batcher2D ? 'batcher2D' : '_batcher') : 'absent',
    getFirstRenderCamera: !!b && typeof b.getFirstRenderCamera === 'function',
    cameraPriority: 'unknown', // filled from a live UITransform below (needs a scene)
  };

  const scene = cc.director && cc.director.getScene && cc.director.getScene();
  const UIT = cc.UITransform || 'cc.UITransform';

  // (3) event internals — resolved against the LIVE tree. `shouldHandleEventTouch` is a field on any
  // node's _eventProcessor; the callback-table KEY NAMES only materialise once a node has registered a
  // listener, so we find the first such node and read the ACTUAL names this version uses (which arm of
  // copse's `inv._callbackTable || inv.callbackTable` / `.callbackInfos || ._callbackInfos` won).
  const events = { eventProcessor: false };
  if (scene) {
    walkUntil(scene, (n) => {
      const ep = n._eventProcessor;
      if (!ep) return false;
      events.eventProcessor = true;
      try { events.shouldHandleEventTouch = typeof ep.shouldHandleEventTouch; } // 'boolean' if the field exists
      catch { events.shouldHandleEventTouch = 'error'; }
      return true;
    });
    walkUntil(scene, (n) => {
      const ep = n._eventProcessor; if (!ep) return false;
      for (const ck of ['capturingTarget', 'bubblingTarget', '_capturingTarget', '_bubblingTarget']) {
        const inv = ep[ck]; if (!inv) continue;
        const tk = inv._callbackTable ? '_callbackTable' : inv.callbackTable ? 'callbackTable' : null;
        const table = tk && inv[tk];
        if (table && Object.keys(table).length) {
          const cell = table[Object.keys(table)[0]];
          events.capturingKey = ck;
          events.tableKey = tk;
          events.infosKey = cell && cell.callbackInfos ? 'callbackInfos' : cell && cell._callbackInfos ? '_callbackInfos' : 'unknown';
          return true;
        }
      }
      return false;
    });
    if (!events.tableKey) events.tableNote = events.eventProcessor ? 'no-registered-listener-found' : 'no-eventProcessor-found';

    // cameraPriority — a UITransform field (3.6+); read the first UITransform in the tree.
    walkUntil(scene, (n) => {
      const ut = n.getComponent && n.getComponent(UIT);
      if (!ut) return false;
      reach.cameraPriority = typeof ut.cameraPriority === 'number' ? 'present' : 'absent';
      return true;
    });
  } else {
    events.tableNote = 'no-scene';
  }

  // (4) EventTouch/Touch — the shapes emitTouch constructs: which name resolves + is Touch a ctor.
  const touch = {
    EventTouch: cc.EventTouch ? 'cc.EventTouch' : (cc.Event && cc.Event.EventTouch) ? 'cc.Event.EventTouch' : (cc.internal && cc.internal.EventTouch) ? 'cc.internal.EventTouch' : 'absent',
    Touch: cc.Touch ? 'present' : 'absent',
    NodeEventType: !!(cc.Node && cc.Node.EventType), // TOUCH_START/END constants emitTouch reads
  };

  return { version, classes, reach, events, touch, framework, ok: true };
}
