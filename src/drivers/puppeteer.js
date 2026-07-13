// NOTE: intentionally NOT `// @ts-check` — this file is browser-driver glue; its
// `page.evaluate` callbacks run in the GAME's window (where `window.__copse`/`cc` live),
// so type-checking them against Node's lib produces only false positives.
// OPTIONAL driver (subpath `copse/driver-puppeteer`). Drives a running Cocos game in a
// real browser (system Chrome via puppeteer-core), injects copse, and returns a Driver
// for runHarness. NOT loaded by `import 'copse'` — keeps the core zero-dep. Needs the
// peer dep `puppeteer-core` and a built `dist/copse.inject.js`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { diff as coreDiff } from '../core/index.js';
import { signature, visualVerdict } from '../sensors/pixel.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- framework adapters (SUGGESTIONS #4) ----------------------------------------------------
// copse core ships NO framework knowledge; the driver auto-loads adapters from copse.frameworks.mjs
// (this machine's, git-ignored, next to the copse package — "all the games I attach"; then a per-project
// one in cwd) plus any passed via connect({frameworks}), and injects them so framework/pm_get/pm_set/pm_call
// light up. Later sources override earlier ones by `kind` (the in-page registry de-dupes on kind).
async function loadModuleAdapters(href) {
  try { const mod = await import(href); const def = mod.default ?? mod.frameworks ?? mod.adapters; return Array.isArray(def) ? def : (def ? [def] : []); }
  catch { return []; }
}
// A frameworks[] item is a config OBJECT, a code-adapter SOURCE string, or a FILE PATH (.mjs/.js/.json) to load.
async function coerceFrameworkItem(it) {
  if (it && typeof it === 'object') return [it];
  if (typeof it === 'string') {
    // A .mjs/.js/.json string is a PATH, not code source (a code adapter reads `({…})`). If it looks like a
    // path, it MUST exist — fail loud on a typo rather than injecting the path as a bogus code-adapter source.
    if (/\.(mjs|js|json)$/.test(it)) {
      if (!existsSync(it)) throw new Error(`framework file not found: ${it} (a --framework / connect({frameworks}) path must exist)`);
      if (it.endsWith('.json')) return [JSON.parse(readFileSync(it, 'utf8'))];
      return await loadModuleAdapters(pathToFileURL(resolvePath(it)).href);
    }
    return [it]; // an in-page code-adapter source string
  }
  return [];
}
// A framework adapter crosses into the page via frame.evaluate, which JSON-serializes its argument and
// DROPS function properties — so a code-adapter written as a natural .mjs OBJECT (detect/retrieve/… fns)
// would arrive as just {kind} and silently fail to register. Serialize such an object to a SOURCE STRING
// (functions via .toString()) so it survives; plain config objects (no functions) and existing source
// strings pass through untouched. Only CLOSURE-FREE adapter fns round-trip — they operate on the passed
// root, which is the documented shape; a closure-bearing fn would ReferenceError in-page (fail loud).
function adapterToInjectable(a) {
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object' && Object.values(a).some((v) => typeof v === 'function')) {
    const parts = Object.entries(a).map(([k, v]) => `${JSON.stringify(k)}:${typeof v === 'function' ? v.toString() : JSON.stringify(v)}`);
    return '({' + parts.join(',') + '})';
  }
  return a;
}
async function resolveFrameworks(opts) {
  const items = [];
  // 1) this machine's global, alongside the copse package (git-ignored)
  items.push(...await loadModuleAdapters(new URL('../../copse.frameworks.mjs', import.meta.url).href));
  // 2) a per-project override in the working dir, if present
  try { const p = join(process.cwd(), 'copse.frameworks.mjs'); if (existsSync(p)) items.push(...await loadModuleAdapters(pathToFileURL(p).href)); } catch { /* */ }
  // 3) explicit connect({frameworks:[…]})
  for (const it of (opts.frameworks || [])) items.push(...await coerceFrameworkItem(it));
  return items;
}

// Server-side filter for the captured console/network ring buffers — applied in THIS Node process so a
// chatty game's 65KB never crosses back to an MCP client's token budget (SUGGESTIONS #2/#7). ONE core
// (since → optional per-buffer `specific` → grep on a field → tail); `arg` is a number (back-compat:
// a `since` index) or an options object. filterLogs/filterNet are thin specialisations.
function filterBuffer(buf, arg, grepField, specific) {
  const o = typeof arg === 'number' ? { since: arg } : (arg || {});
  let out = buf.slice(o.since || 0);
  if (specific) out = specific(out, o);
  if (o.grep) { let re = null; try { re = new RegExp(o.grep, 'i'); } catch { /* literal */ } out = out.filter((x) => (re ? re.test(x[grepField] || '') : (x[grepField] || '').includes(o.grep))); }
  if (o.tail) out = out.slice(-o.tail);
  return out;
}
const filterLogs = (buf, arg) => filterBuffer(buf, arg, 'text', (out, o) => (o.level ? out.filter((l) => (Array.isArray(o.level) ? o.level : [o.level]).includes(l.level)) : out));
const filterNet = (buf, arg) => filterBuffer(buf, arg, 'url', (out, o) => {
  if (o.status != null) { const S = (Array.isArray(o.status) ? o.status : [o.status]).map(String); out = out.filter((r) => S.includes(String(r.status))); }
  if (o.type) { const T = Array.isArray(o.type) ? o.type : [o.type]; out = out.filter((r) => T.includes(r.type)); }
  return out;
});
const DEFAULT_CHROME = process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : '/usr/bin/google-chrome';

