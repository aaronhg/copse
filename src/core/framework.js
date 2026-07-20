// @ts-check
// Framework-aware state access — a GENERIC adapter engine. copse core ships NO framework knowledge
// (not every Cocos game uses PureMVC, and those that do wire it differently); a game's logic state
// often lives OUTSIDE the cc node tree (a PureMVC proxy holds active/stateData), which get/call
// can't reach. This module lets an ADAPTER describe how to find that state, and reads/writes/calls
// through it. Adapters are installed per-session (auto-loaded from a project/machine copse.frameworks.mjs
// by the driver, or via __copse.registerFramework) — never compiled into the core bundle.
//
// Two adapter shapes:
//   • CONFIG (pure data, JSON-serialisable → easy to inject/share): {kind, facade:[…locations],
//     proxy:{via?,map?}, mediator:{via?,map?}, command:{map?}}. `facade` is a list of candidate
//     locations relative to the window ('puremvc.Facade.instance', or 'a.b.*' to expand a map and take
//     each value); `via` is a retrieve METHOD name (retrieveProxy), `map` a list of registry-map paths.
//     Field-name candidates absorb the per-game/per-port differences without touching copse.
//   • CODE (an object/source string exposing detect/proxies/mediators/commands/retrieve) — for a
//     framework the config shape can't express.
// Pure over a `win` + `adapters` array (globalThis + the registry in-page; plain fakes in tests).
import { jsonSafe } from './eval-cond.js'; // shared (cycle-safe) — one copy, not a second byte-for-byte one

// Resolve a dotted path against an object ('a.b.c'); '' → the object itself.
const getPath = (obj, path) => (path ? String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), obj) : obj);
// First present, object-valued path among candidates (a registry map like model.proxyMap).
const mapObj = (root, paths) => { for (const p of (paths || [])) { const m = getPath(root, p); if (m && typeof m === 'object') return m; } return null; };
// "GameDataProxy.sessionData.remaining" → { name:'GameDataProxy', path:['sessionData','remaining'] }
const splitSel = (sel) => { const parts = String(sel).split('.'); return { name: parts[0], path: parts.slice(1) }; };

// Yield each candidate facade object for a list of location exprs. 'a.b.*' expands a map: yields each value.
function* facadeCandidates(win, exprs) {
  for (const expr of exprs) {
    if (typeof expr !== 'string') continue;
    if (expr.endsWith('.*')) {
      const base = getPath(win, expr.slice(0, -2));
      if (base && typeof base === 'object') for (const k of Object.keys(base)) yield base[k];
    } else {
      const v = getPath(win, expr);
      if (v != null) yield v;
    }
  }
}

// A candidate is a valid facade/root if the adapter can reach ANY registry through it — a `via` method
// or a resolvable map for proxy, mediator, OR command. Anchoring on proxy alone hid a facade whose
// proxy field didn't match but whose mediator/command did. Config-driven, so no PureMVC name is hard-coded.
const hasRegistry = (root, spec) => !!spec && ((spec.via && typeof root[spec.via] === 'function') || !!mapObj(root, spec.map));
const canRoot = (root, cfg) => !!root && typeof root === 'object'
  && (hasRegistry(root, cfg.proxy) || hasRegistry(root, cfg.mediator) || hasRegistry(root, cfg.command));

const asList = (v, dflt) => (Array.isArray(v) ? v : (v != null ? [v] : dflt));

// "puremvc.Observer.prototype.notifyObserver" → { objPath:'puremvc.Observer.prototype', member:'notifyObserver' }
const splitLast = (p) => { const i = String(p).lastIndexOf('.'); return i < 0 ? null : { objPath: String(p).slice(0, i), member: String(p).slice(i + 1) }; };
// First candidate path that resolves to an object carrying a callable member — the wrap target.
const firstMethodAt = (win, paths) => {
  for (const p of asList(paths, [])) {
    const sp = splitLast(p); if (!sp) continue;
    const obj = getPath(win, sp.objPath);
    if (obj && typeof obj[sp.member] === 'function') return { at: p, target: obj, member: sp.member };
  }
  return null;
};

