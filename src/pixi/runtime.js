// @ts-check
// The PixiJS 8 adapter for copse + the `window.__copse` installer — the Pixi sibling of
// src/cocos/runtime.js. Everything engine-neutral lives in src/core/bridge.js and is SHARED; this
// file is only the `Runtime` shape over a live `Application` plus the four-member engine port.
//
// Pixi 8 ONLY (docs/ENGINES.md §10): v7 differs on label/name, eventMode/interactive and getBounds'
// return type, and supporting both would reintroduce exactly the feature-probe ladder the Cocos
// layer needs for 2.x/3.x. Targeting v8 alone is what keeps this layer small.
//
// THE STRUCTURAL DIFFERENCE FROM COCOS, stated once: Cocos is `Node + components[]`, so `:Comp`
// reaches a Component attached to a node. Pixi has no component system — the node IS the game's own
// class. So `getComponent` returns the node itself when the type matches, and `:Node.member` reaches
// the game's own methods and fields directly. Measured: those names survive minification even though
// `constructor.name` does not, which is why this works on production builds at all (ENGINES.md §3).
import { snapshot, resolve, get, call, reachable, node as nodeInfoCore, diff } from '../core/index.js';
import { makeBridge } from '../core/bridge.js';
import { pixiType, pixiName, gameLabel, isText } from './pixitype.js';
import { refOf } from '../core/refpath.js';
import { makePixiSurface, findAnchors, namedRefs } from './anchors.js';
import { makeReachable } from './reachable.js';
import { makeVisualManifest } from './visual.js';
import { pixiPress } from './press.js';
import { probe } from './probe.js';
import { boundsRectOf, visibleChain } from './geom.js';

/** Walk a dotted member path (`_game.score.value`). Pixi's named refs are inherently multi-hop. */
const readPath = (o, path) => String(path).split('.').reduce((v, k) => (v == null ? v : v[k]), o);

/**
 * The copse `Runtime` over a live Pixi Application.
 * @param {any} app @param {()=>any} root @returns {import('../core/index.js').Runtime}
 */
export function pixiRuntime(app, root) {
  return {
    name: (n) => pixiName(n),
    // Pixi "names" are types, so same-name siblings are the NORM — emit `[i]` unconditionally, or a
    // ref flips (`Text` → `Text[0]`) the moment a second Text spawns beside it and every watch/diff
    // key churns. See segOf in src/core/index.js.
    alwaysIndex: true,
    children: (n) => n.children || [],
    // Pixi has no `active` separate from `visible`; renderability is the closest equivalent, and it
    // must consider ancestors (a hidden parent hides the subtree) to match Cocos's activeInHierarchy.
    isActive: (n) => visibleChain(n),   // the ancestor `visible` walk — one definition, in geom.js
    components: (n) => [{ type: pixiType(n), raw: n }],
    // No component system: a node "has" the component that IS its own type. `Label` is a pseudo-type
    // mapped onto any Text flavour, which is what lets core's snapshot/diff labelChanged work
    // unchanged over a Pixi tree (ENGINES.md §6) — the single highest-value mapping in this file.
    getComponent: (n, type) => {
      // `Node` returns the node ITSELF. core's `get` special-cases the pseudo-component before ever
      // asking the Runtime, but `call`/`patch`/`hold` go straight through getComponent — so without
      // this, `GameScreen:Node.startPlaying()` fails 'no-component' and the headline Pixi capability
      // (drive the game's own class, since the node IS the game object — docs/ENGINES.md §3) is
      // unreachable for everything except reads. Found by auditing the tools against a live game.
      if (type === 'Node') return n;
      if (type === 'Label') return isText(n) ? n : null;
      return pixiType(n) === type ? n : null;
    },
    // `string` is copse's Label member name (Cocos's cc.Label.string); on Pixi it's `.text`. Dotted
    // paths are resolved here rather than in core so the Cocos layer is untouched.
    readProp: (c, p) => {
      if (p === 'string' && typeof c.text === 'string') return c.text;
      return String(p).includes('.') ? readPath(c, p) : c[p];
    },
    callMethod: (c, m, args) => {
      const fn = String(m).includes('.') ? readPath(c, m) : c[m];
      if (typeof fn !== 'function') return undefined;
      const owner = String(m).includes('.') ? readPath(c, String(m).split('.').slice(0, -1).join('.')) : c;
      return fn.apply(owner, args);
    },
    position: (n) => { try { const p = n.position; return p ? [Math.round(p.x), Math.round(p.y)] : null; } catch { return null; } },
    opacity: (n) => { try { return typeof n.alpha === 'number' ? Math.round(n.alpha * 255) : null; } catch { return null; } },

    // A "button" is interactive AND carries listeners. The listener requirement is not pedantry:
    // measured, a full-screen background TilingSprite is `eventMode:'static'` with ZERO listeners, so
    // an eventMode-only test reports a screen-sized button on every scene (ENGINES.md §4).
    asButton: (n) => {
      const on = n.eventMode === 'static' || n.eventMode === 'dynamic';
      if (!on) return null;
      return (n._events && Object.keys(n._events).length) ? n : null;
    },
    isInteractable: (b) => b.eventMode !== 'none',
    // Pixi has no editor; nothing is serialized. Every clickSurface row would be `method:null`, which
    // is why the coir×copse coverage join does not apply to this engine (ENGINES.md §5).
    clickHandlers: () => [],
    fireClickHandlers: () => 0,
    // Never used: the engine port replaces `press` wholesale (real DOM events, see press.js). Kept
    // as a no-op so a caller reaching for the Runtime directly can't accidentally half-drive a node.
    emitClick: () => { /* see engine.press */ },
    // eventemitter3's table — simpler and more honest than Cocos's _eventProcessor ladder: these are
    // exactly the listeners the game registered. Engine-internal noise doesn't appear here.
    codeHandlers: (n) => Object.keys(n._events || {}).map((type) => {
      const e = n._events[type];
      const infos = Array.isArray(e) ? e : [e];
      return { type, count: infos.length, fn: (infos[0] && infos[0].fn && infos[0].fn.name) || undefined };
    }),
    reachable: makeReachable(app, root),
    nodeInfo: (n) => {
      const info = { active: n.visible !== false, activeInHierarchy: visibleChain(n) };
      if (typeof n.alpha === 'number') info.alpha = n.alpha;
      try { const s = n.scale; if (s) info.scale = { x: s.x, y: s.y }; } catch { /* */ }
      try { const p = n.getGlobalPosition ? n.getGlobalPosition() : null; if (p) info.worldPos = { x: Math.round(p.x), y: Math.round(p.y) }; } catch { /* */ }
      try { const r = boundsRectOf(n); if (r) info.size = { w: Math.round(r.width), h: Math.round(r.height) }; } catch { /* */ }
      if (typeof n.text === 'string') info.text = n.text;
      return info;
    },
  };
}