async function loadPuppeteer() {
  try { return (await import('puppeteer-core')).default; }
  catch { throw new Error("copse/driver-puppeteer needs `puppeteer-core` — run: npm i -D puppeteer-core"); }
}

// ---- attach tab selection (SUGGESTIONS B4) --------------------------------------------------------
// `match` may be a URL substring, a LIST of substrings (ALL must be present), or {url?,title?} — every
// condition is ANDed, and title is matchable too, so two builds sharing a url fragment (both carry
// `e=rd`) are still told apart. Empty (no match/url) → active-tab mode.
function normMatch(m) {
  if (!m) return [];
  if (Array.isArray(m)) return m.filter(Boolean).map((s) => ({ field: 'url', needle: String(s) }));
  if (typeof m === 'object') { const c = []; if (m.url) c.push({ field: 'url', needle: String(m.url) }); if (m.title) c.push({ field: 'title', needle: String(m.title) }); return c; }
  return [{ field: 'url', needle: String(m) }];
}
const condMatch = (conds, url, title) => conds.every((c) => (c.field === 'title' ? (title || '') : (url || '')).includes(c.needle));

// Enumerate a browser's open tabs → [{index,url,title,active}] (active = visible + focused). No injection,
// no navigation — safe reconnaissance. `active` is race-bounded so a paused/breakpointed tab can't hang it.
export async function listTabs(browser) {
  const pages = await browser.pages();
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i]; let t = '', active = false;
    try { t = await pg.title(); } catch { /* */ }
    try { active = await Promise.race([pg.evaluate(() => document.visibilityState === 'visible' && document.hasFocus()).then((v) => v, () => false), sleep(600).then(() => false)]); } catch { /* */ }
    out.push({ index: i, url: pg.url(), title: t, active });
  }
  return out;
}
// Connect to an existing Chrome JUST to list its tabs, then disconnect — for choosing a `match`/`pick`
// BEFORE connect (the chrome-devtools-mcp composition: it opens tabs, you pick which to attach).
export async function browseTabs({ browserURL, browserWSEndpoint } = {}) {
  if (!browserURL && !browserWSEndpoint) throw new Error('list tabs needs browserURL/browserWSEndpoint — start Chrome with --remote-debugging-port=9222');
  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.connect({ browserURL, browserWSEndpoint, defaultViewport: null });
  try { return await listTabs(browser); } finally { try { browser.disconnect(); } catch { /* */ } }
}

/**
 * Launch (or connect to) a browser, load the game, inject copse → a Driver for
 * runHarness. The returned object is the Driver (snapshot/interactive/press/get/call/eval/
 * reachable/node/diff/listeners/probe/logs/watch/patch/patchClear/framework/pmGet/pmSet/pmCall/network/
 * screenshot) plus `page`, `frame` (the frame cc was found in — may be a
 * nested/cross-origin iframe), `browser`, and `close()`.
 * @param {string} url
 * @param {{bundlePath?:string|URL, executablePath?:string, browserURL?:string, browserWSEndpoint?:string, attach?:boolean, match?:string, attachTries?:number, headless?:any, viewport?:any, fpsCap?:number, timeout?:number, bootTries?:number, readyTries?:number, maxLogs?:number, settle?:boolean|{maxMs?:number,interval?:number}}} [opts]
 *        attach: drive an ALREADY-OPEN tab in `browserURL`'s Chrome (find it by `match` URL
 *        substring; omit match+url to attach the ACTIVE tab; no navigation — for your own game
 *        behind a login/staging gate you opened yourself, so a fresh goto won't bounce you back to
 *        it). `close()` then just disconnects, leaving your browser open.
 *        settle: after a mutating press/call, wait until the tree stabilises (tweens) then
 *        attach a `changed` auto-diff to the result. Default on; `settle:false` to disable.
 */