/**
 * Turn a CONFIG object into the adapter interface. `via`/`map` field-name CANDIDATE lists absorb the
 * per-game/per-port NAME differences; a code adapter (its own detect/retrieve/commandTarget/notify)
 * covers STRUCTURAL differences the config can't express.
 * @param {any} cfg
 */
function configAdapter(cfg) {
  const facExprs = asList(cfg.facade, []);
  const retrieveVia = (root, name, spec) => {
    if (!spec) return null;
    if (spec.via && typeof root[spec.via] === 'function') { try { const o = root[spec.via](name); if (o) return o; } catch { /* */ } }
    const m = mapObj(root, spec.map); return m ? (m[name] ?? null) : null;
  };
  const commandEntry = (root, name) => { const m = mapObj(root, cfg.command && cfg.command.map); return m ? m[name] : undefined; };
  // A command is TRANSIENT (a fresh instance per notification) → we patch its CLASS prototype, not an
  // instance. Resolve the class from the commandMap entry (usually the class fn itself), then the execute
  // method by candidate name. `member` (from the sel) wins if given, else the first execute candidate.
  const commandTarget = (root, name, member) => {
    const entry = commandEntry(root, name);
    const cls = (typeof entry === 'function' && entry.prototype) ? entry : null;   // entry IS the class (standard PureMVC)
    if (!cls) return null;
    const proto = cls.prototype;
    const m = (member && typeof proto[member] === 'function') ? member : asList(cfg.command && cfg.command.execute, ['execute']).find((k) => typeof proto[k] === 'function');
    return m ? { proto, member: m } : null;
  };
  const notify = (root, name, body, type) => {
    for (const v of asList(cfg.notify && cfg.notify.via, ['sendNotification'])) {
      if (typeof root[v] === 'function') { try { return { ok: true, via: v, value: jsonSafe(root[v](name, body, type)) }; } catch (e) { return { ok: false, reason: 'threw', error: (e && e.message) || String(e) }; } }
    }
    return { ok: false, reason: 'no-notify-method' };
  };
  return {
    kind: cfg.kind || 'framework',
    detect: (win) => { for (const c of facadeCandidates(win, facExprs)) if (canRoot(c, cfg)) return c; return null; },
    proxies: (root) => Object.keys(mapObj(root, cfg.proxy && cfg.proxy.map) || {}),
    mediators: (root) => Object.keys(mapObj(root, cfg.mediator && cfg.mediator.map) || {}),
    commands: (root) => Object.keys(mapObj(root, cfg.command && cfg.command.map) || {}),
    retrieve: (root, name) => retrieveVia(root, name, cfg.proxy) || retrieveVia(root, name, cfg.mediator),
    commandTarget, notify,
    trace: cfg.trace || null,   // pure data — resolved against the WINDOW by traceTargetsWith, not the facade
    // Self-diagnostic: which capabilities RESOLVE on this build (so pointing copse at a new PureMVC game
    // shows what to fix in the config, instead of a silent no-op). Mirrors probe()'s per-internal report.
    capabilities: (root) => {
      const has = (spec) => !!((spec && spec.via && typeof root[spec.via] === 'function') || mapObj(root, spec && spec.map));
      const cmap = mapObj(root, cfg.command && cfg.command.map);
      const first = cmap && Object.values(cmap)[0];
      const command = !cmap ? 'unresolved' : (first === undefined ? 'empty-map' : ((typeof first === 'function' && first.prototype) ? 'class' : 'map-only'));
      let notifyVia = false; for (const v of asList(cfg.notify && cfg.notify.via, ['sendNotification'])) if (typeof root[v] === 'function') { notifyVia = v; break; }
      return { proxy: has(cfg.proxy), mediator: has(cfg.mediator), command, notify: notifyVia };
    },
  };
}

