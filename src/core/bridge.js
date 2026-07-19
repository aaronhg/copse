// @ts-check
// The ENGINE-NEUTRAL half of the in-page bridge — everything `__copse.*` does that doesn't
// need to know which engine is underneath. Hoisted out of src/cocos/runtime.js's install()
// so a second engine layer (see docs/ENGINES.md) reuses ONE implementation instead of forking
// watch/patch/hold/pm* and having every bug fixed twice.
//
// Pure over the same `Runtime` adapter the rest of core uses, plus a small ENGINE port for the
// four things that genuinely need the engine: pausing the loop (hold), projecting a node to
// screen pixels (visualManifest), the coupling self-diagnostic (probe), and the version string.
// An engine layer supplies those; everything else here is engine-blind.
//
// This module is the whole `__copse` surface EXCEPT the installer itself: the engine layer
// calls makeBridge(...) and assigns the result to `target.__copse`.
import { snapshot, clickSurface, resolve, press, get, call, reachable, node, diff, splitMember } from './index.js';
import { registerInto, describe, stateWith, callWith, patchTargetWith, notifyWith, retrieveWith } from './framework.js';
import { jsonSafe, parseDur, safeVal, safeBool } from './eval-cond.js';

/**
 * The engine port: the only things the bridge can't do without knowing the engine.
 * @typedef {object} EnginePort
 * @property {()=>string|null} freeze         pause the engine loop; returns a `via` tag ('game'/'ticker'/…) or null if it couldn't
 * @property {()=>boolean} unfreeze           resume the loop; true if anything resumed
 * @property {()=>boolean} canFreeze          is a freeze API reachable on THIS build (checked without calling it)
 * @property {(sel:string)=>any} visualManifest  node → screen rect + mask rects in viewport CSS px
 * @property {()=>any} probe                  engine-coupling self-diagnostic
 * @property {()=>string} version             engine version string ('?' when unknown)
 * @property {(path:string, opts?:any)=>any} [press]  OPTIONAL: replace core's press entirely (see below)
 * @property {()=>string|null} [scene]        OPTIONAL: "where am I" when the root has no name (Pixi's stage is anonymous)
 */

/**
 * Build the full in-page API. The caller (an engine layer's `install`) assigns it to `target.__copse`.
 * @param {{rt: import('./index.js').Runtime, root: ()=>any, target?: any, engine: EnginePort}} opts
 */