export async function connect(url, opts = {}) {
  const puppeteer = await loadPuppeteer();
  const bundlePath = opts.bundlePath || new URL('../../dist/copse.inject.js', import.meta.url);
  let bundle;
  try { bundle = readFileSync(bundlePath, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') throw new Error("copse inject bundle not found at dist/copse.inject.js — run `npm run build` first (or pass bundlePath)");
    throw e;
  }
  const remote = opts.browserURL || opts.browserWSEndpoint;
  // guard BEFORE creating a browser, so a misconfigured attach never leaks a launched one.
  if (opts.attach && !remote) throw new Error('attach mode needs browserURL/browserWSEndpoint — start Chrome with --remote-debugging-port=9222');
  const browser = remote
    ? await puppeteer.connect({ browserURL: opts.browserURL, browserWSEndpoint: opts.browserWSEndpoint, defaultViewport: null })
    : await puppeteer.launch({ executablePath: opts.executablePath || DEFAULT_CHROME, headless: opts.headless ?? 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--mute-audio'] });

  // attach mode: drive an ALREADY-OPEN tab (your own game behind a login/staging gate you opened
  // yourself) — find it by URL substring and DON'T navigate (a fresh goto would bounce you back out
  // of it; CDP attach opens no DevTools panel either). No match/url → the ACTIVE tab (the one being
  // viewed, or one another CDP tool such as chrome-devtools-mcp brought to front): visibilityState is
  // 'visible' only for each window's front tab; prefer the focused window when several qualify. Each
  // probe is race-bounded so a tab halted at a breakpoint can't hang the scan — which also means a
  // PAUSED tab reads 'hidden' and won't be picked: attach to a paused game via `match`.
  let page, attachedTab = null;
  if (opts.attach) {
    const conds = normMatch(opts.match || url);   // [] → active-tab mode
    const shown = JSON.stringify(opts.match || url);
    const probe = (pg, fn, dflt) => Promise.race([pg.evaluate(fn).then((v) => v, () => dflt), sleep(800).then(() => dflt)]);
    const activeTab = async (pages) => {
      const vis = [];
      for (const pg of pages) { if (await probe(pg, () => document.visibilityState, 'hidden') === 'visible') vis.push(pg); }
      for (const pg of vis) { if (await probe(pg, () => document.hasFocus(), false)) return pg; }
      return vis[0] || pages[0] || null;
    };
    for (let i = 0, n = opts.attachTries ?? 30; i < n && !page; i++) {
      const pages = await browser.pages();
      if (conds.length) {
        // Collect ALL matches (url + title) — a lone `.find()` silently grabbed the FIRST, so two builds
        // sharing a url fragment connected to the wrong one, discovered late. >1 match is an ambiguity.
        const cand = [];
        for (const pg of pages) { const u = pg.url(); let t = ''; try { t = await pg.title(); } catch { /* */ } if (condMatch(conds, u, t)) cand.push({ pg, url: u, title: t }); }
        if (cand.length > 1 && opts.pick == null) {
          throw new Error(`attach: ${cand.length} open tabs match ${shown} — narrow the match (a list ANDs, title matches too) or pass pick:<index>:\n`
            + cand.map((c, k) => `  [${k}] ${c.title || '(no title)'} — ${c.url}`).join('\n'));
        }
        const chosen = cand[opts.pick || 0];
        if (chosen) { page = chosen.pg; attachedTab = { url: chosen.url, title: chosen.title, index: opts.pick || 0, of: cand.length }; }
      } else {
        page = await activeTab(pages);
        if (page) { let t = ''; try { t = await page.title(); } catch { /* */ } attachedTab = { url: page.url(), title: t, index: 0, of: 1, active: true }; }
      }
      if (!page) await sleep(1000);
    }
    if (!page) throw new Error(conds.length ? `attach: no open tab matching ${shown} — open the game in that Chrome first (or \`list_tabs\` to see what's open)` : 'attach: no open tab in that Chrome — open the game first');
  } else {
    page = await browser.newPage();
    await page.setViewport(opts.viewport || { width: 414, height: 896, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  }

  // Capture console + uncaught errors from ALL frames (no injection needed; survives reloads).
  // Exposed as cp.logs() — closes the "doesn't-crash" gap: a handler that logs/throws
  // without a visible UI change is otherwise invisible.
  const logs = [];
  // `level` matches the in-page __copse.logs() field name (console method / 'pageerror'),
  // so the Driver/MCP log shape and the console-paste log shape agree.
  // logWindows: per-action collectors — a window keeps its OWN rows even after the ring buffer shift()s
  // its front off (an absolute index into `logs`/`net` slides once >maxLogs/maxNet rows arrive mid-window).
  const logWindows = new Set();
  const cap = (level, text, extra) => { const row = { level, text, t: Date.now(), ...extra }; logs.push(row); if (logs.length > (opts.maxLogs ?? 2000)) logs.shift(); for (const w of logWindows) w.push(row); };
  page.on('console', (m) => { try { cap(m.type(), m.text()); } catch {} });
  page.on('pageerror', (e) => cap('pageerror', e.message, { stack: e.stack }));

  // Passive network capture (all frames) — for "client action → server error code" bugs (a action
  // request that came back 500): cp.network() reads it, or press({captureNetwork:true}) attaches the
  // slice a press triggered. xhr/fetch rows carry a truncated request payload; failures land as status:'failed'.
  const net = [];
  const netWindows = new Set();  // per-action collectors (see logWindows) — survive net.shift() on a chatty window
  const capNet = (row) => { net.push(row); if (net.length > (opts.maxNet ?? 500)) net.shift(); for (const w of netWindows) w.push(row); };
  page.on('response', (res) => {
    try {
      const req = res.request(); const type = req.resourceType();
      const row = { t: Date.now(), method: req.method(), url: req.url(), status: res.status(), type };
      if (type === 'xhr' || type === 'fetch') { try { const pd = req.postData(); if (pd) row.payload = pd.length > 800 ? pd.slice(0, 800) + '…' : pd; } catch {} }
      capNet(row);
    } catch {}
  });
  page.on('requestfailed', (req) => { try { capNet({ t: Date.now(), method: req.method(), url: req.url(), status: 'failed', type: req.resourceType(), error: (req.failure() && req.failure().errorText) || 'failed' }); } catch {} });

  if (!opts.attach) await page.goto(url, { waitUntil: 'load', timeout: opts.timeout ?? 60000 });

  // Find the frame that has cc — the game is often inside a (possibly nested, possibly
  // cross-origin) iframe. page.frames() gives EACH frame its own evaluate context, so
  // cross-origin works here (unlike in-page JS, which SOP blocks). Drive that frame.
  const hasCc = (f) => f.evaluate(async () => {
    let cc = window.cc;
    if ((!cc || !cc.director) && window.System) { try { cc = (await System.import('cc')).default || await System.import('cc'); } catch {} }
    if (!(cc && cc.director && cc.director.getScene)) return false;
    window.cc = cc; const s = cc.director.getScene(); return !!(s && (s.children || []).length);
  }).catch(() => false);

  let frame = page.mainFrame();
  const rawEv = (fn, ...a) => frame.evaluate(fn, ...a); // used DURING init (must NOT await `ready`)
  // heat control: cap fps low for our headless launch (NOT pause — pausing can freeze a game still
  // loading). In attach mode it's the user's real browser/GPU, so leave its fps alone unless asked.
  const fps = opts.fpsCap ?? (opts.attach ? null : 10);

  // In-page init: find the cc frame → inject the bundle → install __copse → settle to a UI scene.
  // EVERY step is a frame.evaluate, which BLOCKS while the renderer is paused at a breakpoint. So we
  // run it as a promise and (in attach mode) don't force-await it: if you're sitting in the debugger it
  // stalls, connect returns anyway, and this finishes later when you resume (the queued evaluates run →
  // __copse installs → `ready` resolves). See the pause auto-detect below.
  // Framework adapters to inject once __copse is up (resolved once; re-injected on every boot/reload
  // since a navigation wipes the in-page registry). Empty unless a copse.frameworks.mjs / opts.frameworks exists.
  const fwAdapters = await resolveFrameworks(opts);

  // Find the cc frame → inject the bundle → install __copse → settle to a UI scene. Factored out so
  // `cp.reload()` can re-run it after a navigation (a reload replaces the frames + wipes __copse).
  const bootInPage = async () => {
    for (let i = 0, n = opts.bootTries ?? 40; i < n; i++) {
      let found = null;
      for (const f of page.frames()) { if (await hasCc(f)) { found = f; break; } }
      if (found) { frame = found; break; }
      await sleep(1000);
    }
    await frame.evaluate(bundle);
    await frame.evaluate(() => { if (!window.__copse && window.copse) window.copse.install(window.cc); });
    await frame.waitForFunction(() => !!window.__copse, { timeout: 10000 });
    // register framework adapters (PureMVC etc.) into the fresh __copse before anything reads state
    for (const a of fwAdapters) { try { await frame.evaluate((x) => { try { window.__copse.registerFramework && window.__copse.registerFramework(x); } catch { /* */ } }, adapterToInjectable(a)); } catch { /* */ } }
    if (fps != null) await rawEv((f) => { const G = window.cc.game; try { G.frameRate = f; } catch {} try { G.setFrameRate && G.setFrameRate(f); } catch {} }, fps);
    for (let i = 0, n = opts.readyTries ?? 25; i < n; i++) {
      if (await rawEv(() => { try { return window.__copse.interactive().length > 0; } catch { return false; } })) break;
      await sleep(1000);
    }
  };
  const ready = bootInPage();

  // Auto-reconnect (SUGGESTIONS #6): the page reloads a lot during testing (game refresh, mock-token
  // swap), which detaches the frame + wipes __copse → every in-page call throws "detached Frame". Detect
  // that class of error and TRANSPARENTLY re-find the cc frame + re-inject once, then retry — so a caller
  // never has to manually reconnect after a navigation. reboot() is de-duped so concurrent calls share one.
  const isDetached = (e) => { const m = (e && e.message) || String(e); return /detached|context was destroyed|Cannot find context|Target closed|Session closed|page has been closed/i.test(m); };
  let rebooting = null;
  const reboot = () => (rebooting || (rebooting = (async () => { frame = page.mainFrame(); await bootInPage(); })().then((v) => { rebooting = null; return v; }, (e) => { rebooting = null; throw e; })));

  // Public evaluator: in-page calls wait for init, so a paused/deferred attach auto-unblocks them once
  // you resume. For launch + a live attach, `ready` is already settled → no extra delay. On a detached
  // frame (a navigation happened under us), re-inject and retry the call ONCE.
  const ev = async (fn, ...a) => {
    await ready;
    try { return await frame.evaluate(fn, ...a); }
    catch (e) { if (!isDetached(e)) throw e; await reboot(); return frame.evaluate(fn, ...a); }
  };

  // Two DISTINCT attach conditions, kept apart so connect never hangs AND never mislabels one as the
  // other (they were conflated into one `paused` before, so a still-loading game read as "paused in the
  // debugger"). `paused` = a trivial evaluate won't even return → the renderer is genuinely HALTED
  // (debugger/OOPIF). `stalled` = evaluate returns fine, but init didn't settle within injectStallMs —
  // almost always because the game is on a loading/intro screen with no interactive buttons yet (readyTries
  // waits for interactive()>0); __copse is typically already installed, so snapshot/probe work — it's just
  // not "ready" by the buttons heuristic. Launch can't be pre-paused → await fully (init errors still throw).
  let paused = false, stalled = false;
  if (!opts.attach) {
    await ready;
  } else {
    const probe = await Promise.race([page.evaluate(() => 1).then(() => 'live', () => 'live'), sleep(opts.pauseProbeMs ?? 1200).then(() => 'frozen')]);
    if (probe === 'frozen') paused = true;
    else if ((await Promise.race([ready.then(() => 'ok', () => 'ok'), sleep(opts.injectStallMs ?? 20000).then(() => 'stall')])) === 'stall') stalled = true;
    if (paused || stalled) ready.catch(() => {}); // settles on resume / once buttons appear; don't trip unhandled-rejection
  }

  // A relevant (small) snapshot is the basis for settle + auto-delta around mutating ops.
  const snapRel = () => ev(() => window.__copse.snapshot({ relevant: true }));
  // The `changed` diff includes inactive nodes so a panel toggling active reports as activated/deactivated
  // (not just appeared/disappeared) — a node must be in BOTH before+after for coreDiff to see the flip.
  const snapDiff = () => ev(() => window.__copse.snapshot({ relevant: true, includeInactive: true }));
  // structural signature — refs + active + interactable; ignores label TEXT so a ticking
  // clock/timer doesn't prevent the tree from being judged "stable".
  const sig = (s) => s.map((d) => `${d.ref}|${d.active === false ? 0 : 1}|${d.interactable === false ? 0 : 1}`).join('\n');
  const settleCfg = opts.settle === false ? null : { maxMs: 3000, interval: 150, ...(typeof opts.settle === 'object' ? opts.settle : {}) };

  // Q3: after a mutating action, poll until the tree stops changing (handles tweens /
  // scene transitions of unknown duration) — fast for instant changes, bounded by maxMs.
  async function settle() {
    if (!settleCfg) return;
    let prev = sig(await snapRel()); const t0 = Date.now();
    while (Date.now() - t0 < settleCfg.maxMs) {
      await sleep(settleCfg.interval);
      const cur = sig(await snapRel());
      if (cur === prev) return;   // two consecutive equal reads → settled
      prev = cur;
    }
  }
  // Q2: run a state-mutating action, settle, then attach `changed` (auto-diff) to the
  // result — so callers/agents get "what this did" without manual snapshot/diff steps.
  async function mutate(action, captureNetwork) {
    const before = settleCfg ? await snapDiff() : null;
    const logWin = []; logWindows.add(logWin);                 // collect THIS action's logs/net directly (not by index)
    const netWin = captureNetwork ? [] : null; if (netWin) netWindows.add(netWin);
    let r;
    try { r = await action(); await settle(); }
    finally { logWindows.delete(logWin); if (netWin) netWindows.delete(netWin); }
    if (before && r && typeof r === 'object') {
      const c = coreDiff(before, await snapDiff());
      if (c.appeared.length || c.disappeared.length || c.activated.length || c.deactivated.length || c.labelChanged.length) r.changed = c;
    }
    // captureNetwork (SUGGESTIONS #7): attach the requests this action triggered — for the
    // "client action → server error code" case where the client state looks fine but the server rejected it.
    if (netWin && r && typeof r === 'object' && netWin.length) r.network = netWin.map((x) => ({ ...x }));
    // doesn't-crash signal: any error console / uncaught pageerror during the action+settle window. Catches a
    // handler that THREW even when the engine swallowed it to console.error — the action still returns ok:true, but
    // `errors` surfaces it (and the harness hard-fails on it). Captured out-of-band over CDP, so it's reliable.
    if (r && typeof r === 'object') {
      const errs = logWin.filter((l) => l.level === 'error' || l.level === 'pageerror');
      if (errs.length) r.errors = errs.map((l) => ({ level: l.level, text: l.text, ...(l.stack ? { stack: l.stack } : {}) }));
    }
    return r;
  }

  // ---- node-anchored visual layer (P1b) --------------------------------------------------------------
  // Reduce a node's on-screen pixels to a signature: read the in-page manifest (rect + dynamic mask rects,
  // viewport CSS px) → CDP-screenshot JUST that rect → downsample to grid×grid IN-PAGE (a 2D canvas decodes
  // the opaque screenshot for free; the game's own WebGL canvas can't be read from JS) → signature() the
  // tiny RGBA in Node. Masks are painted before downscaling so animation/particle/text jitter never signs.
  const VGRID = 16;
  // The cc frame may be a nested/OOPIF iframe offset from the top page. page.screenshot clips in TOP-page
  // coords while the manifest rect is IFRAME-local, so resolve the cc frame's offset in the top page (0,0
  // for the main frame). Returns null when it can't be determined (an OOPIF with no reachable frameElement)
  // → visualSig then degrades LOUD instead of screenshotting the wrong region.
  async function ccFrameOffset() {
    if (frame === page.mainFrame()) return { x: 0, y: 0 };
    let el; try { el = await frame.frameElement(); } catch { el = null; }
    if (!el) return null;
    let box; try { box = await el.boundingBox(); } catch { box = null; } finally { try { await el.dispose(); } catch { /* */ } }
    return box ? { x: box.x, y: box.y } : null;
  }
  async function visualSig(ref, o = {}) {
    const grid = o.grid || VGRID;
    const manifest = await ev((r) => window.__copse.visualManifest(r), ref);
    if (!manifest || !manifest.rect) return { manifest, sig: null, reason: (manifest && manifest.reason) || 'no-manifest' };
    const vp = await ev(() => ({ w: window.innerWidth, h: window.innerHeight })).catch(() => null);
    const r = manifest.rect;
    const x = Math.max(0, r.x), y = Math.max(0, r.y);
    let w = r.w - (x - r.x), h = r.h - (y - r.y);              // trim the part clamped off the top/left
    if (vp) { w = Math.min(w, vp.w - x); h = Math.min(h, vp.h - y); } // and off the right/bottom
    if (!(w >= 1 && h >= 1)) {
      // fully outside the viewport (negative/over-far coords) reads as a real "not on screen" answer, not
      // a sampling failure — distinguish so a caller sees `offscreen` vs a genuinely degenerate rect.
      const off = r.x + r.w <= 0 || r.y + r.h <= 0 || (vp && (r.x >= vp.w || r.y >= vp.h));
      return { manifest, sig: null, reason: off ? 'offscreen' : 'degenerate-rect' };
    }
    // rect/masks are iframe-LOCAL; the CDP screenshot clips in TOP-page coords → add the cc frame's offset.
    const foff = await ccFrameOffset();
    if (!foff) return { manifest, sig: null, reason: 'iframe-offset-unknown' }; // OOPIF we can't place → degrade loud
    const local = { x, y, width: w, height: h };                        // iframe-local region (mask math)
    const clip = { x: x + foff.x, y: y + foff.y, width: w, height: h };  // top-page region (the screenshot)
    // version-safe: recent puppeteer returns a Uint8Array (the `encoding:'base64'` option is gone) → base64 in Node.
    const shot = await page.screenshot({ clip, type: 'png' }).catch(() => null);
    if (!shot) return { manifest, sig: null, reason: 'screenshot-failed' };
    const png = Buffer.from(shot).toString('base64');
    // Decode+downsample in-page. Guard it like its siblings above: a CSP that blocks data: imgs (or any
    // decode failure) must degrade LOUD, not throw out of visualSig and reject the whole visualCheck.
    const rgba = await page.evaluate(async ({ b64, grid, masks, clip }) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('decode')); img.src = 'data:image/png;base64,' + b64; });
      const fw = img.width || 1, fh = img.height || 1;
      const scratch = document.createElement('canvas'); scratch.width = fw; scratch.height = fh;
      const ctx = scratch.getContext('2d'); ctx.drawImage(img, 0, 0);
      const sx = fw / clip.width, sy = fh / clip.height;       // screenshot px per CSS px (≈ devicePixelRatio)
      ctx.fillStyle = '#000';
      for (const m of masks || []) ctx.fillRect((m.x - clip.x) * sx, (m.y - clip.y) * sy, m.w * sx, m.h * sy);
      const small = document.createElement('canvas'); small.width = grid; small.height = grid;
      const s2 = small.getContext('2d'); s2.drawImage(scratch, 0, 0, grid, grid);
      return Array.from(s2.getImageData(0, 0, grid, grid).data);
    }, { b64: png, grid, masks: manifest.maskRects, clip: local }).catch(() => null); // masks are iframe-local → pass the local region
    if (!rgba) return { manifest, sig: null, reason: 'decode-failed' };
    return { manifest, sig: signature(rgba, grid, grid, { grid }), grid };
  }

  /** @type {any} */
  const cp = {
    // CDP reload: reload the attached tab (re-fetches the preview → picks up the editor's CURRENT
    // scene) and re-inject copse. Use after opening a different scene in Cocos Creator, or to recover a
    // wedged / empty / half-loaded preview (the case where attach found getScene()===null). Re-finds the
    // cc frame post-navigation and re-installs __copse. Returns a readiness summary.
    reload: async (o = {}) => {
      await page.reload({ waitUntil: o.waitUntil || 'load' });
      frame = page.mainFrame();   // the navigation replaced every frame; bootInPage re-finds the cc one
      await bootInPage();
      const snap = await ev(() => window.__copse.snapshot({ relevant: true }));
      const inter = await ev(() => window.__copse.interactive());
      return { ok: true, reloaded: true, url: page.url(), relevantNodes: snap.length, buttons: inter.length };
    },
    snapshot: (o) => ev((o) => window.__copse.snapshot(o), o ?? {}),
    interactive: () => ev(() => window.__copse.interactive()),
    clickSurface: (o) => ev((o) => window.__copse.clickSurface(o), o ?? {}), // join-ready (ref, method) rows for coir cross-reference
    press: (ref, o = {}) => { const { captureNetwork, ...pageOpts } = o || {}; return mutate(() => ev(([r, oo]) => window.__copse.press(r, oo), [ref, pageOpts]), captureNetwork); },
    call: (sel, ...a) => mutate(() => ev(([s, a]) => window.__copse.call(s, ...a), [sel, a])),
    // Arbitrary expression eval in the cc frame's MAIN WORLD (global scope) — NO pause, unlike the
    // CDP eval_frame (which needs a breakpoint and freezes the renderer). Runs via indirect eval so
    // cc / window / window.__copse / cc.find are all in reach; a returned thenable is awaited; the
    // value is coerced to a JSON-safe form so a non-serialisable return doesn't blow up the bridge.
    eval: (expr) => ev((code) => {
      const wrap = (v) => { let value = v; try { JSON.stringify(v); } catch { try { value = String(v); } catch { value = '[unserializable]'; } } return { ok: true, value }; };
      // Auto-wrap top-level `await` in an async IIFE (SUGGESTIONS #5) so `await fetch(...)` etc. just work
      // instead of "await is only valid in async functions". Try the expression form first (returns the
      // value of a single `await x`); on a SyntaxError (multi-statement body) fall back to a block IIFE.
      const run = (src) => (0, eval)(src);
      const evalCode = () => {
        if (!/\bawait\b/.test(code)) return run(code);
        try { return run('(async()=>{ return (' + code + '\n); })()'); }
        catch (e) { if (e instanceof SyntaxError) return run('(async()=>{ ' + code + '\n})()'); throw e; }
      };
      try {
        const r = evalCode();
        return (r && typeof r.then === 'function') ? r.then(wrap, (e) => ({ ok: false, error: (e && e.message) || String(e) })) : wrap(r);
      } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
    }, expr),
    get: (sel) => ev((s) => window.__copse.get(s), sel),
    // Best-effort reachability. Default: cheap touch z-order → { reachable, blockedBy, visible, occludedBy }.
    // {visual:true} ALSO runs the pixel pass and returns the full "usable" verdict (reach ∧ what's on screen)
    // — the old reachable_visual, folded in. `usable` is three-state; pass a `baseline` (from visual_baseline)
    // to confirm the node's OWN art rather than just "something is drawn".
    reachable: async (sel, o = {}) => {
      const r = await ev((s) => window.__copse.reachable(s), sel);
      if (!o || !o.visual) return r;
      const v = await cp.visualCheck(sel, o);
      const usable = r.reachable === false ? false          // a confident block → not usable
        : r.reachable !== true ? 'unknown'                  // 'unsure' → copse couldn't tell; never a hard false
          : v.visible === false ? false
            : v.clear === true ? true
              : v.clear === false ? false
                : v.drawn === false ? false
                  : 'unknown';                              // reachable+visible but no baseline to confirm the art
      return { ...r, usable, visual: v };
    },
    node: (sel) => ev((s) => window.__copse.node(s), sel),
    diff: (a, b) => ev(([a, b]) => window.__copse.diff(a, b), [a, b]),
    listeners: (sel) => ev((s) => window.__copse.listeners(s), sel),   // user node.on() handlers (best-effort)
    // one-call bearings after connect: scene + engine + framework caps + pressable entry points + a hint.
    orient: async () => {
      const o = await ev(() => window.__copse.orient());
      try { o.url = page.url(); } catch { o.url = null; }
      const fw = o.framework || {};
      o.hint = (fw.kind === 'none' && !fw.registered)
        ? 'no framework adapter loaded → app-layer state (pm_*) is unreachable; register_framework / copse.frameworks.mjs if this game uses PureMVC'
        : (o.entryPoints && o.entryPoints.length ? 'press an entryPoint, or read state with get / pm_get' : 'no reachable buttons yet — snapshot / wait for the scene to settle');
      return o;
    },
    probe: () => ev(() => window.__copse.probe()),                     // engine-coupling self-diagnostic (version + per-capability resolution)
    // console + page errors (all frames), server-side filtered (grep/level/tail/since) so a chatty
    // game doesn't blow the caller's token budget; a bare number stays `since`-index for back-compat.
    logs: (arg = 0) => filterLogs(logs, arg),
    network: (arg = {}) => filterNet(net, arg),           // captured requests (url/status/payload), filtered like logs
    // diff-only state timeline over time — one in-page evaluate runs the whole poll loop (SUGGESTIONS #1).
    // captureNetwork:true attaches the CDP requests fired during the watch window (SUGGESTIONS #7).
    watch: async (o) => {
      o = o || {};                                          // guard: a null opts must not reach the in-page destructure
      const netWin = o.captureNetwork ? [] : null; if (netWin) netWindows.add(netWin);
      let r;
      try { r = await ev((oo) => window.__copse.watch(oo), o); }
      finally { if (netWin) netWindows.delete(netWin); }
      if (netWin && r && typeof r === 'object' && netWin.length) r.network = netWin.map((x) => ({ ...x }));
      return r;
    },
    // wrap/restore a live component method to verify a fix before rebuilding (SUGGESTIONS #3). hooks =
    // { before?, after?, replace?, trace? } — before/after/replace are JS fn-expr SOURCE strings (compiled
    // in-page); trace:true records each call's args/ret/timing, read back via patchCalls.
    patch: (sel, hooks) => ev(([s, h]) => window.__copse.patch(s, h), [sel, hooks ?? {}]),
    patchClear: (sel) => ev((s) => window.__copse.patch_clear(s || undefined), sel ?? null),
    hold: (sel, opts) => ev(([s, o]) => window.__copse.hold(s, o), [sel, opts ?? {}]),   // freeze the loop at a trigger (SUGGESTIONS C1)
    release: () => ev(() => window.__copse.release()),
    holdStatus: () => ev(() => window.__copse.hold_status()),
    patchCalls: (sel) => ev((s) => window.__copse.patch_calls(s), sel),   // a trace:true patch's recorded calls

    // framework-aware state access (PureMVC etc.) — reach logic state OUTSIDE the cc tree (SUGGESTIONS #4).
    framework: () => ev(() => window.__copse.framework()),
    // add an adapter mid-session: ALSO persist it into fwAdapters so the auto-reboot / reload() re-injects it
    // (otherwise pm_* silently goes dark after a navigation). Serialize object code-adapters so functions survive.
    registerFramework: (a) => { fwAdapters.push(a); return ev((x) => window.__copse.registerFramework(x), adapterToInjectable(a)); },
    // pm ACTUATIONS (pmSet / pmCall / pmNotify) run through `mutate` — same as press/call — so they carry
    // `errors` (a crashing flow → run_script's errors gate fires, not a false green PASS) and `changed`.
    // pmGet (a READ) and pmPatch (installing a wrapper, like cc `patch`) don't actuate → stay direct.
    pmGet: (sel) => ev(([s]) => window.__copse.pmGet(s), [sel]),
    pmSet: (sel, value) => mutate(() => ev(([s, v]) => window.__copse.pmSet(s, v), [sel, value])),
    pmCall: (sel, ...args) => mutate(() => ev(([s, a]) => window.__copse.pmCall(s, a), [sel, args])),
    pmPatch: (sel, hooks) => ev(([s, h]) => window.__copse.pmPatch(s, h), [sel, hooks ?? {}]),   // patch a proxy/mediator/command method
    pmNotify: (name, body, type) => mutate(() => ev(([n, b, t]) => window.__copse.pmNotify(n, b, t), [name, body, type])), // fire a notification
    // on-demand screenshot (SUGGESTIONS #8): pair a logic state with what's on screen. `selector` clips to a
    // node's screen rect via the SAME `visualManifest` projection visual_check signs through (one projection,
    // viewport CSS px, resolution-policy correct) — best-effort, falls back to full frame; `path` writes a PNG.
    screenshot: async (o = {}) => {
      let clip = null;
      if (o.selector) {
        try {
          const m = await ev((s) => (window.__copse.visualManifest ? window.__copse.visualManifest(s) : null), o.selector);
          const r = m && m.rect;
          if (r) {
            // the manifest rect is iframe-LOCAL; page.screenshot clips in TOP-page coords — add the cc frame's
            // offset (visualSig does the same). If the offset is unknown (OOPIF), fall back to full frame rather
            // than clip the wrong region.
            const foff = await ccFrameOffset();
            if (foff) clip = { x: r.x + foff.x, y: r.y + foff.y, width: r.w, height: r.h };
          }
        } catch { clip = null; }
      }
      if (clip && !(clip.width > 0 && clip.height > 0 && clip.x >= 0 && clip.y >= 0)) clip = null;
      const b64 = await page.screenshot({ encoding: 'base64', ...(clip ? { clip } : {}) });
      if (o.path) { writeFileSync(o.path, Buffer.from(b64, 'base64')); return { ok: true, path: o.path, clipped: !!clip }; }
      return { base64: b64, mimeType: 'image/png', clipped: !!clip };
    },
    // Node-anchored VISUAL check — the pixel complement to the logic tree. `drawn` catches "tree says
    // active, screen is empty"; with a golden `baseline` signature (from captureBaseline), `matches`/`clear`
    // confirm the node's OWN art is what's visible (closing reachable's opaque-sprite occlusion blind spot).
    // Three-state {drawn,matches,clear,score?,visible,via,reason?}, same grammar as reachable.
    visualCheck: async (ref, o = {}) => {
      const { manifest, sig, reason } = await visualSig(ref, o);
      const v = visualVerdict({ ref: (manifest && manifest.ref) || ref, sig, baseline: o.baseline, rect: manifest && manifest.rect, masked: (manifest && manifest.maskRects) || [], via: manifest && manifest.via, matchThreshold: o.matchThreshold, detailThreshold: o.detailThreshold });
      if (manifest) v.visible = manifest.visible;
      if (reason) v.reason = reason; // the driver's reason (offscreen/degenerate-rect/screenshot-failed) is more specific than verdict's generic 'no-signature'
      return v;
    },
    // Golden per-node baseline on the CURRENT (known-good) screen → { ref: signature[] }. Feed an entry back
    // as visualCheck({baseline}) later to detect a node that stopped rendering / got occluded / changed.
    // Per-node (not full-frame), so it survives animation/RNG — dynamic descendants are masked out.
    captureBaseline: async (o = {}) => {
      const refs = o.refs || (await ev(() => window.__copse.interactive().map((d) => d.ref)));
      const out = {};
      for (const ref of refs) { const { sig } = await visualSig(ref, o); if (sig) out[ref] = Array.from(sig); }
      return out;
    },
    // attach mode drives the user's own browser → disconnect, don't close it.
    // `paused`: attached while the renderer is HALTED (debugger) → inject deferred until resume.
    // `stalled`: init didn't settle in time (game on a loading/intro screen) → __copse usually already up.
    // NOTE (contract change): `paused` USED to mean "inject deferred for ANY reason"; it now means the
    // debugger case ONLY. A consumer that gated on `paused` to wait for the game to be live must now gate on
    // `!paused && !stalled` (a stalled/loading tab reads paused:false), or it will act on a not-yet-ready tree.
    // list all open tabs in the attached/launched browser → {index,url,title,active} (SUGGESTIONS B4).
    // Pre-attach reconnaissance (which of several look-alike tabs to match) and post-attach sanity.
    tabs: () => listTabs(browser),
    // which tab attach chose ({url,title,index,of}; null when launched) — surfaced so a wrong pick shows now.
    attachedTab,
    page, get frame() { return frame; }, browser, ready, paused, stalled,
    close: () => (opts.attach ? browser.disconnect() : browser.close()),
  };
  return cp;
}