/**
 * Normalise any adapter form to the interface: a code-adapter object (has detect), a config object
 * (has facade), a source string (eval'd → recurse), or a factory function (called → recurse). null on junk.
 * @param {any} a
 */
export function normalizeAdapter(a) {
  if (a == null) return null;
  if (typeof a === 'string') { let obj; try { obj = (0, eval)('(' + a + ')'); } catch { return null; } return normalizeAdapter(obj); }
  if (typeof a === 'function') { try { return normalizeAdapter(a()); } catch { return null; } }
  if (typeof a.detect === 'function') return a;   // already a code adapter
  if (a.facade) return configAdapter(a);          // config adapter
  return null;
}

/**
 * Register an adapter into a store array, de-duped by `kind` (re-registering a kind replaces it).
 * @param {any[]} store @param {any} a
 */
export function registerInto(store, a) {
  const na = normalizeAdapter(a);
  if (!na) return { ok: false, reason: 'bad-adapter' };
  const i = store.findIndex((x) => x.kind === na.kind);
  if (i >= 0) store[i] = na; else store.push(na);
  return { ok: true, kind: na.kind, registered: store.length };
}

/**
 * Run each registered adapter's detect against `win`; the first to return a root wins.
 * @param {any} win @param {any[]} [adapters] @returns {{adapter:any, root:any}|null}
 */
export function detectWith(win, adapters) {
  for (const a of (adapters || [])) { try { const root = a.detect(win); if (root) return { adapter: a, root }; } catch { /* */ } }
  return null;
}

/**
 * Detect the framework + enumerate its registries (best-effort, never throws). {kind:'none'} if no
 * registered adapter matches — which is the honest default when core ships no framework knowledge.
 * @param {any} win @param {any[]} [adapters]
 */
export function describe(win, adapters) {
  const hit = detectWith(win, adapters);
  if (!hit) return { kind: 'none' };
  const { adapter: a, root } = hit;
  const safe = (fn) => { try { return fn() || []; } catch { return []; } };
  const caps = (() => { try { return a.capabilities ? a.capabilities(root) : undefined; } catch { return undefined; } })();
  return { kind: a.kind, proxies: safe(() => a.proxies(root)), mediators: safe(() => a.mediators(root)), commands: safe(() => a.commands(root)), ...(caps ? { capabilities: caps } : {}) };
}

/**
 * Resolve sel="Name.method" to a PATCHABLE target for pm_patch: a proxy/mediator INSTANCE, or — when the
 * name is a command (transient per notification) — its CLASS PROTOTYPE, so one wrap covers all instances.
 * Returns the live target for the in-page patch machinery (never crosses a JSON boundary). Fails LOUD.
 * @param {any} win @param {any[]} adapters @param {string} sel
 */
export function patchTargetWith(win, adapters, sel) {
  const hit = detectWith(win, adapters);
  if (!hit) return { ok: false, reason: 'no-framework' };
  const { name, path } = splitSel(sel);
  if (path.length !== 1) return { ok: false, reason: 'need-Name.method' };
  const member = path[0];
  const obj = (typeof hit.adapter.retrieve === 'function') ? hit.adapter.retrieve(hit.root, name) : null; // guard: command-only adapters omit retrieve
  if (obj) { if (typeof obj[member] !== 'function') return { ok: false, reason: 'no-method', method: member }; return { ok: true, kind: 'instance', target: obj, member, name }; }
  const ct = hit.adapter.commandTarget ? hit.adapter.commandTarget(hit.root, name, member) : null;
  if (ct && typeof ct.proto[ct.member] === 'function') return { ok: true, kind: 'command', target: ct.proto, member: ct.member, name };
  return { ok: false, reason: 'not-found', name };
}

