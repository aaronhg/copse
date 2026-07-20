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

import { resolveCoirPath } from '../coverage.js';
import { runScript, truncate } from '../script.js';

const needCp = (state) => {
  if (!state.cp) throw new Error('no open game — call the `connect` tool with a url first');
  return state.cp;
};

// A schema `type` for a slot that carries ANY JSON value. A TYPELESS slot lets the client coerce a
// scalar to a STRING as it crosses to the tool (a boolean `true` arrived as "true", a number 30 as "30")
// — the explicit union tells the client to send the real JSON type. Used for pm_set's value, method
// args, and notification bodies. (Nested-in-an-object args — e.g. run_script's opaque `script` — dodge this,
// which is why the same write worked there; declaring the type fixes the direct path too.)
const JSON_VALUE = ['string', 'number', 'boolean', 'object', 'array', 'null'];

// ---- family taxonomy: signposting, NOT gating -------------------------------------------------
// Every tool belongs to one FAMILY (a task you'd want to do); one tool per family is the ★ HEADLINE
// ("reach for this first; the rest of the family are variants / lower-level"). server.js prefixes each
// advertised description with `[family ★]` / `[family]` and groups tools/list by family, so an agent
// scanning the surface gets a guided map instead of a flat 34-tool list. NOTHING is hidden (the debug
// family is gated separately by `--debug`) — this only labels + orders.
export const FAMILY_ORDER = ['session', 'see', 'read', 'drive', 'usable', 'observe', 'fix', 'coverage', 'script', 'orient', 'escape', 'debug'];
export const FAMILY = {
  connect: 'session', list_tabs: 'session', reload: 'session', close: 'session',
  snapshot: 'see', interactive: 'see', diff: 'see', listeners: 'see',
  get: 'read', node: 'read', pm_get: 'read',
  press: 'drive', call: 'drive', pm_set: 'drive', pm_call: 'drive', pm_notify: 'drive',
  reachable: 'usable', visual_check: 'usable', visual_baseline: 'usable',
  watch: 'observe', logs: 'observe', network: 'observe', screenshot: 'observe', hold: 'observe', release: 'observe', hold_status: 'observe',
  patch: 'fix', patch_clear: 'fix', patch_calls: 'fix', pm_patch: 'fix', pm_trace: 'fix',
  click_surface: 'coverage', resolve: 'coverage',
  run_script: 'script', dump_script: 'script',
  orient: 'orient', anchors: 'orient', doctor: 'orient', framework: 'orient', register_framework: 'orient',
  eval: 'escape', // its own family: the raw escape hatch, NOT a peer of press/call — no ★ (never reach for it first)
  break_at: 'debug', break_in: 'debug', break_exceptions: 'debug', wait_pause: 'debug', eval_frame: 'debug', debug_step: 'debug', clear_breakpoints: 'debug',
};
// one ★ headline per family (the go-to); the `escape` family deliberately has NONE (eval is a last resort).
export const HEADLINE = new Set(['connect', 'snapshot', 'get', 'press', 'reachable', 'watch', 'patch', 'click_surface', 'run_script', 'orient', 'break_in']);
export const familyTag = (name) => { const f = FAMILY[name]; return f ? `[${f}${HEADLINE.has(name) ? ' ★' : ''}] ` : ''; };

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
    case 'reachable': return { op: 'reachable', ref: a.ref, ...((a.visual || a.baseline) ? { opts: { ...(a.visual ? { visual: true } : {}), ...(a.baseline ? { baseline: a.baseline } : {}) } } : {}) };
    // timeout rides along: a step recorded at '3m' that replays at the 60s default is not the session it froze
    case 'eval': return { op: 'eval', expr: a.expr, ...(a.timeout ? { timeout: a.timeout } : {}) };
    // framework-aware + patch ops freeze into replayable steps so a PureMVC flow (register → read/write
    // proxy state → call a mediator → patch a method) can be dumped and re-run by script.js/run_script.
    case 'pm_get': return { op: 'pmGet', sel: a.sel };
    case 'pm_set': return { op: 'pmSet', sel: a.sel, value: a.value };
    case 'pm_call': return { op: 'pmCall', sel: a.sel, ...(a.args && a.args.length ? { args: a.args } : {}) };
    case 'pm_patch': { const h = {}; for (const k of ['before', 'after', 'replace', 'trace']) if (a[k] !== undefined) h[k] = a[k]; return { op: 'pmPatch', sel: a.sel, ...(Object.keys(h).length ? { hooks: h } : {}) }; }
    case 'pm_notify': return { op: 'pmNotify', name: a.name, ...(a.body !== undefined ? { body: a.body } : {}), ...(a.type !== undefined ? { type: a.type } : {}) };
    case 'framework': return { op: 'framework' };
    case 'register_framework': return { op: 'registerFramework', adapter: a.adapter };
    case 'patch': { const h = {}; for (const k of ['before', 'after', 'replace', 'trace']) if (a[k] !== undefined) h[k] = a[k]; return { op: 'patch', sel: a.sel, ...(Object.keys(h).length ? { hooks: h } : {}) }; }
    case 'patch_clear': return { op: 'patchClear', ...(a.sel ? { sel: a.sel } : {}) };
    case 'snapshot': {
      const o = {}; for (const k of ['relevant', 'includeInactive', 'components']) if (a[k] !== undefined) o[k] = a[k];
      return { op: 'snapshot', ...(Object.keys(o).length ? { opts: o } : {}) };
    }
    case 'interactive': return { op: 'interactive' };
    default: return null;
  }
};

