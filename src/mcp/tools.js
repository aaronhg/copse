// @ts-check
// copse MCP tool registry — one entry per tool: { name, description, inputSchema, run(state,args) }.
// `run` drives the live session in `state.cp` (a copse Driver from connect()) and RETURNS
// { data } / { error } — it never prints (stdout is the MCP protocol channel); server.js turns
// the result into an MCP tool result. The `connect` tool establishes state.cp (lazy-importing the
// puppeteer driver — the only peer-dep edge); `close` tears it down. Selectors use copse's
// grammar: Parent/Child:Comp.prop, [i] to disambiguate same-name siblings.
//
// Tools tagged `debug: true` (the CDP Debugger surface: break_*/wait_pause/eval_frame/debug_step/
// clear_breakpoints) are HIDDEN from tools/list by default — they're dev-build-only (pausing the
// runtime is intrusive, only sensible on a build you own) and would otherwise crowd the menu. `copse mcp --debug` surfaces them
// (server.js filters by this tag). They stay callable by name regardless, so tests/power-users
// aren't blocked.

import { resolveCoirPath, coverageJoin } from '../coverage.js';
import { runScript } from '../script.js';

const needCp = (state) => {
  if (!state.cp) throw new Error('no open game — call the `connect` tool with a url first');
  return state.cp;
};

// ---- session recording (docs/SCRIPTS.md) ----------------------------------------------
// Tools tagged `record: true` push a script step + `observed` onto state.history after each
// successful call (wrapped at the bottom of this file), so `dump_script` can export the whole
// session as a replayable skeleton. connect/reload/close are transport — never recorded.

// MCP tool args → the harness/script Step shape ({op, ref?/sel?/args?/opts?}).
const toStep = (name, a = {}) => {
  switch (name) {
    case 'press': {
      const s = { op: 'press', ref: a.ref }; const o = {};
      if (a.force) o.force = true; if (a.reachableGate) o.reachableGate = true;
      if (Object.keys(o).length) s.opts = o;
      return s;
    }
    case 'get': return { op: 'get', sel: a.sel };
    case 'call': return { op: 'call', sel: a.sel, ...(a.args && a.args.length ? { args: a.args } : {}) };
    case 'node': return { op: 'node', ref: a.ref };
    case 'reachable': return { op: 'reachable', ref: a.ref };
    case 'eval': return { op: 'eval', expr: a.expr };
    case 'snapshot': {
      const o = {}; for (const k of ['relevant', 'includeInactive', 'components']) if (a[k] !== undefined) o[k] = a[k];
      return { op: 'snapshot', ...(Object.keys(o).length ? { opts: o } : {}) };
    }
    case 'interactive': return { op: 'interactive' };
    default: return null;
  }
};

// Cap `observed` so a whole-scene snapshot doesn't bloat the recording: long arrays keep the
// first 12 elements (+ a marker), long strings are sliced, depth is bounded. Structure is
// preserved — the agent trims observed into a minimal `expect` at dump time.
const truncate = (v, depth = 0) => {
  if (v === null || typeof v !== 'object') return typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '…' : v;
  if (depth >= 6) return '…(deep)';
  if (Array.isArray(v)) {
    const head = v.slice(0, 12).map((x) => truncate(x, depth + 1));
    if (v.length > 12) head.push(`…(+${v.length - 12} more)`);
    return head;
  }
  const o = {};
  for (const k of Object.keys(v)) o[k] = truncate(v[k], depth + 1);
  return o;
};

// Lazily attach the CDP Debugger over the live session (state.dbg). Tests can pre-seed state.dbg.
const ensureDbg = async (state) => {
  if (!state.dbg) {
    const cp = needCp(state);
    const { attachDebugger } = await import('../debug.js');
    state.dbg = await attachDebugger(cp.page);
  }
  return state.dbg;
};