/**
 * Install the core init hook so ANY Pixi 8 app is captured the moment it boots — the recommended
 * attach path (ENGINES.md §1). Pixi core calls `globalThis.__PIXI_APP_INIT__` unconditionally from
 * `ApplicationInitHook` (NOT gated on the `devtools` init option), so this needs no cooperation from
 * the game — but it must run BEFORE the game's scripts, i.e. from an `addInitScript` /
 * `evaluateOnNewDocument`, which is exactly where the driver injects the bundle.
 * @param {any} [target]
 */
export function installInitHook(target = globalThis) {
  if (target.__copsePixi) return target.__copsePixi;
  const store = { app: null, version: null };
  target.__copsePixi = store;
  const prev = target.__PIXI_APP_INIT__;
  target.__PIXI_APP_INIT__ = function (app, version) {
    store.app = app; store.version = version;
    if (typeof prev === 'function') { try { prev.call(this, app, version); } catch { /* a foreign hook must not break capture */ } }
  };
  return store;
}

/**
 * Find a live Pixi Application. The init hook (above) is the reliable path; this is the fallback
 * ladder for when copse attaches to an ALREADY-BOOTED page, mirroring the official devtools' own
 * order. Walks same-origin (i)frames like `findCC` does — games are often iframed.
 * @param {any} [win] @param {number} [depth] @returns {{app:any, version:string|null, via:string}|null}
 */
export function findPixi(win = globalThis, depth = 0) {
  const probeWin = (w) => {
    try {
      const cap = w.__copsePixi;
      if (cap && cap.app) return { app: cap.app, version: cap.version, via: 'init-hook' };
      const dt = w.__PIXI_DEVTOOLS__;
      if (dt && dt.app && dt.app.stage) return { app: dt.app, version: null, via: '__PIXI_DEVTOOLS__' };
      if (w.__PIXI_APP__ && w.__PIXI_APP__.stage) return { app: w.__PIXI_APP__, version: null, via: '__PIXI_APP__' };
      // stage-only conventions: synthesize the minimal app shape the layer needs
      const stage = (dt && dt.stage) || w.__PIXI_STAGE__;
      const renderer = (dt && dt.renderer) || w.__PIXI_RENDERER__;
      if (stage && renderer) return { app: { stage, renderer, canvas: renderer.canvas, ticker: null }, version: null, via: '__PIXI_STAGE__' };
    } catch { /* cross-origin */ }
    return null;
  };
  const here = probeWin(win);
  if (here) return here;
  if (depth > 6) return null;
  let frames; try { frames = win.frames; } catch { return null; }
  for (let i = 0; i < (frames ? frames.length : 0); i++) {
    try { const f = findPixi(frames[i], depth + 1); if (f) return f; } catch { /* cross-origin */ }
  }
  return null;
}