/**
 * Resolve the adapter's `trace` hook points to PATCHABLE targets: [{role, at, target, member, label}].
 *
 * Why this exists next to patchTargetWith rather than inside it: a framework's DISPATCH choke points live
 * on the framework's own CLASSES, not in its registries. Measured on a real PureMVC build, patching what
 * the registries hand you does NOT observe dispatch — `registerMediator` does
 * `new Observer(mediator.handleNotification, mediator)` and `registerCommand` does
 * `new Observer(this.executeCommand, this)`, i.e. both capture the function VALUE at registration, so a
 * later wrap of the mediator instance (or of Controller.prototype.executeCommand) is never called: it was
 * measured firing 0 times across 60 command executions. The observable points are the class prototypes the
 * Observer ultimately calls THROUGH. So `at` is a dotted path from the WINDOW ('puremvc.Observer.prototype
 * .notifyObserver'), candidate-listed like every other adapter field, and per-game knowledge stays in
 * copse.frameworks.mjs. A code adapter may instead expose its own `traceTargets(win, roles)`.
 *
 * `label` (a fn-expr source string, compiled in-page by the patch machinery) is what makes a trace row
 * readable: the raw args of these methods are a Notification object, so without an extractor a timeline is
 * a wall of truncated objects — and the useful field ("which mediator is this going to") lives on `self`,
 * which the generic arg-recorder cannot reach at all.
 *
 * @param {any} win @param {any[]} adapters @param {string[]} [roles] only these roles (default: all)
 */
export function traceTargetsWith(win, adapters, roles) {
  const hit = detectWith(win, adapters);
  if (!hit) return { ok: false, reason: 'no-framework' };
  const a = hit.adapter;
  if (typeof a.traceTargets === 'function') {   // code adapter brings its own
    try { return a.traceTargets(win, roles); } catch (e) { return { ok: false, reason: 'threw', error: (e && e.message) || String(e) }; }
  }
  const spec = a.trace;
  if (!spec || typeof spec !== 'object') return { ok: false, reason: 'adapter-has-no-trace', kind: a.kind, hint: "add a `trace:{role:{at:[…paths], label?}}` block to this adapter in copse.frameworks.mjs" };
  const want = (roles && roles.length) ? roles : null;
  const targets = []; const unresolved = [];
  for (const role of Object.keys(spec)) {
    if (want && !want.includes(role)) continue;
    const s = spec[role] || {};
    const found = firstMethodAt(win, s.at);
    if (!found) { unresolved.push({ role, tried: asList(s.at, []) }); continue; }   // fail LOUD per role, don't silently thin the timeline
    targets.push({ role, at: found.at, target: found.target, member: found.member, label: s.label || null });
  }
  if (want) for (const r of want) if (!spec[r]) unresolved.push({ role: r, tried: [], reason: 'no-such-role' });
  return { ok: targets.length > 0, targets, ...(unresolved.length ? { unresolved } : {}) };
}

/**
 * Fire a framework notification (PureMVC facade.sendNotification etc.) — the most direct entry into a
 * notification-driven flow. Uses the adapter's `notify` (config: `via` method-name candidates; code
 * adapter: its own fn). Fails LOUD when no notify path resolves.
 * @param {any} win @param {any[]} adapters @param {string} name @param {any} [body] @param {any} [type]
 */
export function notifyWith(win, adapters, name, body, type) {
  const hit = detectWith(win, adapters);
  if (!hit) return { ok: false, reason: 'no-framework' };
  if (!hit.adapter.notify) return { ok: false, reason: 'adapter-has-no-notify' };
  try { return hit.adapter.notify(hit.root, name, body, type); }
  catch (e) { return { ok: false, reason: 'threw', error: (e && e.message) || String(e) }; }
}

/**
 * Read (or write) proxy/mediator state: sel = "Name.prop.subprop". When `hasValue`, sets the leaf.
 * @param {any} win @param {any[]} adapters @param {string} sel @param {boolean} [hasValue] @param {any} [value]
 */