/** @type {{name:string,description:string,inputSchema:any,debug?:boolean,record?:boolean,run:(state:any,args:any)=>Promise<{data?:any,error?:string,image?:any}>}[]} */
export const TOOLS = [
  {
    name: 'connect',
    description: 'Launch a browser at <url> (or ATTACH to an already-open tab), load a running Cocos game, inject copse, wait until ready. Call this FIRST (same operation as the library connect()). headed:true shows a window; browserURL points at your own Chrome (started with --remote-debugging-port). attach:true + match drives an ALREADY-OPEN tab without navigating — use this for your own game behind a login/staging gate you opened yourself; omit match AND url to attach the ACTIVE tab (e.g. one chrome-devtools-mcp brought to front). Returns a readiness summary.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'the running game URL (omit when attach:true — use match instead)' },
        headed: { type: 'boolean', description: 'show a visible browser window (default: headless)' },
        fps: { type: 'number', description: 'frame-rate cap (default 10; raise to watch smoothly)' },
        browserURL: { type: 'string', description: 'CDP URL of an existing Chrome (e.g. http://127.0.0.1:9222) — required for attach' },
        attach: { type: 'boolean', description: 'drive an already-open tab (no navigation) instead of opening a new one' },
        match: { type: 'string', description: 'when attach:true, pick the open tab whose URL contains this substring (omit match AND url to attach the ACTIVE tab)' },
        frameworks: { type: 'array', items: {}, description: 'extra framework adapters (config objects / code-adapter source strings / file paths) on top of the auto-loaded copse.frameworks.mjs — enables framework/pm_state/pm_call' },
      },
    },
    run: async (state, a) => {
      if (state.cp) { try { await state.cp.close(); } catch { /* ignore */ } state.cp = null; }
      state.history = []; // a new session starts a fresh recording (docs/SCRIPTS.md)
      const { connect } = await import('../drivers/puppeteer.js');
      const opts = { ...state.connectOpts };
      if (a.headed) opts.headless = false;
      if (typeof a.fps === 'number') opts.fpsCap = a.fps;
      if (a.browserURL) opts.browserURL = a.browserURL;
      if (a.attach) { opts.attach = true; opts.match = a.match || a.url; }
      if (a.frameworks) opts.frameworks = a.frameworks;
      const target = a.url || opts.match || '';
      state.cp = await connect(target, opts);
      // Report the URL of the tab actually attached (page.url() is CDP-cached, safe even while paused);
      // fall back to the target/match string only if that read fails (it was reporting the match substring).
      const at = () => { try { return state.cp.page.url() || target; } catch { return target; } };
      // paused = the renderer is HALTED in the debugger → copse inject is deferred (it'd hang). Debugger
      // tools work immediately; snapshot/press/break_in auto-run once you resume.
      if (state.cp.paused) return { data: { ok: true, url: at(), attached: true, paused: true, note: 'renderer HALTED (debugger) — inject deferred. Use wait_pause/eval_frame/break_at now; snapshot/press/break_in run after you resume.' } };
      // stalled = init didn't settle in time — almost always the game is on a loading/intro screen (no
      // interactive buttons yet), NOT a debugger pause. __copse is usually already installed, so a read works.
      if (state.cp.stalled) return { data: { ok: true, url: at(), attached: true, injecting: true, note: 'inject still settling — the game looks like it is on a loading/intro screen (no interactive buttons yet). __copse is likely already installed: call snapshot/interactive again in a moment, or reload.' } };
      const snap = await state.cp.snapshot({ relevant: true });
      const inter = await state.cp.interactive();
      return { data: { ok: true, url: at(), attached: !!opts.attach, relevantNodes: snap.length, buttons: inter.length } };
    },
  },
  {
    name: 'reload',
    description: "Reload the attached tab over CDP and re-inject copse. Use it to (1) pick up a DIFFERENT scene after opening it in Cocos Creator (the preview serves the editor's current scene — reload to load it), and (2) recover a wedged / empty / half-loaded preview (e.g. attach found the scene still null, or the renderer was mid-transition). Re-finds the cc frame and re-installs __copse after the navigation. Returns {ok, reloaded, url, relevantNodes, buttons}. Needs an open session (connect first).",
    inputSchema: { type: 'object', properties: { waitUntil: { type: 'string', description: "navigation wait condition: 'load' (default) | 'domcontentloaded' | 'networkidle0' | 'networkidle2'" } } },
    run: async (state, a) => ({ data: await needCp(state).reload(a.waitUntil ? { waitUntil: a.waitUntil } : {}) }),
  },
  {
    name: 'snapshot',
    record: true,
    description: 'Slim live node-tree snapshot: [{ref, button?, interactable?, click?, label?, codeHandlers?}]. Default relevant:true (only nodes with a testable surface — buttons/labels/code-handlers). includeInactive:true also walks hidden subtrees; components:true adds raw component types.',
    inputSchema: { type: 'object', properties: { relevant: { type: 'boolean' }, includeInactive: { type: 'boolean' }, components: { type: 'boolean' } } },
    run: async (state, a) => ({ data: await needCp(state).snapshot({ relevant: a.relevant ?? true, includeInactive: a.includeInactive, components: a.components }) }),
  },
  {
    name: 'interactive',
    record: true,
    description: 'Buttons only, each annotated with reachable/blockedBy (best-effort geometric reachability).',
    inputSchema: { type: 'object', properties: {} },
    run: async (state) => ({ data: await needCp(state).interactive() }),
  },
  {
    name: 'click_surface',
    description: "Join-ready RUNTIME click surface for cross-referencing with coir (copse's static sibling). One row per editor-wired clickEvent: [{ref, method, component?, target?, interactable, reachable?(true|false|'unsure'), blockedBy?, occludedBy?, visible?}]. `method` (the serialized handler name) joins 1:1 to coir's static ClickEvent map — coir's `loc.nodePath` + the method inside its `click → method()` edge — so you can compare what's WIRED (coir, every scene/prefab) against what's LIVE & pressable now (copse, this scene). Buttons wired via raw touch/code (outside coir's static surface) get method:null — and carry `codeHandlers` (their live node.on() listeners) when present, so coverageJoin can call them `codeRegistered` (has a code handler) vs bare `codeOnly` (none) rather than one opaque bucket. `component` is minified on release builds — coir holds the real handler-class name. Set reachability:false to skip the O(buttons×nodes) reachable pass.",
    inputSchema: { type: 'object', properties: { reachability: { type: 'boolean', description: 'include reachable/blockedBy/visible (default true)' }, includeInactive: { type: 'boolean', description: 'also walk hidden subtrees' } } },
    run: async (state, a) => ({ data: await needCp(state).clickSurface({ reachability: a.reachability, includeInactive: a.includeInactive }) }),
  },
  {
    name: 'resolve',
    description: "Translate a coir STATIC nodePath into the live copse `ref` by matching it against the running tree (symmetric tail match — absorbs coir's scene/prefab-file root prefix and a prefab's instantiation mount, the two reasons a raw coir path won't resolve in press/get). Pass a coir nodePath (e.g. 'main/Canvas/Menu/lower/buttons/layout/ShopBtn'); returns {ref, mount, dropped} for a unique hit, {ambiguous:[refs]} for >1, or null. Feed the returned `ref` straight into press/get/reachable.",
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'a coir static nodePath' } }, required: ['path'] },
    run: async (state, a) => ({ data: resolveCoirPath(a.path, await needCp(state).snapshot({ includeInactive: true })) }),
  },
  {
    name: 'coverage',
    description: "THE coir×copse coverage join, as one call — cross-reference coir's STATIC ClickEvent map against copse's LIVE click surface and bucket every wired button. Pass coir's static rows as `staticRows` ([{nodePath, method, component?}], from coir's `click → method()` edges); copse runs clickSurface() on the connected scene and joins on (nodePath, method) with a symmetric tail match (absorbs coir's scene/prefab-file root + a prefab mount). Returns {covered, blocked, uncertain, unreached, ambiguous, codeRegistered, codeOnly}: covered = wired+live+reachable&interactable (press & assert a state delta); blocked = wired+live but reachable:false/disabled; uncertain = reachable:'unsure'/occluded (verify, NOT a confident pass); unreached = coir-only, not live in this scene (navigate there, re-snapshot); ambiguous = can't attribute 1:1 — `reason:'fan-out'` (one static row tail-matched >1 live button) or `reason:'fan-in'` (one live button claimed by >1 static row, e.g. same-named across scenes), resolve by hand, never silently double-counted; codeRegistered = live, method:null but has a code handler; codeOnly = live, no detectable handler. This is the combined coir+copse capability behind docs/COVERAGE.md, invokable directly. Get coir's rows from coir's MCP/CLI; reachability:false skips the reachable pass.",
    inputSchema: { type: 'object', properties: { staticRows: { type: 'array', description: "coir's static ClickEvent rows: [{nodePath, method, component?}]", items: { type: 'object' } }, reachability: { type: 'boolean', description: 'compute reachable on the live surface (default true)' }, includeInactive: { type: 'boolean', description: 'also walk hidden subtrees when building the live surface' } }, required: ['staticRows'] },
    run: async (state, a) => ({ data: coverageJoin(a.staticRows, await needCp(state).clickSurface({ reachability: a.reachability, includeInactive: a.includeInactive })) }),
  },
  {
    name: 'press',
    record: true,
    description: "Press a button by ref — runs its wired clickEvents + emits CLICK (NOT a coordinate click). Returns {ok, fired, drove, wired?, changed?, errors?}; `drove` = what actuated: ['clickEvent'] (serialized) / ['click'] (a real on('click')) / ['touch'] (a synthetic tap, best-effort) / 'nothing' — so a press that did NOTHING isn't misread as a pass (the harness hard-fails drove:'nothing'); `wired:false` on the ambiguous cases flags a button with no visible handler. `changed` auto-reports what the action did once the tree settles (appeared/disappeared/activated/deactivated/labelChanged as node descriptors, so you can read a panel's contents straight from it). `errors` lists any console-error / uncaught pageerror the handler produced during the press — present even when the engine swallowed the throw and `fired` looks fine, so a crashing handler is NOT a silent pass (the harness hard-fails on it). Honors interactable unless force:true. Set reachableGate:true to ALSO refuse a button a player can't reach (a confident reachable:false → {ok:false, reason:'unreachable', blockedBy}) — the same gate runHarness applies, off by default since press is for driving handler logic regardless of reach.",
    inputSchema: { type: 'object', properties: { ref: { type: 'string', description: 'node ref, e.g. Canvas/Panel/CloseBtn' }, force: { type: 'boolean', description: 'press even if interactable:false' }, reachableGate: { type: 'boolean', description: 'refuse the press if the button is a confident reachable:false (covered/off-screen)' }, captureNetwork: { type: 'boolean', description: 'attach the network requests this press triggered (url/status/payload) — for client-action→server-error bugs' } }, required: ['ref'] },
    run: async (state, a) => { const o = {}; if (a.force) o.force = true; if (a.reachableGate) o.reachableGate = true; if (a.captureNetwork) o.captureNetwork = true; return { data: await needCp(state).press(a.ref, o) }; },
  },
  {
    name: 'get',
    record: true,
    description: 'Read a member for assertions: path:Comp.prop (e.g. Canvas/Score:Label.string), or path:Node.prop for a node intrinsic (e.g. Canvas/Panel:Node.active). Returns {ok, value}.',
    inputSchema: { type: 'object', properties: { sel: { type: 'string', description: 'path:Comp.member selector' } }, required: ['sel'] },
    run: async (state, a) => ({ data: await needCp(state).get(a.sel) }),
  },
  {
    name: 'call',
    record: true,
    description: 'Invoke any method on any component: path:Comp.method(...args) — drives game logic beyond buttons. Returns {ok, value, changed?, errors?} (`errors` = any console-error / uncaught pageerror the method produced — surfaces a swallowed throw the same way press does).',
    inputSchema: { type: 'object', properties: { sel: { type: 'string', description: 'path:Comp.method selector' }, args: { type: 'array', items: {}, description: 'method arguments' } }, required: ['sel'] },
    run: async (state, a) => ({ data: await needCp(state).call(a.sel, ...(a.args || [])) }),
  },
  {
    name: 'eval',
    record: true,
    description: "Evaluate an arbitrary JS expression in the game frame's MAIN WORLD (global scope), WITHOUT pausing the renderer — unlike eval_frame, which needs a breakpoint and freezes the game (collapsing async timing). `cc`, `window`, `window.__copse`, `cc.find(path)` are all in reach, so you can read engine/proxy state, fire REAL input the press tool can't (e.g. cc.find('…/Btn').emit('touch-end') on raw node.on(TOUCH_*) buttons), or drive game logic and watch its async timing play out live. A returned Promise is awaited (so `await`/thenables work). Returns {ok, value} with value coerced to a JSON-safe form (non-serialisable → String()), or {ok:false, error} on a throw. Big hammer — for your OWN dev build; pass an IIFE for multi-statement logic.",
    inputSchema: { type: 'object', properties: { expr: { type: 'string', description: 'a JS expression (or IIFE) evaluated in-page at global scope' } }, required: ['expr'] },
    run: async (state, a) => ({ data: await needCp(state).eval(a.expr) }),
  },
  {
    name: 'reachable',
    record: true,
    description: "Best-effort geometric reachability. Returns {ok, reachable, blockedBy?, occludedBy?, visible}. `reachable` is TRI-STATE: true | false | 'unsure' — 'unsure' (NOT true) when it genuinely can't judge (no UITransform/camera/projection), so uncertainty fails LOUD, not open. `blockedBy` = an input-consumer (overlay / BlockInputEvents) swallowing the touch. `occludedBy` = an opaque sprite drawn OVER the button hiding it VISUALLY while a touch still passes through (reachable:true but a player can't see it). Treat reachable:false / 'unsure' / occludedBy as signals to verify, not gospel — no alpha hit-areas.",
    inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
    run: async (state, a) => ({ data: await needCp(state).reachable(a.ref) }),
  },
  {
    name: 'node',
    record: true,
    description: 'Node intrinsics for visibility checks: {active, activeInHierarchy, opacity, scale, worldPos, size}.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
    run: async (state, a) => ({ data: await needCp(state).node(a.ref) }),
  },
  {
    name: 'diff',
    description: 'Diff two snapshots (before vs after an action) → {appeared, disappeared, activated, deactivated, labelChanged} as node descriptors. `press`/`call` already attach this as `changed`; use this tool for manual before→act→after comparisons, e.g. snapshot({includeInactive:true}) → act → snapshot → diff to see which panel subtree opened.',
    inputSchema: { type: 'object', properties: { before: { type: 'array', items: {}, description: 'an earlier snapshot() result' }, after: { type: 'array', items: {}, description: 'a later snapshot() result' } }, required: ['before', 'after'] },
    run: async (state, a) => ({ data: await needCp(state).diff(a.before, a.after) }),
  },
  {
    name: 'listeners',
    description: 'User code-registered node.on() handlers on a node (engine-internal events + the Button\'s own touch listeners filtered out): [{type, fn?, target?}]. Surfaces on(\'click\')/on(TOUCH_*) wiring that `press` fires. Minified builds strip fn/target names (you get identity, not semantics).',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
    run: async (state, a) => ({ data: await needCp(state).listeners(a.ref) }),
  },
  {
    name: 'probe',
    description: "Engine-coupling self-diagnostic — run it once on an unfamiliar build to see whether copse's version-sensitive internals resolve on THIS Cocos version, instead of finding out via a silent 'unsure'. Read-only (walks + reads, patches nothing → non-invasive). Returns {version, classes:{Node/Button/UITransform/Camera/EventTouch/…present?}, reach:{batcher2D, getFirstRenderCamera, cameraPriority}, events:{eventProcessor, shouldHandleEventTouch, capturingKey, tableKey, infosKey}, touch:{EventTouch, Touch, NodeEventType}}. Anything 'absent'/'unknown'/'error' is a tier that will fall back (or fail loud) here — e.g. getFirstRenderCamera:false → reachable uses the camOf heuristic (via.camera:'heuristic'); events.tableNote:'no-registered-listener-found' just means no node had wired a listener yet (open a scene with buttons and re-probe). The event key names (tableKey:'_callbackTable', infosKey:'callbackInfos' on 3.8.x) are the arms of copse's internal `||` ladders that actually matched — a shift there is exactly the drift this surfaces.",
    inputSchema: { type: 'object', properties: {} },
    run: async (state) => ({ data: await needCp(state).probe() }),
  },
  {
    name: 'logs',
    description: "Recent console output + uncaught errors captured from the game (all frames): [{level, text, t, stack?}] (level is the console method / 'pageerror'). SERVER-SIDE filtered so a chatty game's output never blows the token budget: `grep` (case-insensitive regex over the text, e.g. '\\\\[StartCommand\\\\]|500'), `level` ('error'|'warn'|'log'|…), `tail` (keep only the last N), `since` (an index — pass the count you've already seen). Combine them (since → level → grep → tail).",
    inputSchema: { type: 'object', properties: { grep: { type: 'string', description: 'case-insensitive regex over the log text' }, level: { type: 'string', description: "keep only this console level ('error'|'warn'|'log'|'info'|'debug'|'pageerror')" }, tail: { type: 'number', description: 'keep only the last N matching lines' }, since: { type: 'number', description: 'return logs from this index onward (default 0 = all)' } } },
    run: async (state, a) => ({ data: await needCp(state).logs(a || {}) }),
  },
  {
    name: 'watch',
    description: "Record a diff-only TIMELINE of game state over time — the state-machine observation primitive (replaces hand-written polling loops). Samples `exprs` (in-page JS expressions read in the game frame, e.g. 'gdp.active') and/or `selectors` (path:Comp.prop, read via get) every `interval` (default '1s'), recording ONLY changed keys with relative timestamps {t, dt} (so you can answer 'hit → bigwin, how many seconds?'). Stops when `until` (an in-page boolean expr, e.g. 'gdp.active===false') is true or `timeout` (default '40s') elapses; after `until` it keeps recording for `settle` (e.g. '2s') to catch the tail. Returns {timeline:[{t, dt, changes}], stoppedBy:'until'|'timeout', elapsed, samples}. Durations accept '1s'/'500ms'/a number(ms). The whole poll loop runs in ONE in-page call.",
    inputSchema: { type: 'object', properties: { exprs: { type: 'array', items: { type: 'string' }, description: 'in-page JS expressions to sample' }, selectors: { type: 'array', items: { type: 'string' }, description: 'path:Comp.prop selectors to sample via get' }, interval: { type: 'string', description: "sample interval (default '1s')" }, until: { type: 'string', description: 'stop when this in-page boolean expression is true' }, timeout: { type: 'string', description: "hard stop (default '40s')" }, settle: { type: 'string', description: "after `until`, keep recording this long to catch the tail" } } },
    run: async (state, a) => ({ data: await needCp(state).watch(a) }),
  },
  {
    name: 'patch',
    description: "Wrap a live component method to verify a fix WITHOUT rebuilding — the 'try the fix on the running game first' primitive. sel = path:Comp.method (e.g. Canvas/Mgr:PanelCtrl.setRoundInfo). `before`/`after`/`replace` are JS FUNCTION-EXPRESSION source strings; copse compiles them, finds the real method, binds `this`, and wraps the hooks in try/catch (a throwing hook can't break the original call), restorably. `before(args, self)` runs first — return an ARRAY to replace the args; `replace(args, self)` runs INSTEAD of the original (its return becomes the result); `after(args, ret, self)` runs last — return non-undefined to replace the result. Example fix-probe: before=\"(a,self)=>{ self.mode = self.off; }\". Returns {ok, method, hooks}. Undo with patch_clear.",
    inputSchema: { type: 'object', properties: { sel: { type: 'string', description: 'path:Comp.method selector' }, before: { type: 'string', description: 'JS fn-expr (args, self) => …  (return an array to replace args)' }, after: { type: 'string', description: 'JS fn-expr (args, ret, self) => …  (return non-undefined to replace the result)' }, replace: { type: 'string', description: 'JS fn-expr (args, self) => …  runs INSTEAD of the original' } }, required: ['sel'] },
    run: async (state, a) => ({ data: await needCp(state).patch(a.sel, { before: a.before, after: a.after, replace: a.replace }) }),
  },
  {
    name: 'patch_clear',
    description: 'Undo `patch`: restore the original method (all patches if no sel). Returns {ok, cleared:[sels], hookErrors?} — hookErrors surfaces any exception your before/after hooks threw while the patch was active (so a silently-swallowed hook bug is still visible).',
    inputSchema: { type: 'object', properties: { sel: { type: 'string', description: 'the same path:Comp.method you patched (omit to clear all)' } } },
    run: async (state, a) => ({ data: await needCp(state).patchClear(a.sel) }),
  },
  {
    name: 'framework',
    description: "Detect the game's app framework and enumerate its state registry: {kind, proxies:[names], mediators:[names], commands:[names], registered}. copse core ships NO framework knowledge — this reports whatever ADAPTER is registered this session (auto-loaded from copse.frameworks.mjs, or added via register_framework / connect({frameworks})). kind:'none' + registered:0 = no adapter installed; kind:'none' + registered>0 = an adapter is loaded but didn't match this build (widen its facade candidates). PureMVC etc. keep LOGIC state OUTSIDE the cc node tree, which get/call can't reach — use pm_state/pm_call for those.",
    inputSchema: { type: 'object', properties: {} },
    run: async (state) => ({ data: await needCp(state).framework() }),
  },
  {
    name: 'register_framework',
    description: "Install a framework adapter for THIS session so framework/pm_state/pm_call can reach app-layer state (core ships none). `adapter` is a CONFIG object {kind, facade:[…locations], proxy:{via?,map?}, mediator:{via?,map?}, command:{map?}} — `facade` lists candidate window paths ('puremvc.Facade.instance', or 'a.b.*' to expand a map), `via` a retrieve method name, `map` registry-map path candidates — OR a code-adapter SOURCE string \"({detect,proxies,mediators,commands,retrieve})\" for a framework the config can't express. De-duped by `kind`. Persist it in copse.frameworks.mjs (auto-loaded on connect); use this to add/adjust one on the fly. Returns {ok, kind, registered}.",
    inputSchema: { type: 'object', properties: { adapter: { description: 'a config object, or a code-adapter source string' } }, required: ['adapter'] },
    run: async (state, a) => ({ data: await needCp(state).registerFramework(a.adapter) }),
  },
  {
    name: 'pm_state',
    description: "Read (or write) a PureMVC proxy/mediator's state — the logic state OUTSIDE the cc node tree that get/call can't reach. sel = 'Name.prop.subprop' (e.g. 'GameDataProxy.active' or 'GameDataProxy.sessionData.remaining'); Name is resolved via retrieveProxy then retrieveMediator. Pass `value` to WRITE the leaf (e.g. set 'GameDataProxy.mode'); omit it to READ. Returns {ok, value} or {ok, wrote}. Run `framework` first to see the names.",
    inputSchema: { type: 'object', properties: { sel: { type: 'string', description: "'ProxyOrMediatorName.prop.subprop'" }, value: { description: 'when present, WRITE this value to the leaf (any JSON value)' } }, required: ['sel'] },
    run: async (state, a) => ({ data: await needCp(state).pmState(a.sel, Object.prototype.hasOwnProperty.call(a, 'value'), a.value) }),
  },
  {
    name: 'pm_call',
    description: "Call a method on a PureMVC proxy/mediator: sel = 'Name.method' (e.g. 'PanelMediator.toggle'), args = the arguments. Drives app-layer logic that isn't a cc component method. Returns {ok, value}.",
    inputSchema: { type: 'object', properties: { sel: { type: 'string', description: "'ProxyOrMediatorName.method'" }, args: { type: 'array', items: {}, description: 'method arguments' } }, required: ['sel'] },
    run: async (state, a) => ({ data: await needCp(state).pmCall(a.sel, ...(a.args || [])) }),
  },
  {
    name: 'network',
    description: "Recent network requests captured from the game (all frames), SERVER-SIDE filtered: [{t, method, url, status, type, payload?}]. Purpose-built for 'client action → server error code' bugs (e.g. a action request that came back 500): press with captureNetwork:true, or call this after an action. Filters: `grep` (regex over url), `status` (e.g. 200 or 'failed'), `type` ('xhr'|'fetch'|…), `tail` (last N), `since` (index). xhr/fetch rows include a truncated request `payload`.",
    inputSchema: { type: 'object', properties: { grep: { type: 'string', description: 'case-insensitive regex over the request url' }, status: { description: "keep only this HTTP status (a number, or 'failed')" }, type: { type: 'string', description: "keep only this resourceType ('xhr'|'fetch'|'document'|…)" }, tail: { type: 'number', description: 'keep only the last N matching requests' }, since: { type: 'number', description: 'return requests from this index onward' } } },
    run: async (state, a) => ({ data: await needCp(state).network(a || {}) }),
  },
  {
    name: 'screenshot',
    description: "Capture the game canvas as a PNG — logic tools are pixel-blind, so this pairs a logic state with what's ACTUALLY on screen (e.g. a button that's 30px off, which no state read can catch). `selector` best-effort clips to a node's screen rect (falls back to the full frame if it can't project). `path` writes the PNG to disk and returns {ok, path}; omit `path` to return the image INLINE (the model sees it). Works in attach mode (your real browser) and the headless GPU launch.",
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'node ref to clip to (best-effort)' }, path: { type: 'string', description: 'write the PNG here instead of returning it inline' } } },
    run: async (state, a) => { const r = await needCp(state).screenshot(a); return r && r.base64 ? { image: { data: r.base64, mimeType: r.mimeType } } : { data: r }; },
  },
  {
    name: 'visual_check',
    description: "Node-anchored VISUAL check — the PIXEL complement to the logic tree (copse otherwise reads the node tree, never pixels). Screenshots JUST this node's screen rect (dynamic children — labels/particles/spine — masked so they don't trip it) and returns a three-state verdict {drawn, matches, clear, score?, visible, via, reason?} in the SAME grammar as reachable (true|false|'unknown' + a `via` provenance tag): drawn = is anything actually rendered at the rect (catches the 'tree says active, screen is blank' case reachable/snapshot can't); with a golden `baseline` signature (from visual_baseline) matches = it looks like the golden and clear = the node's OWN art is what's visible — which is how you close reachable's headline blind spot (a button covered by an opaque sprite with no input-consumer reads reachable:true but clear:false). via becomes 'pixel-confirmed' once a baseline is used; with no baseline matches/clear are 'unknown' (drawn still answers). Needs a screenshot-capable session (connect first).",
    inputSchema: { type: 'object', properties: { ref: { type: 'string', description: 'node ref' }, baseline: { type: 'array', items: { type: 'number' }, description: "a golden signature for THIS ref (from visual_baseline) to compare against" } }, required: ['ref'] },
    run: async (state, a) => { const o = {}; if (a.baseline) o.baseline = a.baseline; return { data: await needCp(state).visualCheck(a.ref, o) }; },
  },
  {
    name: 'visual_baseline',
    description: "Capture a golden per-node visual baseline on the CURRENT (known-good) screen — signs every interactive node (or the passed `refs`) and returns { ref: signature[] }. Feed an entry back as visual_check's `baseline` on a later run/build to detect a node that stopped rendering, got occluded, or changed art. Per-node (NOT a full-frame screenshot) baselines survive animation/RNG because each node's dynamic descendants are masked out. Needs an open session.",
    inputSchema: { type: 'object', properties: { refs: { type: 'array', items: { type: 'string' }, description: 'refs to baseline (default: every interactive node)' } } },
    run: async (state, a) => ({ data: await needCp(state).captureBaseline(a.refs ? { refs: a.refs } : {}) }),
  },
  {
    name: 'reachable_visual',
    description: "The headline COMBINE: touch-reachability (logic z-order) ∧ the pixel pass → \"can a player actually SEE and USE this\". Returns {ref, usable, reachable, visual}; `usable` is three-state — reachable+visible+clear → true, any hard-negative → false, reachable+visible+drawn but no baseline to confirm the art → 'unknown'. This is what turns reachable's opaque-sprite-occlusion caveat (reachable:true but visually covered) into a real answer. Pass a `baseline` (from visual_baseline) to reach a confident true. Needs an open session.",
    inputSchema: { type: 'object', properties: { ref: { type: 'string' }, baseline: { type: 'array', items: { type: 'number' }, description: "golden signature for this ref (from visual_baseline)" } }, required: ['ref'] },
    run: async (state, a) => ({ data: await needCp(state).reachableVisual(a.ref, a.baseline ? { baseline: a.baseline } : {}) }),
  },
  {
    name: 'break_at',
    debug: true,
    description: 'DEBUG (CDP Debugger — for your OWN dev build; pausing the runtime is intrusive). Set a breakpoint by script URL + line. urlRegex matches the script URL (e.g. "ShopController" or "game\\\\.js$"); line/col are 0-based. Optional condition (a JS expr). Then trigger it and call wait_pause.',
    inputSchema: { type: 'object', properties: { urlRegex: { type: 'string', description: 'regex matched against the script URL' }, line: { type: 'number', description: '0-based line number' }, col: { type: 'number', description: '0-based column (optional)' }, condition: { type: 'string', description: 'pause only if this JS expr is truthy (optional)' } }, required: ['urlRegex', 'line'] },
    run: async (state, a) => ({ data: await (await ensureDbg(state)).breakAt(a.urlRegex, a.line, a.col, a.condition) }),
  },
  {
    name: 'break_in',
    debug: true,
    description: 'DEBUG. Break when a Cocos component method is CALLED, addressed by copse selector path:Comp.method (e.g. Canvas/Mgr:ShopController.buy) — resolved to the actual function, so it works on minified builds. Breaks the METHOD (every instance); pass condition like "this===…" or check `this` via eval_frame to narrow. Then trigger it and call wait_pause.',
    inputSchema: { type: 'object', properties: { sel: { type: 'string', description: 'path:Comp.method selector' }, condition: { type: 'string', description: 'pause only if this JS expr is truthy (optional)' } }, required: ['sel'] },
    run: async (state, a) => ({ data: await (await ensureDbg(state)).breakIn(a.sel, a.condition) }),
  },
  {
    name: 'break_exceptions',
    debug: true,
    description: 'DEBUG. Pause on thrown exceptions: state "all" | "uncaught" | "none". Then run the game and call wait_pause to catch the throwing stack.',
    inputSchema: { type: 'object', properties: { state: { type: 'string', enum: ['all', 'uncaught', 'none'] } }, required: ['state'] },
    run: async (state, a) => ({ data: await (await ensureDbg(state)).breakOnExceptions(a.state) }),
  },
  {
    name: 'wait_pause',
    debug: true,
    description: 'DEBUG. Block until a breakpoint/exception hits, then return the call stack: {reason, frames:[{i, fn, url, line, col, scopes}]}. Returns null on timeout (default 30s). While paused the game is frozen — inspect with eval_frame, then step/resume.',
    inputSchema: { type: 'object', properties: { timeoutMs: { type: 'number', description: 'how long to wait (default 30000)' } } },
    run: async (state, a) => ({ data: await (await ensureDbg(state)).waitPause(a.timeoutMs ?? 30000) }),
  },
  {
    name: 'eval_frame',
    debug: true,
    description: 'DEBUG (must be paused). Evaluate an expression in a paused call frame to read locals / `this` / arguments. frame is the index from wait_pause (0 = top). Returns {value} or {error}.',
    inputSchema: { type: 'object', properties: { frame: { type: 'number', description: 'frame index (0 = innermost)' }, expr: { type: 'string', description: 'JS expression, e.g. this.balance' } }, required: ['frame', 'expr'] },
    run: async (state, a) => ({ data: await (await ensureDbg(state)).evalFrame(a.frame, a.expr) }),
  },
  {
    name: 'debug_step',
    debug: true,
    description: 'DEBUG (must be paused). Step execution: kind "over" | "into" | "out" | "resume". After stepping, call wait_pause again for the new stack.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['over', 'into', 'out', 'resume'] } }, required: ['kind'] },
    run: async (state, a) => ({ data: a.kind === 'resume' ? await (await ensureDbg(state)).resume() : await (await ensureDbg(state)).step(a.kind) }),
  },
  {
    name: 'clear_breakpoints',
    debug: true,
    description: 'DEBUG. Remove all breakpoints set this session (resume the game separately if it is paused).',
    inputSchema: { type: 'object', properties: {} },
    run: async (state) => ({ data: await (await ensureDbg(state)).clear() }),
  },
  {
    name: 'run_script',
    description: 'Replay a FROZEN test script deterministically (no LLM) against the connected game — the regression half of the test loop (docs/SCRIPTS.md). `script` = {name?, continueOnFail?, steps:[…]}; each step is the harness Step shape {op, ref?/sel?/args?/opts?/expr?/note?} plus `expect` (subset match: primitives ===, objects by key, arrays CONTAINS) and `allowErrors`; {op:"sleep", ms} waits. A step with no expect passes on ok!==false; fact gates mirror runHarness: result.errors fails the step (unless allowErrors / an explicit errors expect) and a press with drove:"nothing" fails (unless an explicit drove expect). Default stops at the first failed step (continueOnFail:true runs all). Returns {pass, name?, failedAt?, steps:[{step, ok, ms, mismatch?, result?, gate?}]} — failing steps carry the full result.',
    inputSchema: { type: 'object', properties: { script: { type: 'object', description: 'the script: {name?, continueOnFail?, steps:[{op, ref?/sel?/args?/opts?, expect?, allowErrors?}, …]}' } }, required: ['script'] },
    run: async (state, a) => ({ data: await runScript(needCp(state), a.script) }),
  },
  {
    name: 'dump_script',
    description: "Export this session's recording as a script skeleton: every press/get/call/node/reachable/eval/snapshot/interactive call made since connect, in order, each as a ready script step plus `observed` (its actual result, truncated; connect/reload/close are transport — not recorded). To freeze a flow: drop the exploratory-noise steps, trim each observed into a MINIMAL `expect` (subset match — usually 1-2 keys; do NOT paste observed wholesale, full-result goldens are brittle), remove the observed fields, save as JSON, then replay with run_script / `copse run`. reset:true clears the recording for the next flow (a new connect also clears).",
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'script name to stamp on the export' }, reset: { type: 'boolean', description: 'clear the recording after exporting' } } },
    run: async (state, a) => {
      const steps = (state.history || []).slice();
      if (a.reset) state.history = [];
      return { data: { name: a.name || 'recorded-session', steps } };
    },
  },
  {
    name: 'close',
    description: 'Close the browser session opened by `connect` (also detaches the debugger).',
    inputSchema: { type: 'object', properties: {} },
    run: async (state) => {
      if (state.dbg) { try { await state.dbg.detach(); } catch { /* ignore */ } state.dbg = null; }
      if (state.cp) { await state.cp.close(); state.cp = null; }
      return { data: { ok: true } };
    },
  },
];

// Wrap the record-tagged tools so every successful call lands in state.history as a
// replayable step + observed — regardless of dispatch path (server or tests). Done here
// (not in the server dispatcher) so recording is a registry concern, transport-agnostic.
for (const t of TOOLS) {
  if (!t.record) continue;
  const orig = t.run;
  t.run = async (state, args) => {
    const res = await orig(state, args);
    if (res && !res.error) {
      const step = toStep(t.name, args);
      if (step) (state.history || (state.history = [])).push({ ...step, observed: truncate(res.data) });
    }
    return res;
  };
}

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