/**
 * Install the FULL bridge as `target.__copse` over a live Pixi Application. Same surface as the
 * Cocos `install`, minus what Pixi genuinely can't supply (`clickSurface`/coverage — ENGINES.md §5).
 * @param {any} app @param {any} [target] @param {{version?:string}} [opts]
 */
export function install(app, target = globalThis, { version } = {}) {
  const root = () => app.stage;
  const rt = pixiRuntime(app, root);
  const visualManifestOf = makeVisualManifest(app, root);

  // Freezing the loop is a ticker stop — no version ladder needed, unlike Cocos's game.pause →
  // director.pause. The last frame stays on the canvas, so a screenshot still captures the held state.
  const freeze = () => { try { if (app.ticker && typeof app.ticker.stop === 'function') { app.ticker.stop(); return 'ticker'; } } catch { /* */ } return null; };
  const unfreeze = () => { try { if (app.ticker && typeof app.ticker.start === 'function') { app.ticker.start(); return true; } } catch { /* */ } return false; };
  const canFreeze = () => !!(app.ticker && typeof app.ticker.stop === 'function');

  const api = makeBridge({
    rt,
    root,
    target,
    engine: {
      freeze,
      unfreeze,
      canFreeze,
      visualManifest: (sel) => { const n = resolve(root(), rt, sel); return n ? visualManifestOf(n) : null; },
      probe: () => probe(app, target, version || (target.__copsePixi && target.__copsePixi.version)),
      version: () => version || (target.__copsePixi && target.__copsePixi.version) || '?',
      press: (path, opts) => pixiPress(app, root, rt, path, opts),
      // Pixi's stage is anonymous, so "where am I" is the mounted screen: its game-set label if it
      // has one, else its ref. Falls back to null rather than inventing a name.
      scene: () => {
        const stage = root();
        const found = findAnchors(stage, (n) => refOf(n, stage, pixiName, true));
        if (!found.length) return null;
        // findAnchors ranks best-addressable first, so this is the most screen-like thing mounted.
        const top = found.find((f) => f.tier === 'lifecycle') || found[0];
        return gameLabel(top.node) || top.ref;
      },
    },
  });

  // Pixi-only additions, and one removal. `clickSurface` is deleted rather than left returning [] —
  // an empty join reads as "nothing is wired", which is a false finding, not a degraded one.
  delete api.clickSurface;

  // `anchors()` is the Pixi lane's real entry point (ENGINES.md §3): positional refs like
  // `Container[0]/Container[3]/Container[3]` are unreadable, so what an agent actually wants is
  // "which game classes are mounted, what can I call on them, and what do they call their children".
  api.anchors = (opts = {}) => {
    const stage = root();
    const surface = makePixiSurface(stage);
    return findAnchors(stage, (n) => refOf(n, stage, pixiName, true), { ...opts, surface })
      .map(({ node: n, ref, depth, tier, lifecycle, score, methods }) => {
        // namedRefs walks two hops, which on a real screen is 50+ paths — too much to dump for every
        // anchor. Cap it, but ALWAYS report the total: a silent truncation would read as "that's all
        // there is", which is the one thing a discovery tool must never imply.
        const all = namedRefs(n, surface);
        const cap = opts.namedCap ?? 25;
        return {
          ref, depth, tier, ...(lifecycle ? { lifecycle } : {}), score,
          type: pixiType(n), label: gameLabel(n), methods,
          named: all.slice(0, cap), namedTotal: all.length,
        };
      });
  };
  api.app = app;
  target.__copse = api;
  return api;
}

/** Convenience for a console paste / an already-booted page: find the app, then install over it. */
export function autoInstall(target = globalThis) {
  const found = findPixi(target);
  if (!found) return null;
  return install(found.app, target, { version: found.version || undefined });
}

export { snapshot, resolve, get, call, reachable, nodeInfoCore as node, diff };