// `truncate` (shared with script.js — it caps a captured/observed result so a whole-scene snapshot
// doesn't bloat the recording) is imported above; dump's `observed` and run_script's `capture` use one copy.

// Lazily attach the CDP Debugger over the live session (state.dbg). Tests can pre-seed state.dbg.
const ensureDbg = async (state) => {
  if (!state.dbg) {
    const cp = needCp(state);
    const { attachDebugger } = await import('../debug.js');
    state.dbg = await attachDebugger(cp.page);
  }
  return state.dbg;
};

// recoverable/code: the driver's machine-readable error class, carried through to the text an agent reads
// (server.js tags it ahead of the prose) — see the `err` helper in drivers/puppeteer.js.
/** @type {{name:string,description:string,inputSchema:any,debug?:boolean,record?:boolean,run:(state:any,args:any)=>Promise<{data?:any,error?:string,image?:any,recoverable?:boolean,code?:string}>}[]} */
export const TOOLS = [
  {
    name: 'connect',
    description: 'Launch a browser at <url> (or ATTACH to an already-open tab), load a running canvas game, inject copse, wait until ready. `engine` picks the layer: "cocos" (default) or "pixi" (PixiJS 8) — on pixi, clickSurface/coverage are unavailable (nothing is serialized) and `anchors` replaces them as the way to see what is addressable. Call this FIRST (same operation as the library connect()). headed:true shows a window; browserURL points at your own Chrome (started with --remote-debugging-port). attach:true + match drives an ALREADY-OPEN tab without navigating — use this for your own game behind a login/staging gate you opened yourself; omit match AND url to attach the ACTIVE tab (e.g. one chrome-devtools-mcp brought to front). Returns a readiness summary.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'the running game URL (omit when attach:true — use match instead)' },
        headed: { type: 'boolean', description: 'show a visible browser window (default: headless)' },
        fps: { type: 'number', description: 'frame-rate cap (default 10; raise to watch smoothly)' },
        browserURL: { type: 'string', description: 'CDP URL of an existing Chrome (e.g. http://127.0.0.1:9222) — required for attach' },
        attach: { type: 'boolean', description: 'drive an already-open tab (no navigation) instead of opening a new one' },
        match: { description: 'when attach:true, pick the open tab to drive: a URL substring, a LIST of substrings (ALL must be present — ANDed, to tell apart two builds sharing a fragment), or {url?,title?} (title is matchable too). >1 tab matches → an error listing them (use `list_tabs` first, or `pick`). Omit match AND url → the ACTIVE tab.' },
        pick: { type: 'number', description: 'when several tabs match, attach to this index (from the ambiguity list / list_tabs) instead of erroring' },
        frameworks: { type: 'array', items: {}, description: 'extra framework adapters (config objects / code-adapter source strings / file paths) on top of the auto-loaded copse.frameworks.mjs — enables framework/pm_get/pm_set/pm_call' },
        engine: { type: 'string', enum: ['cocos', 'pixi'], description: 'which engine layer to drive (default cocos). "pixi" = PixiJS 8: the bundle is injected pre-boot to catch Pixi\'s one-shot init hook, so it must be set at connect time — you cannot switch later without reconnecting.' },
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
      if (a.attach) { opts.attach = true; opts.match = a.match || a.url; if (a.pick != null) opts.pick = a.pick; }
      if (a.frameworks) opts.frameworks = a.frameworks;
      if (a.engine) opts.engine = a.engine;
      const target = a.url || opts.match || '';
      state.cp = await connect(target, opts);
      // Report the URL of the tab actually attached (page.url() is CDP-cached, safe even while paused);
      // fall back to the target/match string only if that read fails (it was reporting the match substring).
      const at = () => { try { return state.cp.page.url() || target; } catch { return target; } };
      // paused = the renderer is HALTED in the debugger → copse inject is deferred (it'd hang). Debugger
      // tools work immediately.
      // "run after you resume" was implemented by ev()'s bare `await ready`, which queued every call until
      // init finished. That wait is gone (unbounded, it turned a halted renderer into a silent 32-min hang),
      // so calls now FAIL FAST while paused instead of queueing. Say that: an agent that believes the old
      // note sits waiting for a result that will never arrive.
      if (state.cp.paused) return { data: { ok: true, url: at(), attached: true, paused: true, note: 'renderer HALTED (debugger) — inject deferred. Use wait_pause/eval_frame/break_at now. snapshot/press/break_in do NOT queue: until you resume they fail fast with [recoverable] init-pending — resume, then call them again.' } };
      // stalled = init didn't finish in time (bundle/__copse install still queued, or the engine has no
      // scene up yet), NOT a debugger pause. This no longer fires merely because a screen has no buttons.
      if (state.cp.stalled) return { data: { ok: true, url: at(), attached: true, injecting: true, note: 'inject did not finish in time — __copse may not be installed yet, or the engine has no scene up. Call orient/snapshot again in a moment, or reload.' } };
      // A page with no engine leaves __copse uninstalled, so these reads throw by design. That's the
      // FINDING, not a failure of connect — report it (and point at doctor) instead of surfacing a
      // raw error, which is what a caller sees when the thing they attached to isn't a game at all.
      if (!state.cp.installed) {
        return { data: {
          ok: false, url: at(), attached: !!opts.attach, installed: false,
          engine: state.cp.engineDetected ? state.cp.engine : null,
          note: 'copse could not install: no engine was found on this page. Looked for a live cc.director scene and a Pixi Application (init hook / __PIXI_APP__ / devtools globals). If this is a Pixi game you ATTACHED to after load, reconnect with engine:"pixi" so the pre-boot hook can arm; if it is a release Cocos build, `cc` may be tree-shaken away. Call `doctor` for the full report.',
        } };
      }
      const snap = await state.cp.snapshot({ relevant: true });
      const inter = await state.cp.interactive();
      return { data: { ok: true, url: at(), attached: !!opts.attach, engine: typeof state.cp.engineReady === 'function' ? await state.cp.engineReady() : (state.cp.engine ?? null), ...(state.cp.attachedTab ? { attachedTab: state.cp.attachedTab } : {}), relevantNodes: snap.length, buttons: inter.length } };
    },
  },
  {
    name: 'list_tabs',
    description: "List the open tabs in a running Chrome (started with --remote-debugging-port) WITHOUT attaching — [{index,url,title,active}]. Use it BEFORE connect to see which tab to attach when several look alike (e.g. two game builds sharing a url fragment): read the titles, then connect with attach:true + a fuller `match` (a list ANDs; title matches too) or `pick:<index>`. No session needed — it connects, lists, disconnects. `active` = visible + focused.",
    inputSchema: { type: 'object', properties: { browserURL: { type: 'string', description: 'CDP URL of the Chrome to inspect (e.g. http://127.0.0.1:9222)' } }, required: ['browserURL'] },
    run: async (state, a) => { const { browseTabs } = await import('../drivers/puppeteer.js'); return { data: { tabs: await browseTabs({ browserURL: a.browserURL }) } }; },
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
    description: "Join-ready RUNTIME click surface (the copse side of the coir cross-reference): one row per editor-wired clickEvent [{ref, method, component?, interactable, reachable?(true|false|'unsure'), blockedBy?, visible?}]. `method` joins 1:1 to coir's static ClickEvent map, so you can compare what's WIRED (coir, every scene) against what's LIVE & pressable now (copse). Touch-/code-wired buttons get method:null (+ `codeHandlers` when present, so the join can tell codeRegistered from codeOnly). reachability:false skips the O(buttons×nodes) reachable pass.",
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
    name: 'anchors',
    description: "Which objects in the live scene were written by the GAME (not the engine), and what is callable on each — detected STRUCTURALLY (owns methods the engine doesn't define, and/or holds children by name), with `tier` reporting the confidence: lifecycle > api > refs. Minify-proof: method and field names survive what mangles class names. ON PIXI this is the addressing ENTRY POINT — refs there are positional gibberish (`Container[0]/Container[3]`), so start here, not with snapshot, and feed a `named` path back as `<ref>:Node.<path>` to get/call/patch. ON COCOS refs are already readable, so its value is the RELEASE build: it names the callable methods of a script component whose class name has been mangled to `e`/`t` (use the returned `sel`). Tree order, shallowest first. `named` is capped (25) with `namedTotal` reported — never silently truncated.",
    inputSchema: { type: 'object', properties: {} },
    run: async (state) => ({ data: await needCp(state).anchors() }),
  },
  {
    name: 'press',
    record: true,
    description: "Press a button by ref — runs its wired clickEvents + emits CLICK (NOT a coordinate click). Returns {ok, fired, drove, wired?, changed?, errors?}. `drove` = what actuated: ['clickEvent']/['click']/['touch'] (synthetic tap, best-effort) / 'nothing' — so a no-op press isn't misread as a pass; `wired:false` flags a button with no handler. `changed` = what the action did after the tree settles (appeared/disappeared/activated/deactivated/labelChanged descriptors — read a panel's contents straight off it). `errors` = any console-error/uncaught throw during the press, even if the engine swallowed it (a crashing handler is never a silent pass). Honors interactable unless force:true. reachableGate:true also refuses a confident reachable:false button ({ok:false, reason:'unreachable', blockedBy}). captureNetwork:true attaches the requests it fired.",
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
    inputSchema: { type: 'object', properties: { sel: { type: 'string', description: 'path:Comp.method selector' }, args: { type: 'array', items: { type: JSON_VALUE }, description: 'method arguments (each keeps its JSON type — see JSON_VALUE)' } }, required: ['sel'] },
    run: async (state, a) => ({ data: await needCp(state).call(a.sel, ...(a.args || [])) }),
  },
  {
    name: 'eval',
    record: true,
    description: "ESCAPE HATCH — arbitrary JS in the game frame's main world (no pause). LAST RESORT: prefer the curated tools (they carry the guardrails — reachable/drove/errors gates, structured output — that raw eval bypasses); reach here only when nothing else fits. `cc`, `window`, `window.__copse`, `cc.find(path)` in reach: read engine/proxy state, fire input press can't (e.g. cc.find('…/Btn').emit('touch-end')), or drive logic and watch async timing live. For framework state use the in-page `__copse.pm` namespace (NOT the snake_case tool names — `__copse.pm_get` is not a function): `__copse.pm.get('GameDataProxy.active')` / `pm.set` / `pm.call` / `pm.notify`, and `pm.proxy('GameDataProxy')`/`pm.mediator('XxxViewMediator')` for the RAW live object to poke. `await`/thenables work (a returned Promise is awaited). Returns {ok, value} (coerced JSON-safe) or {ok:false, error}. Pass an IIFE for multi-statement logic.",
    inputSchema: { type: 'object', properties: { expr: { type: 'string', description: 'a JS expression (or IIFE) evaluated in-page at global scope' }, timeout: { type: 'string', description: "how long to allow before failing loud (default '60s'). Raise it for a deliberately long await/poll; it exists so a wedged renderer can't hang the call forever." } }, required: ['expr'] },
    run: async (state, a) => ({ data: await needCp(state).eval(a.expr, a.timeout ? { timeout: a.timeout } : {}) }),
  },
  {
    name: 'reachable',
    record: true,
    description: "Can a player reach/use this node — THE 'usable' headline. Default (cheap): geometric TOUCH reachability → {ok, reachable, blockedBy?, occludedBy?, visible}. `reachable` is TRI-STATE: true | false | 'unsure' (NOT true when it genuinely can't judge — fails LOUD, not open). `blockedBy` = an input-consumer (overlay/BlockInputEvents) swallowing the touch; `occludedBy` = an opaque sprite drawn OVER it (touch passes but a player can't SEE it). `visual:true` ALSO runs the pixel pass and returns the full combine: a three-state `usable` (reach ∧ on-screen) + a `visual` block — pass a `baseline` (from visual_baseline) to confirm the node's OWN art, not just 'something drawn'. Treat false/'unsure'/occludedBy as verify-signals, not gospel — no alpha hit-areas.",
    inputSchema: { type: 'object', properties: { ref: { type: 'string' }, visual: { type: 'boolean', description: 'also run the pixel pass → a three-state `usable` verdict (reach ∧ visible)' }, baseline: { type: 'array', items: {}, description: "a golden signature (from visual_baseline[ref]) to confirm the node's own art" } }, required: ['ref'] },
    run: async (state, a) => { const o = {}; if (a.visual) o.visual = true; if (a.baseline) o.baseline = a.baseline; return { data: await needCp(state).reachable(a.ref, o) }; },
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
    name: 'orient',
    description: "Get your bearings in ONE call — where you are + what you can do right now. Returns {url, scene, engine, framework:{kind, registered, capabilities}, buttons, entryPoints:[refs a player can press now], hint}. Call it after connect instead of stitching probe + framework + interactive by hand. If framework.kind==='none' the game's app-layer state (pm_get/pm_set/pm_call) is unreachable until an adapter is registered.",
    inputSchema: { type: 'object', properties: {} },
    run: async (state) => ({ data: await needCp(state).orient() }),
  },
  {
    name: 'doctor',
    description: "Health check — 'why won't it even run'. ONE call: environment/boot (WebGL renderer, whether the scene actually populated, the GAME's console/pageerrors) + copse's engine-coupling (engine version, which version-sensitive internals resolve here). `ok:false` when the scene never came up (empty tree — e.g. a headless CI with no software Vulkan device → NULL WebGL context → Cocos builds no scene). The low-level 'is the plumbing healthy' counterpart to `orient` ('where am I', which assumes a booted game). Read-only. It probes the PAGE for the engine rather than trusting the session, and reports `connectedAs` alongside — so a session connected as the wrong engine is visible. LIMIT, stated plainly: a Pixi app can only be identified positively if copse's bundle was injected PRE-BOOT (engine:'pixi' or 'auto' at connect) or the game volunteers `__PIXI_APP__`/`__PIXI_DEVTOOLS__`; Pixi's init hook fires once during Application.init, so a session that connected as cocos to a Pixi game gets `engine:null` plus a note telling you to reconnect — never a false 'cocos'. Returns {ok, webgl, engine, scene, cc|pixi, errors, coupling}.",
    inputSchema: { type: 'object', properties: {} },
    run: async (state) => {
      const cp = needCp(state);
      const v = (r) => (r && typeof r === 'object' && 'value' in r) ? r.value : r;
      const webgl = v(await cp.eval("(()=>{try{const c=document.createElement('canvas');const g=c.getContext('webgl2')||c.getContext('webgl');const e=g&&g.getExtension('WEBGL_debug_renderer_info');return g?((g instanceof WebGL2RenderingContext?'webgl2 ':'webgl1 ')+(e?g.getParameter(e.UNMASKED_RENDERER_WEBGL):'ctx-ok')):'NULL-CONTEXT'}catch(e){return 'ERR:'+e.message}})()").catch(() => 'eval-failed'));
      // PROBE THE PAGE, not the session. The session's engine was fixed at connect time (default
      // cocos), so an agent that connected without engine:'pixi' to a Pixi game would otherwise get a
      // cc-shaped report saying "NO-SCENE" with no hint why — the exact dead end doctor exists to
      // break. This costs one eval and makes the tool's own description true.
      const onPage = v(await cp.eval("(()=>{try{const cocos=!!(window.cc&&window.cc.director&&window.cc.director.getScene&&window.cc.director.getScene());const app=(window.__copse&&window.__copse.app)||(window.__copsePixi&&window.__copsePixi.app)||(window.__PIXI_DEVTOOLS__&&window.__PIXI_DEVTOOLS__.app)||window.__PIXI_APP__;return{cocos,pixi:!!(app&&app.stage)}}catch(e){return{cocos:false,pixi:false}}})()").catch(() => ({ cocos: false, pixi: false })));
      const pageEngine = onPage && onPage.pixi ? 'pixi' : onPage && onPage.cocos ? 'cocos' : null;
      // tolerate a driver without engineReady (test fakes, and any older driver build)
      const sessionEngine = typeof cp.engineReady === 'function' ? await cp.engineReady() : (cp.engine ?? null);
      const mismatch = pageEngine && sessionEngine && pageEngine !== sessionEngine;
      const scene = v(await cp.eval((cp.engine === 'pixi'
        ? "(()=>{try{const s=window.__copse&&window.__copse.app&&window.__copse.app.stage;return s?{name:(window.__copse.orient().scene||'stage'),children:(s.children||[]).length}:'NO-SCENE'}catch(e){return 'ERR:'+e.message}})()"
        : "(()=>{try{const s=window.cc&&window.cc.director&&window.cc.director.getScene&&window.cc.director.getScene();return s?{name:s.name,children:(s.children||[]).length}:'NO-SCENE'}catch(e){return 'ERR:'+e.message}})()")).catch(() => 'eval-failed'));
      const cc = v(await cp.eval((cp.engine === 'pixi'
        ? "(()=>{try{const a=window.__copse&&window.__copse.app;return{hasPixi:!!a,hasStage:!!(a&&a.stage),hasTicker:!!(a&&a.ticker),canvases:document.querySelectorAll('canvas').length}}catch(e){return 'ERR:'+e.message}})()"
        : "(()=>{try{return{hasCc:!!window.cc,hasDirector:!!(window.cc&&window.cc.director),game:!!(window.cc&&window.cc.game),canvases:document.querySelectorAll('canvas').length}}catch(e){return 'ERR:'+e.message}})()")).catch(() => 'eval-failed'));
      const errors = (cp.logs({ level: ['error', 'pageerror'], tail: 20 }) || []).map((l) => l.text);
      const coupling = await cp.probe().catch(() => null);
      return { data: {
        ok: !!(scene && typeof scene === 'object' && scene.children > 0), webgl,
        engine: pageEngine,
        connectedAs: sessionEngine,
        injected: cp.installed,
        ...(mismatch ? { engineMismatch: `this page is running ${pageEngine}, but the session connected as ${sessionEngine} — reconnect with engine:"${pageEngine}" (the pixi layer must be injected PRE-BOOT, so it cannot be switched on an open session).` } : {}),
        ...(pageEngine ? {} : { engineNote: 'no engine identified itself on this page — copse looked for a live cc.director scene and a Pixi Application (init hook / __PIXI_APP__ / devtools globals). A Pixi game is INVISIBLE here unless copse was injected pre-boot, because its init hook fires once during Application.init: reconnect with engine:"pixi" (or "auto") to rule that in or out. Otherwise the page may be a release Cocos build whose `cc` was tree-shaken away, or simply not a canvas game.' }),
        scene, [cp.engine === 'pixi' ? 'pixi' : 'cc']: cc, errors, coupling,
      } };
    },
  },
  {
    name: 'logs',
    description: "Recent console output + uncaught errors captured from the game (all frames): [{level, text, t, stack?}] (level is the console method / 'pageerror'). SERVER-SIDE filtered so a chatty game's output never blows the token budget: `grep` (case-insensitive regex over the text, e.g. '\\\\[StartCommand\\\\]|500'), `level` ('error'|'warn'|'log'|…), `tail` (keep only the last N), `since` (an index — pass the count you've already seen). Combine them (since → level → grep → tail).",
    inputSchema: { type: 'object', properties: { grep: { type: 'string', description: 'case-insensitive regex over the log text' }, level: { type: 'string', description: "keep only this console level ('error'|'warn'|'log'|'info'|'debug'|'pageerror')" }, tail: { type: 'number', description: 'keep only the last N matching lines' }, since: { type: 'number', description: 'return logs from this index onward (default 0 = all)' } } },
    run: async (state, a) => ({ data: await needCp(state).logs(a || {}) }),
  },
  {
    name: 'watch',
    description: "Record a diff-only TIMELINE of game state over time. Samples `exprs` (in-page JS, e.g. 'gdp.active') and/or `selectors` (path:Comp.prop via get) every `interval` (default '1s'), recording ONLY changed keys with relative timestamps {t, dt} (answers 'step → result, how many seconds?'). Stops when `until` (an in-page boolean expr, e.g. 'gdp.active===false') is true or `timeout` (default '40s'); after `until` keeps recording for `settle` to catch the tail. Durations accept '1s'/'500ms'/'2m'/a number(ms). captureNetwork:true attaches requests fired during the window. Returns {timeline, stoppedBy, elapsed, samples}.",
    inputSchema: { type: 'object', properties: { exprs: { type: 'array', items: { type: 'string' }, description: 'in-page JS expressions to sample' }, selectors: { type: 'array', items: { type: 'string' }, description: 'path:Comp.prop selectors to sample via get' }, interval: { type: 'string', description: "sample interval (default '1s')" }, until: { type: 'string', description: 'stop when this in-page boolean expression is true' }, timeout: { type: 'string', description: "hard stop (default '40s')" }, settle: { type: 'string', description: "after `until`, keep recording this long to catch the tail" }, captureNetwork: { type: 'boolean', description: 'also attach the network requests fired during the watch window' } } },
    run: async (state, a) => ({ data: await needCp(state).watch(a) }),
  },
  {
    name: 'patch',
    record: true,
    description: "Wrap a live component method to verify a fix WITHOUT rebuilding. sel = path:Comp.method (e.g. Canvas/Mgr:PanelCtrl.setRoundInfo). `before`/`after`/`replace` are JS FUNCTION-EXPRESSION source strings (compiled in-page, `this` bound, hooks wrapped in try/catch so a bad hook can't break the call): before(args, self) runs first (return an ARRAY to replace args); replace(args, self) runs INSTEAD of the original; after(args, ret, self) runs last (return non-undefined to replace the result). trace:true records each call's {t, args, ret} → read via patch_calls (confirm real order/timing live). Example: before=\"(a,self)=>{ self.mode = self.off; }\". Returns {ok, method, hooks}. Undo with patch_clear.",
    inputSchema: { type: 'object', properties: { sel: { type: 'string', description: 'path:Comp.method selector' }, before: { type: 'string', description: 'JS fn-expr (args, self) => …  (return an array to replace args)' }, after: { type: 'string', description: 'JS fn-expr (args, ret, self) => …  (return non-undefined to replace the result)' }, replace: { type: 'string', description: 'JS fn-expr (args, self) => …  runs INSTEAD of the original' }, trace: { type: 'boolean', description: 'record each call (args/ret/timing) for patch_calls' } }, required: ['sel'] },
    run: async (state, a) => { const h = { before: a.before, after: a.after, replace: a.replace }; if (a.trace) h.trace = true; return { data: await needCp(state).patch(a.sel, h) }; },
  },
  {
    name: 'patch_clear',
    record: true,
    description: 'Undo `patch`: restore the original method (all patches if no sel). Returns {ok, cleared:[sels], hookErrors?} — hookErrors surfaces any exception your before/after hooks threw while the patch was active (so a silently-swallowed hook bug is still visible).',
    inputSchema: { type: 'object', properties: { sel: { type: 'string', description: 'the same path:Comp.method you patched (omit to clear all)' } } },
    run: async (state, a) => ({ data: await needCp(state).patchClear(a.sel) }),
  },
  {
    name: 'patch_calls',
    description: "Read trace:true patches' recorded calls. With `sel`: that method's calls, {ok, ref, calls:[{i, t, args, ret | threw}]}. WITHOUT `sel`: the MERGED timeline across every traced patch — {ok, traced:[sels], calls:[{sel, i, t, …}]} — which is how you answer CROSS-method order (\"did the mediator's handler run before the command?\") after arming several patches. `t` = ms since the first patch (ONE epoch shared by all patches, so times are comparable); `i` = a shared sequence number stamped on call ENTRY — order by `i`, not `t`, since a synchronous command chain runs inside a single millisecond. Pair with coir's static command flow to confirm what actually fired when.",
    inputSchema: { type: 'object', properties: { sel: { type: 'string', description: 'the path:Comp.method you patched with trace:true (omit for the merged timeline across all traced patches)' } } },
    run: async (state, a) => ({ data: await needCp(state).patchCalls(a.sel) }),
  },
  {
    name: 'pm_trace',
    record: true,
    description: "Arm the framework's DISPATCH choke points in one call — the whole app-layer flow, without knowing which class to name. Where pm_patch needs a selector you had to guess, this wraps whatever the registered adapter declares (PureMVC: `send` = Facade.sendNotification, `observe` = Observer.notifyObserver, `macro` = MacroCommand.execute), then `patch_calls()` (no sel) reads the merged timeline and `patch_clear()` disarms. Each row: {sel:'@role', i (order — USE THIS, not t), d (nesting depth), t, dt (gap from the previous row — where the real time hides), label}. Why the choke points and not the registries: a PureMVC View/Controller captures `mediator.handleNotification` / `this.executeCommand` as a function VALUE at registration, so patching a mediator instance or Controller.executeCommand observes NOTHING (measured: 0 hits / 60 executions) — an `observe` row whose label.to==='Controller' IS that notification's command running. Returns {ok, armed:[{role,sel,at}], unresolved?, failed?}; unresolved names any role whose paths didn't resolve on THIS build (widen them in copse.frameworks.mjs) rather than silently thinning the timeline.",
    inputSchema: { type: 'object', properties: { roles: { type: 'array', items: { type: 'string' }, description: "only arm these roles (default: all the adapter declares, e.g. ['send','observe','macro'])" }, traceMax: { type: 'number', description: 'ring-buffer rows per role (default 5000 — one action is ~237 rows and a sustained sequence gives ~190/s, so the `patch` default of 200 would drop the START of a chain)' } } },
    run: async (state, a) => ({ data: await needCp(state).pmTrace({ roles: a.roles, traceMax: a.traceMax }) }),
  },
  {
    name: 'framework',
    record: true,
    description: "Detect the game's app framework and enumerate its state registry: {kind, proxies:[names], mediators:[names], commands:[names], registered}. copse core ships NO framework knowledge — this reports whatever ADAPTER is registered this session (auto-loaded from copse.frameworks.mjs, or added via register_framework / connect({frameworks})). kind:'none' + registered:0 = no adapter installed; kind:'none' + registered>0 = an adapter is loaded but didn't match this build (widen its facade candidates). PureMVC etc. keep LOGIC state OUTSIDE the cc node tree, which get/call can't reach — use pm_get/pm_set/pm_call for those.",
    inputSchema: { type: 'object', properties: {} },
    run: async (state) => ({ data: await needCp(state).framework() }),
  },
  {
    name: 'register_framework',
    record: true,
    description: "Install a framework adapter this session so framework/pm_* can reach app-layer state (core ships none). `adapter` is a CONFIG object {kind, facade:[…window paths, 'a.b.*' expands a map], proxy:{via?,map?}, mediator:{…}, command:{map?}} — `via` a retrieve method name, `map` registry-path candidates — OR a code-adapter SOURCE string \"({detect,proxies,mediators,retrieve,…})\" for a framework the config can't express. De-duped by `kind`. Persist it in copse.frameworks.mjs (auto-loaded on connect); this adds one on the fly. Returns {ok, kind, registered}.",
    inputSchema: { type: 'object', properties: { adapter: { description: 'a config object, or a code-adapter source string' } }, required: ['adapter'] },
    run: async (state, a) => ({ data: await needCp(state).registerFramework(a.adapter) }),
  },
  {
    name: 'pm_get',
    record: true,
    description: "READ a PureMVC proxy/mediator's state — the logic state OUTSIDE the cc node tree that `get` can't reach. sel = 'Name.prop.subprop' (e.g. 'GameDataProxy.active' or 'GameDataProxy.sessionData.remaining'); Name is resolved via retrieveProxy then retrieveMediator. Returns {ok, value}. Run `framework` first to see the names. (The write half is a separate tool, `pm_set` — a write is an actuation.)",
    inputSchema: { type: 'object', properties: { sel: { type: 'string', description: "'ProxyOrMediatorName.prop.subprop'" } }, required: ['sel'] },
    run: async (state, a) => ({ data: await needCp(state).pmGet(a.sel) }),
  },
  {
    name: 'pm_set',
    record: true,
    description: "WRITE a PureMVC proxy/mediator leaf — an actuation (routed through the same `mutate` as press/call, so it carries `errors`/`changed`). sel = 'Name.prop.subprop' (e.g. set 'GameDataProxy.mode'); the write is VERIFIED (a read-only/getter leaf fails loud with reason 'write-no-effect'/'write-failed', never a false ok). Returns {ok, wrote}; if a setter TRANSFORMED the value (e.g. normalised it) the read-back also rides along as `landed` — so silent coercion is visible. `value` is explicitly multi-typed so the client sends the true JSON type — otherwise a scalar (boolean/number) crosses as a STRING. CAUTION: writing an INTERNAL state field MID-FLOW can wedge the state machine (e.g. forcing active while a action runs) — do forced writes at IDLE for isolated checks, not during a live flow.",
    inputSchema: { type: 'object', properties: { sel: { type: 'string', description: "'ProxyOrMediatorName.prop.subprop'" }, value: { type: JSON_VALUE, description: 'the value to write (any JSON type)' } }, required: ['sel', 'value'] },
    run: async (state, a) => ({ data: await needCp(state).pmSet(a.sel, a.value) }),
  },
  {
    name: 'pm_call',
    record: true,
    description: "Call a method on a PureMVC proxy/mediator: sel = 'Name.method' (e.g. 'PanelMediator.toggle'), args = the arguments. Drives app-layer logic that isn't a cc component method. Returns {ok, value}.",
    inputSchema: { type: 'object', properties: { sel: { type: 'string', description: "'ProxyOrMediatorName.method'" }, args: { type: 'array', items: { type: JSON_VALUE }, description: 'method arguments (each keeps its JSON type — see JSON_VALUE)' } }, required: ['sel'] },
    run: async (state, a) => ({ data: await needCp(state).pmCall(a.sel, ...(a.args || [])) }),
  },
  {
    name: 'pm_patch',
    record: true,
    description: "The app-layer analogue of `patch`: wrap a PureMVC proxy/mediator/command method (state OUTSIDE the cc tree). sel='Name.method' — a proxy/mediator is patched as an INSTANCE; a COMMAND (transient) is patched at its CLASS prototype so one wrap covers every run, e.g. pm_patch('StartCommand.execute', {trace:true}) traces the command chain's real order/timing (pair with coir's static command flow). before/after/replace/trace + patch_clear/patch_calls behave like `patch`. Returns {ok, method, kind:'instance'|'command'}. Fails loud if unresolvable — check `framework().capabilities.command` ('class' = works; else the adapter needs a code hook).",
    inputSchema: { type: 'object', properties: { sel: { type: 'string', description: "'ProxyOrMediatorName.method' or 'CommandName.execute'" }, before: { type: 'string' }, after: { type: 'string' }, replace: { type: 'string' }, trace: { type: 'boolean', description: 'record each call for patch_calls' } }, required: ['sel'] },
    run: async (state, a) => { const h = { before: a.before, after: a.after, replace: a.replace }; if (a.trace) h.trace = true; return { data: await needCp(state).pmPatch(a.sel, h) }; },
  },
  {
    name: 'pm_notify',
    record: true,
    description: "Fire a PureMVC notification — the most DIRECT entry into a notification-driven flow (trigger it without pressing a button / calling a specific method). `name` is the notification string (= the command's registration name; `framework().commands` lists them), `body`/`type` optional. Dispatches via the adapter's facade method (sendNotification/notify/… by config candidate). Returns {ok, via, value} or {ok:false, reason}. Combine with pm_patch(trace) + watch/network to trigger a flow and watch its command chain + server round-trip.",
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'the notification name (see framework().commands)' }, body: { type: JSON_VALUE, description: 'optional notification body (any JSON value; typed so a scalar keeps its JSON type)' }, type: { type: 'string', description: 'optional notification type' } }, required: ['name'] },
    run: async (state, a) => ({ data: await needCp(state).pmNotify(a.name, a.body, a.type) }),
  },
  {
    name: 'network',
    description: "Recent network requests captured from the game (all frames), SERVER-SIDE filtered: [{t, method, url, status, type, payload?}]. Purpose-built for 'client action → server error code' bugs (e.g. a action request that came back 500): press with captureNetwork:true, or call this after an action. Filters: `grep` (regex over url), `status` (e.g. 200 or 'failed'), `type` ('xhr'|'fetch'|…), `tail` (last N), `since` (index). xhr/fetch rows include a truncated request `payload`.",
    inputSchema: { type: 'object', properties: { grep: { type: 'string', description: 'case-insensitive regex over the request url' }, status: { description: "keep only this HTTP status (a number, or 'failed')" }, type: { type: 'string', description: "keep only this resourceType ('xhr'|'fetch'|'document'|…)" }, tail: { type: 'number', description: 'keep only the last N matching requests' }, since: { type: 'number', description: 'return requests from this index onward' } } },
    run: async (state, a) => ({ data: await needCp(state).network(a || {}) }),
  },
  {
    name: 'hold',
    description: "FREEZE the game's engine loop the moment a trigger method fires, so a transient state (e.g. a ~1s intermediate window in a self-running flow) can be screenshot / inspected, then `release`d. Arms a ONE-SHOT patch on `sel` (a path:Comp.method, or a framework Command/method with pm:true) — when it fires, the loop pauses with the last frame on screen. While held, `screenshot`/`get`/`pm_get`/`snapshot` all work (reads don't need the loop); `release` resumes. `at`:'after' (default — hold the state the trigger PRODUCES) or 'before'. `holdMs` auto-releases after N ms. Returns {ok, armed, sel} or {ok:false, reason:'no-freeze-api'}. Boundary: freezes everything on the engine loop (scheduler/tween/animation); a bare setTimeout-driven state won't freeze, and a held game can't be driven until release.",
    inputSchema: { type: 'object', properties: { sel: { type: 'string', description: "trigger method: 'path:Comp.method', or a framework 'Name.method' with pm:true" }, at: { type: 'string', description: "'after' (default, hold the resulting state) | 'before'" }, pm: { type: 'boolean', description: 'the trigger is a framework proxy/mediator/command method (uses pm_patch resolution)' }, holdMs: { type: 'number', description: 'auto-release after this many ms (omit = hold until release)' } }, required: ['sel'] },
    run: async (state, a) => { const o = {}; if (a.at) o.at = a.at; if (a.pm) o.pmMode = true; if (a.holdMs != null) o.holdMs = a.holdMs; return { data: await needCp(state).hold(a.sel, o) }; },
  },
  {
    name: 'release',
    description: "Resume the engine loop after a `hold` (or clear an armed-but-not-yet-fired hold). Returns {ok, resumed, wasHeld, heldMs}. Idempotent — safe when nothing is held.",
    inputSchema: { type: 'object', properties: {} },
    run: async (state) => ({ data: await needCp(state).release() }),
  },
  {
    name: 'hold_status',
    description: "Current hold state: {armed, held, sel, via, sinceMs} — `armed` = a trigger is waiting to fire, `held` = the loop is frozen now, `via` = which freeze API engaged ('game'|'director').",
    inputSchema: { type: 'object', properties: {} },
    run: async (state) => ({ data: await needCp(state).holdStatus() }),
  },
  {
    name: 'screenshot',
    description: "Capture the game canvas as a PNG — logic tools are pixel-blind, so this pairs a logic state with what's ACTUALLY on screen (e.g. a button that's 30px off, which no state read can catch). `selector` best-effort clips to a node's screen rect (falls back to the full frame if it can't project). `path` writes the PNG to disk and returns {ok, path}; omit `path` to return the image INLINE (the model sees it). Works in attach mode (your real browser) and the headless GPU launch.",
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'node ref to clip to (best-effort)' }, path: { type: 'string', description: 'write the PNG here instead of returning it inline' } } },
    run: async (state, a) => { const r = await needCp(state).screenshot(a); return r && r.base64 ? { image: { data: r.base64, mimeType: r.mimeType } } : { data: r }; },
  },
  {
    name: 'visual_check',
    description: "Node-anchored PIXEL check (copse otherwise reads the node tree, never pixels). Screenshots JUST this node's screen rect (dynamic children — labels/particles/spine — masked) → three-state {drawn, matches, clear, score?, visible, via, reason?} in reachable's grammar (true|false|'unknown'). drawn = anything actually rendered there (catches 'tree says active, screen blank'). With a golden `baseline` (from visual_baseline): matches = looks like the golden, clear = the node's OWN art is visible — this closes reachable's blind spot (an opaque sprite over a button reads reachable:true but clear:false). No baseline → matches/clear are 'unknown' (drawn still answers).",
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
    description: 'Run a sequence of steps in ONE call — BOTH a frozen regression script AND your ad-hoc BATCH (ops run back-to-back, no agent-turn latency between: e.g. call + pm_call then watch). Each step\'s `op` is any driver op (the camelCase form of an MCP tool: press/get/call/pmGet/pmSet/pmCall/pmNotify/pmPatch/patch/watch/network/reachable/… + {op:"sleep",ms}) with that op\'s fields (ref/sel/args/opts/value/…). `script` = {name?, continueOnFail?, steps:[…]}; a step may carry `expect` (subset match: primitives ===, objects by key, arrays CONTAINS) and `allowErrors`. No expect → passes on ok!==false; fact gates: result.errors fails (unless allowErrors / an errors expect), a press with drove:"nothing" fails. Narrow the errors gate without going all-or-nothing (on a step or the whole script): `ignoreErrors` (regex|regex[]) drops matching background noise (e.g. a game\'s "EventSource … MIME type … Aborting" SSE warning) from the gate while keeping it in result.errors; `errorGate` sets the source floor — "uncaught" fails only on a real throw (a pageerror), tolerating console.error; "off" = allowErrors. Stops at the first fail unless continueOnFail:true. A passing READ step (get/pmGet/node/reachable/framework/probe/orient/listeners/patchCalls/diff) AUTO-captures its (truncated) result so you can PEEK at the value in a green run without a re-fetch; `capture:false` on the step suppresses it. Actuations (press/call/…) and big list ops (snapshot/watch/…) stay silent unless `capture:true` (on the step, or `capture` on the whole script). Returns {pass, failedAt?, steps}.',
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
