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

const jsonSafe = (v) => { try { JSON.stringify(v); return v; } catch { try { return String(v); } catch { return '[unserializable]'; } } };
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

// A candidate is a valid facade/root if the adapter can retrieve proxies through it (a `via` method
// exists, or a proxy map resolves) — config-driven, so this never hard-codes a PureMVC method name.
const canRoot = (root, cfg) => !!root && typeof root === 'object'
  && ((cfg.proxy && cfg.proxy.via && typeof root[cfg.proxy.via] === 'function') || !!mapObj(root, cfg.proxy && cfg.proxy.map));

/**
 * Turn a CONFIG object into the adapter interface (detect/proxies/mediators/commands/retrieve).
 * @param {any} cfg
 */
function configAdapter(cfg) {
  const facExprs = Array.isArray(cfg.facade) ? cfg.facade : (cfg.facade ? [cfg.facade] : []);
  const retrieveVia = (root, name, spec) => {
    if (!spec) return null;
    if (spec.via && typeof root[spec.via] === 'function') { try { const o = root[spec.via](name); if (o) return o; } catch { /* */ } }
    const m = mapObj(root, spec.map); return m ? (m[name] ?? null) : null;
  };
  return {
    kind: cfg.kind || 'framework',
    detect: (win) => { for (const c of facadeCandidates(win, facExprs)) if (canRoot(c, cfg)) return c; return null; },
    proxies: (root) => Object.keys(mapObj(root, cfg.proxy && cfg.proxy.map) || {}),
    mediators: (root) => Object.keys(mapObj(root, cfg.mediator && cfg.mediator.map) || {}),
    commands: (root) => Object.keys(mapObj(root, cfg.command && cfg.command.map) || {}),
    retrieve: (root, name) => retrieveVia(root, name, cfg.proxy) || retrieveVia(root, name, cfg.mediator),
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
  return { kind: a.kind, proxies: safe(() => a.proxies(root)), mediators: safe(() => a.mediators(root)), commands: safe(() => a.commands(root)) };
}

/**
 * Read (or write) proxy/mediator state: sel = "Name.prop.subprop". When `hasValue`, sets the leaf.
 * @param {any} win @param {any[]} adapters @param {string} sel @param {boolean} [hasValue] @param {any} [value]
 */
export function stateWith(win, adapters, sel, hasValue, value) {
  const hit = detectWith(win, adapters);
  if (!hit) return { ok: false, reason: 'no-framework' };
  const { name, path } = splitSel(sel);
  const obj = hit.adapter.retrieve(hit.root, name);
  if (!obj) return { ok: false, reason: 'not-found', name };
  if (!path.length) return { ok: false, reason: 'need-a-property', hint: `${name}.<prop>` };
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) cur = cur == null ? cur : cur[path[i]];
  if (cur == null || typeof cur !== 'object') return { ok: false, reason: 'no-path', at: path.slice(0, -1).join('.') };
  const leaf = path[path.length - 1];
  if (hasValue) { cur[leaf] = value; return { ok: true, ref: sel, wrote: jsonSafe(value) }; }
  return { ok: true, ref: sel, value: jsonSafe(cur[leaf]) };
}

/**
 * Call a method on a proxy/mediator: sel = "Name.method", args = the arguments.
 * @param {any} win @param {any[]} adapters @param {string} sel @param {any[]} [args]
 */
export function callWith(win, adapters, sel, args = []) {
  const hit = detectWith(win, adapters);
  if (!hit) return { ok: false, reason: 'no-framework' };
  const { name, path } = splitSel(sel);
  const obj = hit.adapter.retrieve(hit.root, name);
  if (!obj) return { ok: false, reason: 'not-found', name };
  if (path.length !== 1) return { ok: false, reason: 'need-Name.method' };
  const m = obj[path[0]];
  if (typeof m !== 'function') return { ok: false, reason: 'no-method', method: path[0] };
  try { return { ok: true, ref: sel, value: jsonSafe(m.apply(obj, args)) }; }
  catch (e) { return { ok: false, reason: 'threw', error: (e && e.message) || String(e) }; }
}