export function stateWith(win, adapters, sel, hasValue, value) {
  const hit = detectWith(win, adapters);
  if (!hit) return { ok: false, reason: 'no-framework' };
  if (typeof hit.adapter.retrieve !== 'function') return { ok: false, reason: 'adapter-no-retrieve' };
  const { name, path } = splitSel(sel);
  const obj = hit.adapter.retrieve(hit.root, name);
  if (!obj) return { ok: false, reason: 'not-found', name };
  if (!path.length) return { ok: false, reason: 'need-a-property', hint: `${name}.<prop>` };
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) cur = cur == null ? cur : cur[path[i]];
  if (cur == null || typeof cur !== 'object') return { ok: false, reason: 'no-path', at: path.slice(0, -1).join('.') };
  const leaf = path[path.length - 1];
  if (hasValue) {
    // GUARD the assignment (a read-only/getter leaf throws in strict mode) + VERIFY it landed (in sloppy
    // mode the assignment silently no-ops) — so a fix-probe never reports a write that didn't take effect.
    const before = (() => { try { return cur[leaf]; } catch { return undefined; } })();
    try { cur[leaf] = value; } catch (e) { return { ok: false, reason: 'write-failed', error: (e && e.message) || String(e) }; }
    let after; try { after = cur[leaf]; } catch { after = undefined; }
    if (after !== value && after === before) return { ok: false, reason: 'write-no-effect', ref: sel, note: 'leaf appears read-only / getter-backed' };
    // wrote = the intent; if a setter TRANSFORMED it (after !== value, but it DID change), surface the
    // read-back as `landed` so silent normalisation/coercion is visible. Omitted when it landed exactly.
    return { ok: true, ref: sel, wrote: jsonSafe(value), ...(after !== value ? { landed: jsonSafe(after) } : {}) };
  }
  return { ok: true, ref: sel, value: jsonSafe(cur[leaf]) };
}

/**
 * Hand back the RAW live proxy/mediator OBJECT by name (the thing `retrieveProxy`/`mediatorMap[...]`
 * returns), for ad-hoc in-page poking from `eval` — no JSON boundary, so the live object is returned
 * as-is. Forgiving lookup: the adapter's `retrieve` tries the proxy registry then the mediator one,
 * so `pm.proxy('GameDataProxy')` and `pm.mediator('XxxViewMediator')` both resolve. null when there's
 * no framework / no such name. (`pm_get`/`stateWith` are the SELECTOR path; this is the object path.)
 * @param {any} win @param {any[]} adapters @param {string} name @returns {any|null}
 */
export function retrieveWith(win, adapters, name) {
  const hit = detectWith(win, adapters);
  if (!hit || typeof hit.adapter.retrieve !== 'function') return null;
  try { return hit.adapter.retrieve(hit.root, name) || null; } catch { return null; }
}

/**
 * Call a method on a proxy/mediator: sel = "Name.method", args = the arguments.
 * @param {any} win @param {any[]} adapters @param {string} sel @param {any[]} [args]
 */
export function callWith(win, adapters, sel, args = []) {
  const hit = detectWith(win, adapters);
  if (!hit) return { ok: false, reason: 'no-framework' };
  if (typeof hit.adapter.retrieve !== 'function') return { ok: false, reason: 'adapter-no-retrieve' };
  const { name, path } = splitSel(sel);
  const obj = hit.adapter.retrieve(hit.root, name);
  if (!obj) return { ok: false, reason: 'not-found', name };
  if (path.length !== 1) return { ok: false, reason: 'need-Name.method' };
  const m = obj[path[0]];
  if (typeof m !== 'function') return { ok: false, reason: 'no-method', method: path[0] };
  try { return { ok: true, ref: sel, value: jsonSafe(m.apply(obj, args)) }; }
  catch (e) { return { ok: false, reason: 'threw', error: (e && e.message) || String(e) }; }
}