export function makeBridge({ rt, root, target = globalThis, engine }) {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- watch: a diff-only TIMELINE of exprs/selectors over time (state-machine observation) ----
  // The whole poll loop runs IN-PAGE in one call, so a caller (the puppeteer driver / MCP) makes a
  // single request instead of N per-tick round-trips. Records ONLY changed keys, with relative
  // timestamps {t, dt}. Duration parse + in-page condition eval are the shared eval-cond.js helpers
  // (safeVal/safeBool/parseDur), the same `until` gates through — one condition vocabulary, two tools.
  /** @param {{exprs?:string[], selectors?:string[], interval?:string|number, until?:string, timeout?:string|number, settle?:string|number}} [o] */
  async function watchImpl(o = {}) {
    const { exprs = [], selectors = [], interval, until, timeout, settle } = o;
    const iv = Math.max(50, parseDur(interval, 1000)), to = parseDur(timeout, 40000), st = parseDur(settle, 0);
    const sample = () => {
      const s = {};
      for (const e of exprs) s['{' + e + '}'] = safeVal(e);
      for (const sel of selectors) { try { const r = get(root(), rt, sel); s[sel] = r && r.ok ? jsonSafe(r.value) : ('⚠ ' + ((r && r.reason) || 'err')); } catch (err) { s[sel] = '⚠ ' + ((err && err.message) || err); } }
      return s;
    };
    const hit = () => safeBool(until);
    const t0 = Date.now(); const timeline = []; let last = {}, lastT = t0;
    const rec = () => {
      const cur = sample(); const ch = {};
      for (const k of Object.keys(cur)) if (JSON.stringify(cur[k]) !== JSON.stringify(last[k])) ch[k] = cur[k];
      if (Object.keys(ch).length) { const now = Date.now(); timeline.push({ t: now - t0, dt: now - lastT, changes: ch }); lastT = now; }
      last = cur;
    };
    rec();                                            // t=0 baseline (everything reads as "changed" from nothing)
    let stoppedBy = 'timeout';
    while (true) {
      if (hit()) { stoppedBy = 'until'; break; }
      if (Date.now() - t0 >= to) { stoppedBy = 'timeout'; break; }
      await nap(iv); rec();
    }
    if (stoppedBy === 'until' && st > 0) { const end = Date.now() + st; while (Date.now() < end) { await nap(iv); rec(); } }
    return { timeline, stoppedBy, elapsed: Date.now() - t0, samples: timeline.length };
  }

  // ---- patch: wrap a live method to verify a fix WITHOUT rebuilding ----
  // Wraps the method on the INSTANCE (scoped, restorable), binds `this` correctly, and runs the
  // before/after hooks under try/catch so a buggy hook can't break the original call — the three
  // things testers kept getting wrong hand-writing monkey-patches on the running game.
  const PATCHES = target.__copsePatches || (target.__copsePatches = new Map());
  const compileHook = (src) => { if (!src) return null; if (typeof src === 'function') return src; return (0, eval)('(' + src + ')'); };
  // Cheap, cycle-safe truncation for traced args/ret — a live object graph is huge/circular.
  const traceVal = (v, d = 0) => {
    if (v === null || typeof v !== 'object') return typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v;
    if (d >= 3) return '…';
    if (Array.isArray(v)) { const h = v.slice(0, 8).map((x) => traceVal(x, d + 1)); if (v.length > 8) h.push(`…(+${v.length - 8})`); return h; }
    const o = {}; let i = 0;
    for (const k of Object.keys(v)) { if (i++ >= 12) { o['…'] = 1; break; } try { o[k] = traceVal(v[k], d + 1); } catch { o[k] = '…'; } }
    return o;
  };

  // ---- framework adapters: the per-session registry (core ships none) ----
  // Populated by registerFramework — the driver auto-injects adapters from copse.frameworks.mjs; probe
  // reads the same store off globalThis. describe/stateWith/callWith are the generic (framework.js) engine.
  const FW = target.__copseFrameworks || (target.__copseFrameworks = []);
  const restore = (sel) => { const p = PATCHES.get(sel); if (!p) return false; try { if (p.hadOwn) p.target[p.member] = p.orig; else delete p.target[p.member]; } catch { /* */ } PATCHES.delete(sel); return true; };
  // Shared wrap machinery for BOTH patch (a component/node instance) and pm_patch (a framework
  // proxy/mediator instance, or a command CLASS prototype) — same before/after/replace hooks, trace, and restore.
  function wrapTarget(sel, tgt, member, hooks) {
    if (typeof tgt[member] !== 'function') return { ok: false, reason: 'not-a-method', ref: sel };
    let before, after, replace;
    try { before = compileHook(hooks.before); after = compileHook(hooks.after); replace = compileHook(hooks.replace); }
    catch (e) { return { ok: false, reason: 'bad-hook', error: (e && e.message) || String(e) }; }
    if (PATCHES.has(sel)) restore(sel);              // re-patching the same selector replaces
    const hadOwn = Object.prototype.hasOwnProperty.call(tgt, member);
    const orig = tgt[member];
    const errors = [];
    // trace:true records each call {t (ms since patch), args, ret[, threw]} into a ring buffer — read
    // via patch_calls. The runtime companion to coir's STATIC command flow: confirm real order + timing live.
    const trace = !!hooks.trace; const traceMax = hooks.traceMax || 200; const calls = []; const t0 = Date.now();
    const wrapper = function (...args) {
      let a = args; const started = Date.now();
      if (before) { try { const r = before(a, this); if (Array.isArray(r)) a = r; } catch (e) { errors.push('before: ' + ((e && e.message) || e)); } }
      let ret, threw = null;
      try { ret = replace ? replace(a, this) : orig.apply(this, a); } catch (e) { threw = e; }   // orig/replace throw still propagates (below)
      if (after && !threw) { try { const r = after(a, ret, this); if (r !== undefined) ret = r; } catch (e) { errors.push('after: ' + ((e && e.message) || e)); } }
      if (trace) { calls.push({ t: started - t0, args: traceVal(a), ...(threw ? { threw: (threw && threw.message) || String(threw) } : { ret: traceVal(ret) }) }); if (calls.length > traceMax) calls.shift(); }
      if (threw) throw threw;
      return ret;
    };
    try { tgt[member] = wrapper; } catch (e) { return { ok: false, reason: 'unwritable', error: (e && e.message) || String(e) }; }
    PATCHES.set(sel, { target: tgt, member, hadOwn, orig, errors, calls });
    return { ok: true, ref: sel, method: member, hooks: ['before', 'after', 'replace'].filter((k) => hooks[k]), ...(trace ? { trace: true } : {}) };
  }
  function patchImpl(sel, hooks = {}) {
    let comp, member;
    try { const p = splitMember(sel); const n = resolve(root(), rt, p.path); if (!n) return { ok: false, reason: 'not-found', ref: sel }; comp = rt.getComponent(n, p.comp); member = p.member; }
    catch (e) { return { ok: false, reason: 'bad-selector', error: (e && e.message) || String(e) }; }
    if (!comp) return { ok: false, reason: 'no-component', ref: sel };
    return wrapTarget(sel, comp, member, hooks);
  }
  // pm_patch: wrap a framework proxy/mediator method (instance) or a command's execute (class prototype),
  // resolved through the registered adapter — so a game's app-layer flow (the 500 command chain) is
  // traceable without rebuilding. Same hooks/trace/restore as patch; fail-loud when unresolvable.
  function pmPatchImpl(sel, hooks = {}) {
    const pt = patchTargetWith(target, FW, sel);
    if (!pt.ok) return pt;
    const r = wrapTarget(sel, pt.target, pt.member, hooks);
    return r.ok ? { ...r, kind: pt.kind } : r;   // kind: 'instance' (proxy/mediator) | 'command' (class prototype)
  }
  // Read a traced patch's recorded calls (empty if the patch wasn't trace:true / doesn't exist).
  function patchCallsImpl(sel) { const p = PATCHES.get(sel); return { ok: !!p, ref: sel, calls: p && p.calls ? p.calls.slice() : [] }; }
  function patchClearImpl(sel) {
    const errsOf = (k) => { const p = PATCHES.get(k); return p && p.errors.length ? p.errors.slice() : null; };
    if (sel) { const he = errsOf(sel); const ok = restore(sel); return { ok: true, cleared: ok ? [sel] : [], ...(he ? { hookErrors: { [sel]: he } } : {}) }; }
    const all = [...PATCHES.keys()]; const hookErrors = {};
    for (const k of all) { const he = errsOf(k); if (he) hookErrors[k] = he; }
    for (const k of all) restore(k);
    return { ok: true, cleared: all, ...(Object.keys(hookErrors).length ? { hookErrors } : {}) };
  }

  // ---- hold: FREEZE the engine loop at a trigger so a transient state can be screenshot/inspected ----
  // A self-running flow passes through intermediate states too fast to screenshot (an intermediate window
  // can be ~1s). `hold` arms a ONE-SHOT patch on a trigger method (a component method, or a
  // framework command/notification via pmMode); when it fires, the engine main loop is paused — the last
  // frame stays on the canvas (screenshot captures it) and reads (get/pm_get/snapshot) still work, since
  // they don't need the loop. `release` resumes. The freeze itself is the ENGINE's (engine.freeze), which
  // fails LOUD when nothing resolves (copse convention). Boundary: pausing freezes EVERYTHING that runs
  // through the engine loop (scheduler/tween/animation/engine callbacks); a state driven by a bare
  // browser setTimeout won't freeze, and a held game can't be driven further until release.
  let HOLD = null; // { sel, at, holdMs, active, via, t, timer } — one hold at a time
  // the armed trigger hook (a direct closure — holdImpl runs in-page, so no global lookup needed) fires
  // ONE-SHOT: freeze, record, unpatch the trigger so it can't re-fire.
  function doHold() {
    if (!HOLD || HOLD.active) return;                    // already fired, or released
    const via = engine.freeze();
    HOLD.active = true; HOLD.via = via; HOLD.t = Date.now();
    restore(HOLD.sel);                                    // one-shot: the trigger won't re-fire
    if (HOLD.holdMs) HOLD.timer = setTimeout(() => { try { releaseImpl(); } catch { /* */ } }, HOLD.holdMs); // setTimeout is unaffected by the engine pause
  }
  /** @param {string} triggerSel @param {{at?:'before'|'after', holdMs?:number, pmMode?:boolean}} [opts] */
  function holdImpl(triggerSel, { at = 'after', holdMs, pmMode } = {}) {
    if (!engine.canFreeze()) return { ok: false, reason: 'no-freeze-api', note: 'no loop-pause API resolves on this build — cannot freeze the loop' };
    if (HOLD) releaseImpl();                              // replace any prior hold (also unfreezes if held)
    HOLD = { sel: triggerSel, at, holdMs, active: false, via: null, t: 0, timer: null };
    const arm = (pmMode ? pmPatchImpl : patchImpl)(triggerSel, { [at]: () => doHold() });
    if (!arm.ok) { HOLD = null; return arm; }
    const kind = /** @type {any} */ (arm).kind;          // present only for a pmMode (command/instance) trigger
    return { ok: true, armed: true, sel: triggerSel, at, ...(kind ? { kind } : {}), ...(holdMs ? { holdMs } : {}) };
  }
  function releaseImpl() {
    if (!HOLD) return { ok: true, resumed: false, note: 'nothing held' };
    const wasHeld = HOLD.active; const heldMs = wasHeld ? Date.now() - HOLD.t : 0;
    if (HOLD.timer) { try { clearTimeout(HOLD.timer); } catch { /* */ } }
    restore(HOLD.sel);                                    // clear the trigger if it never fired
    const resumed = wasHeld ? engine.unfreeze() : false;
    HOLD = null;
    return { ok: true, resumed, wasHeld, heldMs };
  }
  const holdStatusImpl = () => (HOLD ? { armed: !HOLD.active, held: !!HOLD.active, sel: HOLD.sel, via: HOLD.via, sinceMs: HOLD.active ? Date.now() - HOLD.t : 0 } : { armed: false, held: false });

  const api = {
    snapshot: (opts) => snapshot(root(), rt, opts),
    interactive: (opts) => snapshot(root(), rt, { onlyInteractive: true, reachability: true, ...opts }), // pressable list, with reachability
    // join-ready click surface: one row per editor-wired clickEvent, keyed (ref, method) — the same
    // key coir emits statically, so an agent can cross-reference static wiring with what's live now.
    clickSurface: (opts) => clickSurface(snapshot(root(), rt, { onlyInteractive: true, reachability: (opts && opts.reachability) !== false, includeInactive: opts && opts.includeInactive })),
    // press is the ONE primitive an engine may need to replace outright rather than adapt: Cocos
    // CALLS the wired handler (reachability an opt-in gate), while an engine with no serialized
    // handlers must drive real input through its own pipeline and is therefore inherently gated
    // (docs/ENGINES.md §4). An engine that supplies `engine.press` owns the whole contract — it
    // must return the same `{ok, ref, drove, …}` shape so callers stay engine-agnostic.
    press: engine.press ? (path, opts) => engine.press(path, opts) : (path, opts) => press(root(), rt, path, opts),
    get: (sel) => get(root(), rt, sel),
    call: (sel, ...args) => call(root(), rt, sel, args),
    reachable: (sel) => reachable(root(), rt, sel),       // { reachable, blockedBy }
    node: (sel) => node(root(), rt, sel),                 // node intrinsics (active/opacity/scale/worldPos/size)
    diff: (before, after) => diff(before, after),         // snapshot diff → appeared/activated/labelChanged/…
    listeners: (sel) => { const n = resolve(root(), rt, sel); return n ? rt.codeHandlers(n) : null; },
    // Node-anchored VISUAL manifest (screen rect + dynamic mask rects in viewport CSS px) — the companion to
    // `reachable`; the driver screenshots + downsamples + compares (src/sensors/pixel.js). Engine-supplied.
    visualManifest: (sel) => engine.visualManifest(sel),
    // orient: one-call bearings — scene + engine + framework capabilities + a few pressable entry points,
    // so a newcomer/agent doesn't stitch probe + framework + interactive by hand after connect.
    orient: () => {
      const scene = root();
      const inter = snapshot(root(), rt, { onlyInteractive: true, reachability: true });
      const entryPoints = inter.filter((d) => d.reachable !== false && d.interactable !== false).slice(0, 8).map((d) => d.ref);
      return {
        // "where am I" is engine-shaped: Cocos has a named scene, Pixi's stage is anonymous and the
        // meaningful answer is the mounted screen (its anchor). An engine may override.
        scene: engine.scene ? engine.scene() : ((scene && (scene.name || scene._name)) || null),
        engine: engine.version(),
        framework: { ...describe(target, FW), registered: FW.length },
        buttons: inter.length,
        entryPoints,
      };
    },
    probe: () => engine.probe(),                          // engine-coupling self-diagnostic
    logs: (since = 0) => (target.__copseLogs || []).filter((l) => l.t > since), // console + uncaught errors
    watch: (opts) => watchImpl(opts),                     // diff-only timeline of exprs/selectors over time
    patch: (sel, hooks) => patchImpl(sel, hooks),         // wrap a live method to verify a fix pre-rebuild
    patch_clear: (sel) => patchClearImpl(sel),            // restore patched method(s)
    patch_calls: (sel) => patchCallsImpl(sel),            // read a trace:true patch's recorded calls (order/timing)
    hold: (sel, opts) => holdImpl(sel, opts),             // freeze the loop at a trigger → screenshot/inspect a transient state
    release: () => releaseImpl(),                         // resume the loop (clears the hold/trigger)
    hold_status: () => holdStatusImpl(),                  // { armed?, held?, sel, via, sinceMs }
    registerFramework: (a) => registerInto(FW, a),        // install an adapter for this session (auto-loaded from copse.frameworks.mjs, or ad-hoc)
    framework: () => ({ ...describe(target, FW), registered: FW.length }), // detect via registered adapters + enumerate proxies/mediators
    pmGet: (sel) => stateWith(target, FW, sel, false),    // READ proxy/mediator state (outside the node tree)
    pmSet: (sel, value) => stateWith(target, FW, sel, true, value), // WRITE a proxy/mediator leaf
    pmCall: (sel, args) => callWith(target, FW, sel, args), // call a proxy/mediator method
    pmPatch: (sel, hooks) => pmPatchImpl(sel, hooks),     // wrap a proxy/mediator/command method (patch_clear/patch_calls apply)
    pmNotify: (name, body, type) => notifyWith(target, FW, name, body, type), // fire a framework notification (direct flow entry)
    rt, // exposed for ad-hoc poking from a console
  };
  // pm.* — the framework surface under a stable, discoverable namespace, ergonomic for `eval`: the snake_case
  // TOOL names (pm_get) don't exist in-page (the members are camelCase), so `__copse.pm_get(...)` throws
  // "is not a function". `pm.get/set/call/notify/patch` alias the camelCase members (ONE implementation, no
  // divergence); `pm.proxy(name)`/`pm.mediator(name)` hand back the RAW live object for ad-hoc poking (no JSON
  // boundary in-page) — what you'd otherwise dig out of puremvc.Facade.instance.retrieveProxy(...) by hand.
  api.pm = {
    get: api.pmGet, set: api.pmSet, call: (sel, ...args) => api.pmCall(sel, args),
    notify: api.pmNotify, patch: api.pmPatch,
    proxy: (name) => retrieveWith(target, FW, name),
    mediator: (name) => retrieveWith(target, FW, name),
  };
  return api;
}
