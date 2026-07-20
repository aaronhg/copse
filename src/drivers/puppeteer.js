// NOTE: intentionally NOT `// @ts-check` — this file is browser-driver glue; its
// `page.evaluate` callbacks run in the GAME's window (where `window.__copse`/`cc` live),
// so type-checking them against Node's lib produces only false positives.
// OPTIONAL driver (subpath `copse/driver-puppeteer`). Drives a running Cocos/Pixi game in a
// real browser (system Chrome via puppeteer-core), injects copse, and returns a Driver for
// `execute` (or a consumer's own loop, e.g. arbor). NOT loaded by `import 'copse'` — keeps the
// core zero-dep. Needs the peer dep `puppeteer-core` and a built `dist/copse.inject.js`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { diff as coreDiff } from '../core/index.js';
import { engineCapabilities } from '../capabilities.js';
import { signature, visualVerdict } from '../sensors/pixel.js';
import { parseDur } from '../core/eval-cond.js';   // pure duration grammar ('2m'/'500ms'/n) — same one the in-page watch loop parses with

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Failures carry a machine-readable class next to the prose. `recoverable` = "the same call, made again,
// may just work — nothing needs a human first". Prose alone is readable but un-actionable: run_script has
// no retry and stops at the first failed step, and neither it nor an agent can tell "retry me" from "your
// selector is wrong" by string-matching a sentence. (the field report asked for this
// flag; the first pass shipped only the sentences.)
// Deliberately NOT recoverable: anything a retry would merely repeat — a match that matches nothing, an
// ambiguous match, a wedged renderer (retrying just re-hangs for another opTimeout).
// `copse: true` brands it as OURS. `code` is Node's own errno convention on Error, so harvesting any `.code`
// meant puppeteer's ECONNREFUSED surfaced to an agent as `✗ [ECONNREFUSED] …` — indistinguishable from the
// vocabulary this flag exists to define. A class you don't control the namespace of isn't a class.
const err = (message, { recoverable = false, code } = {}) => Object.assign(new Error(message), { copse: true, recoverable, ...(code ? { code } : {}) });

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

// EVERY CDP read against a not-yet-chosen tab is race-bounded: a tab halted at a breakpoint answers
// nothing, and one unbounded await hangs the whole scan. `title()` used to be exactly that hole — it sat
// un-raced right next to a carefully raced evaluate, so a paused tab hung the scan the race was there to
// prevent. Bound both, and default rather than throw: a tab we can't read is a tab we don't pick.
const PROBE_MS = 800;
const probeTab = (pg, fn, dflt) => Promise.race([Promise.resolve().then(() => pg.evaluate(fn)).then((v) => v, () => dflt), sleep(PROBE_MS).then(() => dflt)]);
// null when the tab wouldn't answer in time — NOT ''. title() is an evaluate under the hood, so a tab whose
// main thread is busy (a Cocos loading screen doing heavy synchronous work — precisely when you attach) loses
// the race. Defaulting that to '' made a title-based `match` silently miss the tab AND then list it back to
// the user as "(no title)": a guess laundered into a fact, telling them to fix a match that was correct.
// The bound itself has to stay — an unbounded title() let one paused tab hang the whole scan.
// Its own budget, wider than PROBE_MS: title() is instant on a free main thread, so the bound only ever
// bites when the thread is busy with synchronous work (a loading screen's parse/compile bursts) — and at
// 800ms a burst-heavy tab could fail all 8 attach tries. 2.5s per probe still can't hang the scan (probes
// run in parallel) but rides out a burst; a tab busy CONTINUOUSLY beyond that gets the unreadable-title
// note in the failure rather than a silent miss.
const TITLE_MS = 2500;
const titleOf = (pg) => Promise.race([Promise.resolve().then(() => pg.title()).then((v) => v, () => null), sleep(TITLE_MS).then(() => null)]);
const showTitle = (t) => (t === null ? '(title unreadable — tab busy or paused)' : (t || '(no title)'));

// Enumerate a browser's open tabs → [{index,url,title,active}] (active = visible + focused). No injection,
// no navigation — safe reconnaissance. Probes run in PARALLEL and are each race-bounded, so N tabs cost
// ~one probe window, not N of them, and no single tab can hang the scan.
export async function listTabs(browser) {
  const pages = await browser.pages();
  return Promise.all(pages.map(async (pg, index) => ({
    index, url: pg.url(), title: await titleOf(pg),
    active: await probeTab(pg, () => document.visibilityState === 'visible' && document.hasFocus(), false),
  })));
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
 * Launch (or connect to) a browser, load the game, inject copse → a Driver for `execute`
 * (or a consumer's loop). The returned object is the Driver (snapshot/interactive/press/get/call/eval/
 * reachable/node/diff/listeners/probe/logs/watch/patch/patchClear/framework/pmGet/pmSet/pmCall/network/
 * screenshot) plus `page`, `frame` (the frame cc was found in — may be a
 * nested/cross-origin iframe), `browser`, and `close()`.
 * @param {string} url
 * @param {{engine?:'cocos'|'pixi', bundlePath?:string|URL, executablePath?:string, browserURL?:string, browserWSEndpoint?:string, attach?:boolean, match?:string, pick?:number, attachTries?:number, headless?:any, viewport?:any, fpsCap?:number, timeout?:number, bootTries?:number, rebootTries?:number, readyTries?:number, readyTimeout?:number, installTimeout?:number, opTimeout?:number, rebootCooldown?:number, pauseProbeMs?:number, injectStallMs?:number, frameworks?:any[], maxLogs?:number, maxNet?:number, settle?:boolean|{maxMs?:number,interval?:number}}} [opts]
 *        `engine` picks the lane: 'cocos' (default), 'pixi', or 'auto' to detect from the page. See
 *        docs/ENGINES.md — the resolved value and what it implies are readable as cp.engine/cp.capabilities.
 *        The waits, and why each is the size it is. The rule they all follow: fail LOUD rather than long —
 *        a clear failure you can retry beats a silent wait you can't read (DEVELOPMENT.md §25F has the measured before/after).
 *        attachTries (8): seconds to wait for a tab matching `match` to appear. Short because the usual
 *        cause is a match that matches nothing, and the failure lists every open tab so you can fix it.
 *        bootTries (40): seconds to find a frame with a live cc scene on a COLD connect — a game may be
 *        booting from nothing, and this is the one wait worth being patient for.
 *        rebootTries (15): the budget for EACH wait phase of a reboot after a navigation detached us. The
 *        game was alive moments ago, so this is deliberately much shorter; a failed reboot is recoverable
 *        (see rebootCooldown), so undershooting costs one visible retry, not a wedged session.
 *        installTimeout (10000): ms for the injected bundle to expose window.__copse.
 *        readyTries (25): seconds for the engine to build a scene on a cold boot — NOT a hard gate, it
 *        falls through (a scene that never appears is the caller's to judge via snapshot/orient).
 *        readyTimeout (5000): ms an in-page call waits on unfinished init before saying which phase it's
 *        in and handing back control. Short by design — init keeps running, so retrying is the fix; the
 *        old unbounded wait turned a halted renderer into a silent 32-minute hang. Raise it to block instead.
 *        opTimeout (60000): ms ANY in-page call may take before failing loud. Most ops are milliseconds, so
 *        it never fires for them and only caps a hang: without it a renderer that wedges AFTER connect (a
 *        breakpoint mid-session) hung every call forever. `eval` can pass its own `{timeout}`, and `watch`
 *        derives one from its own duration — those are the ops allowed to be legitimately long.
 *        injectStallMs (= readyTimeout): ms connect waits on init before returning stalled:true. One
 *        number for "how long before copse says it isn't ready", whichever way you ask.
 *        rebootCooldown (2000): ms after a failed (re)connect during which calls fail fast with that
 *        reason instead of re-paying the boot budget each time. A navigation cancels it — the world
 *        just changed, so the retry is worth making now.
 *        attach: drive an ALREADY-OPEN tab in `browserURL`'s Chrome (find it by `match` URL
 *        substring; omit match+url to attach the ACTIVE tab; no navigation — for your own game
 *        behind a login/staging gate you opened yourself, so a fresh goto won't bounce you back to
 *        it). `close()` then just disconnects, leaving your browser open.
 *        settle: after a mutating press/call, wait until the tree stabilises (tweens) then
 *        attach a `changed` auto-diff to the result. Default on; `settle:false` to disable.
 *        engine: 'cocos' (default) or 'pixi' (PixiJS 8 — docs/ENGINES.md). Picks the bundle and the
 *        boot probes. For 'pixi' the bundle is injected PRE-BOOT (evaluateOnNewDocument) because
 *        Pixi's `__PIXI_APP_INIT__` hook fires once during Application.init and is otherwise missed;
 *        `press` is async there, and `clickSurface`/coverage are unavailable (§5) while `anchors()` is.
 */
export async function connect(url, opts = {}) {
  const puppeteer = await loadPuppeteer();
  // WHICH ENGINE. copse drives Cocos (default) or PixiJS 8 (docs/ENGINES.md). The engine decides the
  // bundle, how the page is probed for a live engine, how fps is capped, and — for Pixi — WHEN the
  // bundle is injected (see the pre-boot injection below, which is a structural difference, not a flag).
  const engineOpt = opts.engine || 'cocos';
  if (!['cocos', 'pixi', 'auto'].includes(engineOpt)) throw new Error(`unknown engine ${JSON.stringify(engineOpt)} — expected 'cocos', 'pixi' or 'auto'`);
  // 'auto' resolves DURING boot by probing the live page, so `engine` starts null and the rest of the
  // driver reads it through isPixi(). Everything that branches on the engine runs after bootInPage.
  const auto = engineOpt === 'auto';
  let engine = auto ? null : engineOpt;
  let engineDetected = !auto;
  let engineResolved = !auto;   // has bootInPage actually decided yet? (auto + attach can return first)
  const isPixi = () => engine === 'pixi';
  let installed = false;   // did `__copse` actually come up? false = no engine on the page (doctor's finding)
  const BUNDLE_FILE = { cocos: 'copse.inject.js', pixi: 'copse.inject.pixi.js' };
  const bundleCache = {};
  // `bundlePath` names ONE bundle; `auto` may need EITHER. Rather than silently guessing which engine
  // the caller's bundle is for (and then failing deep inside boot), refuse the combination up front.
  // `doctor` correspondingly only forces auto when no bundlePath was given — the earlier version
  // forced it unconditionally, so `doctor --bundlePath …` always died with "run `npm run build` first
  // (or pass bundlePath)", contradicting the invocation the user had just typed.
  if (opts.bundlePath && auto) {
    throw new Error("bundlePath pins a single inject bundle, so it can't be combined with engine:'auto' — pass engine:'cocos' or engine:'pixi' alongside it.");
  }
  const bundleFor = (e) => {
    if (bundleCache[e]) return bundleCache[e];
    const file = BUNDLE_FILE[e];
    const path = opts.bundlePath || new URL(`../../dist/${file}`, import.meta.url);
    try { return (bundleCache[e] = readFileSync(path, 'utf8')); }
    catch (err) {
      if (err && err.code === 'ENOENT') throw new Error(`copse inject bundle not found at ${opts.bundlePath ? String(path) : `dist/${file}`} — run \`npm run build\` first (or pass bundlePath)`);
      throw err;
    }
  };
  // READ EVERY BUNDLE THIS RUN MIGHT NEED, NOW — before a browser exists. The read used to be the
  // first statement of connect() precisely so a missing dist/ fails before a process is spawned;
  // moving it into bundleFor put it after puppeteer.launch(), where the throw unwinds past the only
  // reference to `browser` and leaves an orphaned headless Chrome behind on every failed run. Under
  // auto that means BOTH bundles: the pixi one is pre-injected, and either may be chosen at boot.
  if (auto) { bundleFor('pixi'); bundleFor('cocos'); } else bundleFor(engine);
  const remote = opts.browserURL || opts.browserWSEndpoint;
  // guard BEFORE creating a browser, so a misconfigured attach never leaks a launched one.
  if (opts.attach && !remote) throw new Error('attach mode needs browserURL/browserWSEndpoint — start Chrome with --remote-debugging-port=9222');
  const browser = remote
    ? await puppeteer.connect({ browserURL: opts.browserURL, browserWSEndpoint: opts.browserWSEndpoint, defaultViewport: null })
    : await puppeteer.launch({ executablePath: opts.executablePath || DEFAULT_CHROME, headless: opts.headless ?? 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--mute-audio'] });

  // Give the browser back before rethrowing. A connect that throws AFTER the browser exists used to just
  // leak it: in attach mode that's a live CDP websocket that keeps the CALLER's process alive forever (a
  // failed connect made plain `node` hang at exit — an infinite wait hiding behind a clean error message),
  // and in launch mode it's an orphaned Chrome. Every post-browser throw in this function goes through
  // here; keep it that way if you add another.
  const bail = async (e) => {
    try { if (opts.attach) browser.disconnect(); else await browser.close(); } catch { /* the original failure is the one worth reporting */ }
    throw e;
  };
  // Wrap anything that can throw between here and the `cp` return. The comment above used to claim every
  // post-browser throw went through bail while three of them didn't — including page.goto, which fails on
  // the single most common mistake there is (dev server not running). A claimed invariant that the code
  // doesn't keep is worse than no invariant: it stops anyone from checking.
  const guard = async (fn) => { try { return await fn(); } catch (e) { return await bail(e); } };

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
    // Probe every tab CONCURRENTLY (each still race-bounded): the scan cost is one probe window, not one
    // per tab. Sequentially this was ~1.6s × tabs before attach could even start.
    const activeTab = async (pages) => {
      const vis = (await Promise.all(pages.map((pg) => probeTab(pg, () => document.visibilityState, 'hidden'))))
        .map((v, i) => (v === 'visible' ? pages[i] : null)).filter(Boolean);
      const focused = await Promise.all(vis.map((pg) => probeTab(pg, () => document.hasFocus(), false)));
      const i = focused.indexOf(true);
      return (i >= 0 ? vis[i] : vis[0]) || pages[0] || null;
    };
    // Short budget on purpose. This loop exists for a real race (copse starts, you open the game a moment
    // later), but the overwhelmingly common failure is a `match` that doesn't match anything — and 30s of
    // silence is a terrible way to be told about a typo when the tab list is right there, known, the whole
    // time. Wait briefly, then FAIL with what's actually open (below) so the fix is one edit, not one
    // `list_tabs` round trip.
    for (let i = 0, n = opts.attachTries ?? 8; i < n && !page; i++) {
      const pages = await browser.pages();
      if (conds.length) {
        // Collect ALL matches (url + title) — a lone `.find()` silently grabbed the FIRST, so two builds
        // sharing a url fragment connected to the wrong one, discovered late. >1 match is an ambiguity.
        const rows = await Promise.all(pages.map(async (pg) => ({ pg, url: pg.url(), title: await titleOf(pg) })));
        const cand = rows.filter((r) => condMatch(conds, r.url, r.title));
        if (cand.length > 1 && opts.pick == null) {
          await bail(err(`attach: ${cand.length} open tabs match ${shown} — narrow the match (a list ANDs, title matches too) or pass pick:<index>:\n`
            + cand.map((c, k) => `  [${k}] ${showTitle(c.title)} — ${c.url}`).join('\n'), { code: 'ambiguous-tab' }));
        }
        const chosen = cand[opts.pick || 0];
        if (chosen) { page = chosen.pg; attachedTab = { url: chosen.url, title: chosen.title ?? '', index: opts.pick || 0, of: cand.length }; }
      } else {
        page = await activeTab(pages);
        if (page) attachedTab = { url: page.url(), title: (await titleOf(page)) ?? '', index: 0, of: 1, active: true };
      }
      if (!page) await sleep(1000);
    }
    if (!page) {
      // Name what IS open. We just spent the whole budget looking at these tabs, so making the caller run
      // `list_tabs` to find out why the match missed is withholding an answer we already have.
      const open = await listTabs(browser).catch(() => []);
      const list = open.length
        ? '\n  open tabs:\n' + open.map((t) => `    [${t.index}]${t.active ? ' (active)' : ''} ${showTitle(t.title)} — ${t.url}`).join('\n')
        : ' (that Chrome has no tabs open)';
      // Don't tell someone their title match is wrong when we simply couldn't read the titles.
      const blind = conds.some((c) => c.field === 'title') && open.some((t) => t.title === null)
        ? '\n  NOTE: at least one tab did not report a title in time, so a title match cannot rule it out — match on url instead, or retry once the tab settles.' : '';
      await bail(err(conds.length
        ? `attach: no open tab matching ${shown} after ${opts.attachTries ?? 8}s — fix the match (a list ANDs; title matches too), or open the game in that Chrome.${list}${blind}`
        : `attach: no usable tab in that Chrome — open the game first.${list}`, { code: 'no-tab' }));
    }
  } else {
    page = await guard(() => browser.newPage());
    await guard(() => page.setViewport(opts.viewport || { width: 414, height: 896, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }));
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

  // PIXI: inject BEFORE the page's own scripts run. The reliable attach is Pixi core's
  // `__PIXI_APP_INIT__` hook, which fires once during Application.init and is simply MISSED if the
  // bundle lands afterwards — so unlike Cocos (where we poll for `cc` post-load) the Pixi bundle must
  // go in via evaluateOnNewDocument. Bonus: that registration survives navigations, so `reload()` and
  // the auto-reconnect path re-arm the hook for free. In ATTACH mode the page is already loaded and
  // this can't have run, so bootInPage falls back to injecting directly + findPixi's ladder.
  // In AUTO we arm it unconditionally: detection can only happen after load, but the hook must be in
  // place before it — so the cheap insurance is to pre-inject the Pixi bundle either way. On a Cocos
  // page it finds no Application, its bounded poll expires, and the Cocos bundle installs `__copse`
  // over it. That ~57kb of dead weight is why 'auto' is opt-in rather than the default for connect().
  if (isPixi() || auto) { try { await page.evaluateOnNewDocument(bundleFor('pixi')); } catch { /* attach-mode targets may refuse */ } }

  // guard(): the most common connect failure of all (dev server down / a url that times out) — it must
  // not orphan the Chrome we just launched.
  if (!opts.attach) await guard(() => page.goto(url, { waitUntil: 'load', timeout: opts.timeout ?? 60000 }));

  // Find the frame that has cc — the game is often inside a (possibly nested, possibly
  // cross-origin) iframe. page.frames() gives EACH frame its own evaluate context, so
  // cross-origin works here (unlike in-page JS, which SOP blocks). Drive that frame.
  // 'ready' (an engine + a built scene/stage) | 'booting' (the engine is live but has nothing up yet) |
  // 'none' (no engine at all). The booting/none split is what lets the find-loop below tell "wait, it's
  // coming" from "nothing here", which are worth very different amounts of patience.
  // try/catch, NOT .catch(): a detached frame's evaluate throws SYNCHRONOUSLY (puppeteer guards the call
  // before it ever returns a promise), so the throw sails straight past a .catch() and out of the loop
  // that calls this. A frame can detach between page.frames() and this call on any reloading page — i.e.
  // routinely, in the build→reload loop copse is driven in.
  // RACE-BOUNDED, like every other probe against a frame we don't control yet. A halted renderer answers
  // an evaluate with neither a value NOR a throw — so an un-raced `await` here hung the find-loop forever,
  // and findMs (checked only between iterations) could never fire. That put the 32-minute silent hang
  // straight back into the recovery path this file exists to make safe: boot fails → bootFailed → next
  // call reboots → find-loop → hang, with opTimeout powerless because it wraps the evaluate, not this.
  // Verified before fixing: an op with opTimeout:4000 was still hanging at 12s.
  const PROBE_MS = 2000;   // generous for a property read (+ a possible System.import), still finite
  // "The renderer is halted" is a claim about the WHOLE tab, so it needs evidence from the whole tab: only
  // if nothing answered and something timed out. A latch on "any frame was ever slow" is not that — one
  // sluggish foreign iframe (ads/analytics/payments, and an editor preview is itself a cross-origin iframe)
  // would convict the renderer, turning a recoverable mid-rebuild `no-engine` into `renderer-silent`, which
  // is NOT recoverable and tells the caller to go resume a debugger that was never paused.
  // The bias is deliberate: calling a halted renderer `no-engine` costs one pointless retry, while calling a
  // mid-rebuild `renderer-silent` stops run_script dead and sends a human hunting a breakpoint. A throw
  // counts as an answer — it means something is alive enough to refuse us.
  let probeAnswered = false, probeTimedOut = false;
  // One race, both engines: the bound is a property of the FRAME (is this renderer answering at all?), not
  // of which engine we're asking about, so cocos and pixi must not each grow their own copy of it.
  const probe = async (f, fn) => {
    let timer;
    try {
      return await Promise.race([
        f.evaluate(fn).then((v) => { probeAnswered = true; return v; }),
        new Promise((res) => { timer = setTimeout(() => { probeTimedOut = true; res('none'); }, PROBE_MS); }),
      ]);
    } catch { probeAnswered = true; return 'none'; }
    finally { clearTimeout(timer); }   // the evaluate won → the timer must not fire and claim silence
  };
  const ccState = (f) => probe(f, async () => {
    let cc = window.cc;
    if ((!cc || !cc.director) && window.System) { try { cc = (await System.import('cc')).default || await System.import('cc'); } catch {} }
    if (!(cc && cc.director && cc.director.getScene)) return 'none';
    window.cc = cc; const s = cc.director.getScene();
    return (s && (s.children || []).length) ? 'ready' : 'booting';
  });
  // Pixi's equivalent: an Application with a populated stage, from the init-hook capture or any of the
  // devtools globals (the bundle's own findPixi ladder covers the same ground once it's installed).
  // An app with an EMPTY stage is 'booting' for the same reason a sceneless cc.director is — Application
  // .init has run but the game hasn't put anything on screen yet, and that is worth waiting through.
  const pixiState = (f) => probe(f, () => {
    const app = (window.__copse && window.__copse.app)
      || (window.__copsePixi && window.__copsePixi.app)
      || (window.__PIXI_DEVTOOLS__ && window.__PIXI_DEVTOOLS__.app)
      || window.__PIXI_APP__;
    if (!(app && app.stage)) return 'none';
    return (app.stage.children || []).length ? 'ready' : 'booting';
  });
  // In AUTO, probe both and let the page decide; the engine that answers is the answer. Cocos is tried
  // first only because it's the primary lane, and the two are mutually exclusive in practice (a Pixi page
  // has no `window.cc`). A 'booting' cocos answer still short-circuits: it means cc IS there.
  const engineState = async (f) => {
    if (!auto) return { state: await (isPixi() ? pixiState(f) : ccState(f)), engine };
    const cc = await ccState(f);
    if (cc !== 'none') return { state: cc, engine: 'cocos' };
    const px = await pixiState(f);
    return { state: px, engine: px === 'none' ? null : 'pixi' };
  };

  let frame = page.mainFrame();
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
  const fwAdapters = await guard(() => resolveFrameworks(opts));   // a typo'd --framework path throws here, post-browser

  // Find the cc frame → inject the bundle → install __copse → settle to a UI scene. Factored out so
  // `cp.reload()` can re-run it after a navigation (a reload replaces the frames + wipes __copse).
  // Init progress, published so a caller kept waiting is TOLD which phase is slow rather than just made
  // to wait. The reported session's core complaint wasn't the waiting, it was that 32 minutes of silence
  // gave it no way to tell "game stuck" from "script wrong" from "connection dead".
  let bootPhase = 'starting', bootAt = Date.now();
  // Poll granularity for the find/scene waits. The BUDGETS below stay in seconds (bootTries/readyTries are
  // ~1s counts, and are public options), but a healthy reboot finds the engine in ~2ms and shouldn't pay up
  // to a full second of dead sleep to notice.
  const POLL = 250;
  // The diagnosis for "this page has no engine on it", kept as one string because it is thrown from the
  // find phase AND quoted by doctor. It used to be a bare `Cannot read properties of undefined (reading
  // 'snapshot')` from the first read, which is both useless and hides the finding the caller needs.
  // The "what to do about it" half is IDENTICAL for both ways a page can turn out to have no engine
  // (nothing answered the find probe; __copse never installed), so it is written once — two copies of a
  // user-facing paragraph drift silently, and only one of them ever gets the fix.
  const NO_ENGINE_HELP = 'Looked for a live cc.director scene and a Pixi Application (init hook / __PIXI_APP__ / devtools globals). '
    + 'If this is a Pixi game you ATTACHED to after load, reconnect with engine:"pixi" so the pre-boot hook can arm; '
    + 'if it is a release Cocos build, `cc` may be tree-shaken away (docs/INJECT.md). Run `doctor` for the full report.';
  const noEngineMsg = (findMs) => `copse: no frame in this tab has a live ${auto ? 'engine' : engine} after ${Math.round(findMs / 1000)}s (phase=finding-engine). `
    + 'The tab is probably still loading, on the wrong page, or the build is mid-rebuild — retry once the game is up. '
    + NO_ENGINE_HELP;
  // findMs/sceneMs are passed per-boot so a REBOOT can be impatient where a cold boot must not be — same
  // code, different patience. See reboot() below for why.
  const bootInPage = async ({ findMs = (opts.bootTries ?? 40) * 1000, sceneMs = (opts.readyTries ?? 25) * 1000 } = {}) => {
    bootPhase = 'finding-engine'; bootAt = Date.now(); probeAnswered = false; probeTimedOut = false;
    let found = null, booting = null, foundEngine = null, bootingEngine = null;
    for (let t0 = Date.now(); Date.now() - t0 < findMs && !found;) {
      booting = null; bootingEngine = null;
      for (const f of page.frames()) {
        // The budget has to be checked HERE too, not just between rounds: each probe can cost the full
        // PROBE_MS, so a page with several unresponsive frames overshoots findMs by a whole round.
        if (Date.now() - t0 >= findMs) break;
        const st = await engineState(f);
        if (st.state === 'ready') { found = f; foundEngine = st.engine; break; }
        if (st.state === 'booting' && !booting) { booting = f; bootingEngine = st.engine; }
      }
      if (!found && Date.now() - t0 < findMs) await sleep(POLL);   // don't sleep out a budget that's already spent
    }
    // No scene yet but the engine IS live → drive that frame anyway and let the install wait below cover the
    // last stretch of the engine's boot (the bundle self-installs once the engine is reachable). Note this
    // now picks the frame that actually HAS the engine; the old fall-through injected into page.mainFrame()
    // regardless, which is simply the wrong frame when the game is in an iframe.
    if (found || booting) {
      frame = found || booting;
      // In `auto`, whichever probe answered IS the answer — record it before anything branches on isPixi().
      const e = foundEngine || bootingEngine;
      if (auto && e) { engine = e; engineDetected = true; }
    }
    // But if NOTHING answered, injecting anywhere is hopeless — we just spent the entire find budget
    // proving no engine is in this tab, and waiting another installTimeout for a __copse that cannot appear
    // adds silence to a question already answered. Say so instead. (Measured: this alone was 10s of the
    // 25s a single op paid after a reload landed mid-rebuild.)
    //
    // This MUST throw rather than return a degraded session: a boot that returns leaves `frame` anchored to
    // page.mainFrame() — a perfectly LIVE frame with no game on it. Nothing about it is "detached", so
    // isDetached() never fires, reboot is never retried, and the session stays broken even after the game
    // comes back healthy. Throwing is what lets trackBoot record it and the next call retry. See the
    // bootFailed note below; pinned by test/driver-reconnect.l2.test.js.
    //
    // "no engine here" and "nobody answered" are different answers and must not share one message: a silent
    // frame is a renderer that isn't running JS at all, which retrying cannot fix (hence not recoverable).
    else if (!probeAnswered && probeTimedOut) { engine = engine ?? 'cocos'; engineResolved = true; throw err(`copse: no frame in this tab answered an engine probe within ${Math.round(findMs / 1000)}s (phase=finding-engine) — the renderer isn't running JS at all, which almost always means it's halted at a breakpoint. Resume the tab, then retry.`, { code: 'renderer-silent' }); }
    // recoverable: the overwhelmingly common cause is a tab that's mid-rebuild or still loading, which
    // fixes itself. It can also be a tab on the wrong page, which won't — but retrying that is cheap and
    // harmless, whereas refusing to retry the common case is what wedged sessions in the first place.
    else { engine = engine ?? 'cocos'; engineResolved = true; throw err(noEngineMsg(findMs), { recoverable: true, code: 'no-engine' }); }
    // Nothing below may still be guessing: fall back to cocos so the rest of the boot (and `doctor`'s
    // report) runs over a defined engine — `engineDetected:false` is what tells a caller the page never
    // identified itself, which for doctor is the single most useful finding it can report.
    if (engine == null) engine = 'cocos';
    engineResolved = true;
    bootPhase = 'injecting';
    // Every remaining boot step is race-bounded like the find phase was — a renderer can halt BETWEEN
    // phases (the probe answers 'booting', then a breakpoint in some component's onLoad fires) and an
    // unbounded evaluate here hung the boot promise forever: sceneMs is only checked between awaits, so it
    // never fired; trackBoot never settled, so bootFailed/cooldown never engaged; and runBoot's queue means
    // every LATER boot waited behind the hung one — every call then died at its own deadline classified as
    // "[recoverable] reconnecting… retry", an agent retried forever, and the one true diagnosis (resume the
    // debugger) never surfaced. A mid-boot hang must FAIL the boot, loudly, with the renderer named.
    const BOOT_STEP_MS = 10000;
    const bootEv = async (fn, ...a) => {
      let timer;
      try {
        return await Promise.race([
          frame.evaluate(fn, ...a),
          new Promise((_, rej) => { timer = setTimeout(() => rej(err(`copse: the renderer stopped answering mid-boot (phase=${bootPhase}) — almost certainly halted at a breakpoint. Resume the tab, then retry.`, { code: 'renderer-silent' })), BOOT_STEP_MS); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    // Cocos: the bundle goes in now (the engine is already up, so there's nothing to pre-arm).
    // Pixi: evaluateOnNewDocument already ran it pre-boot in launch mode — but re-evaluating is
    // idempotent (installInitHook/install both no-op when already present) and is the ONLY path in
    // attach mode, where the page loaded before we ever saw it.
    await bootEv(bundleFor(engine));
    await bootEv((pixi) => {
      if (window.__copse) return;
      if (!window.copse) return;
      if (pixi) window.copse.autoInstall();               // findPixi ladder → install (null-safe)
      // Guard `cc`: on a page with no engine (or a release build that tree-shook it away)
      // install(undefined) dies destructuring `{Button} = cc`, turning "no engine here" into an
      // opaque crash. The bundle's own auto-install already gates on findCC(); this call must too.
      else if (window.cc && window.cc.director) window.copse.install(window.cc);
    }, isPixi());
    // installTimeout:0 must mean "don't wait", NOT "wait forever" — but puppeteer reads timeout:0 as
    // DISABLE THE TIMEOUT, so passing it through inverts the option into an unbounded hang. Skip instead.
    const installMs = opts.installTimeout ?? 10000;
    // waitForFunction THROWS on timeout, so reaching the next line already proves __copse is up — asking
    // the page again would be a second round-trip for an answer we hold. Only the "don't wait" path
    // (installTimeout:0) has to go and look.
    if (installMs > 0) { await frame.waitForFunction(() => !!window.__copse, { timeout: installMs }); installed = true; }
    else installed = await bootEv(() => !!window.__copse).catch(() => false);
    // register framework adapters (PureMVC etc.) into the fresh __copse before anything reads state.
    // A broken adapter is survivable (swallow it); a renderer that stopped answering is not — rethrow that
    // one, or the very next step just times out again with less context.
    for (const a of fwAdapters) { try { await bootEv((x) => { try { window.__copse.registerFramework && window.__copse.registerFramework(x); } catch { /* */ } }, adapterToInjectable(a)); } catch (e) { if (e && e.code === 'renderer-silent') throw e; } }
    if (fps != null) await bootEv(([f, pixi]) => {
      if (pixi) { try { const t = window.__copse.app.ticker; t.maxFPS = f; } catch {} return; }
      const G = window.cc.game; try { G.frameRate = f; } catch {} try { G.setFrameRate && G.setFrameRate(f); } catch {}
    }, [fps, isPixi()]);
    // Gate on the RUNTIME being usable (a scene/stage exists), NOT on "are there buttons yet". interactive()
    // only counts cc.Button, so a screen whose only entry point is a bare node with a touch handler (a
    // cocos intro's ClickToPlay) can NEVER satisfy it: every attach there burned the whole injectStallMs
    // spinning and then reported a bogus "still settling", when __copse had been up for seconds. Whether
    // there is anything to press is the CALLER's judgement (orient/snapshot already report it) — it was
    // never a readiness condition. A scene is O(1) to check and is already up on a loading/intro screen,
    // so this settles immediately there, while still keeping a fresh launch from handing back a session
    // whose getScene() is null (goto resolves on `load`, before the engine has built a scene).
    // NOT a hard gate — this loop just falls through when it runs out, and a scene that never appears
    // stays the CALLER's call (per the paragraph above).
    // Polled from NODE, deliberately, not via frame.waitForFunction({polling:'raf'}): rAF is FROZEN in a
    // hidden tab, so an in-page poll never runs there at all. Measured — a condition that became true at
    // 1s: visible tab 960ms, hidden tab NEVER (timed out at 8s). attach means driving your own browser,
    // where the game tab routinely isn't the frontmost one, so every reboot would have paid the full
    // budget instead of the ~ms this work exists to deliver: the optimization silently destroying the
    // thing it optimized, and every reconnect number here measured on a visible tab. CDP evaluate is not
    // throttled (measured: 1ms on a hidden tab), so polling from out here keeps the 250ms granularity AND
    // is immune to visibility. A detach mid-wait propagates, which is correct: the page moved, so this
    // boot is void and must be retried, not quietly completed.
    bootPhase = 'waiting-scene';
    for (let t0 = Date.now(); Date.now() - t0 < sceneMs;) {
      // a silent renderer throws out of the boot (bootEv), it doesn't stall it
      if (await bootEv((pixi) => {
        try { return !!(pixi ? (window.__copse && window.__copse.app && window.__copse.app.stage) : window.cc.director.getScene()); } catch { return false; }
      }, isPixi())) break;
      await sleep(POLL);
    }
    bootPhase = 'ready';
  };
  // A boot that FAILS (no cc found, or __copse never installed) leaves `frame` anchored to whatever
  // bootInPage last set — and when the find-loop comes up empty that's page.mainFrame(): a perfectly
  // LIVE frame with no game on it. Nothing about it is "detached", so isDetached() below never fires
  // again, reboot is never retried, and the session is wedged FOREVER: every later call throws
  // `__copse is undefined` and it stays broken even after the game comes back healthy. That is what
  // turned "the preview happened to reload mid-rebuild" into "reconnect by hand, every time". Track the
  // failure instead, so the next call retries it. Pinned by test/driver-reconnect.l2.test.js.
  let bootFailed = null;   // null | { at, error }
  const trackBoot = (p) => p.then((v) => { bootFailed = null; return v; },
    // A boot killed by a detach failed because the page moved under it, not because the page is broken —
    // the world already changed, so there is nothing to cool down from. at:0 → the next call retries at once.
    (e) => { bootFailed = { at: isDetached(e) ? 0 : Date.now(), error: (e && e.message) || String(e) }; throw e; });
  // A navigation means the world just changed, so a failed boot is worth retrying NOW rather than after the
  // cooldown — the build-finished→preview-reloads case, where the retry succeeds in ~4ms.
  // ANY frame, not just mainFrame: the game this tool exists for lives in an IFRAME (verified on the real
  // editor preview — cc sits in a cross-origin iframe), and when that preview reloads it is the IFRAME that
  // navigates. Filtering on mainFrame meant the self-heal never fired for the one shape that matters; the
  // measurement that "proved" it healed had navigated the whole tab, which is not what a preview does.
  // A timestamp, not a mutation of bootFailed.at: the ordering runs both ways (a navigation usually fires
  // BEFORE the boot it kills rejects), so the two facts have to be comparable rather than one overwriting
  // the other and losing the cancel.
  let lastNavAt = 0;
  page.on('framenavigated', () => { lastNavAt = Date.now(); });

  // Auto-reconnect (SUGGESTIONS #6): the page reloads a lot during testing (game refresh, mock-token
  // swap), which detaches the frame + wipes __copse → every in-page call throws "detached Frame". Detect
  // that class of error and TRANSPARENTLY re-find the cc frame + re-inject once, then retry — so a caller
  // never has to manually reconnect after a navigation. reboot() is de-duped so concurrent calls share one.
  const isDetached = (e) => { const m = (e && e.message) || String(e); return /detached|context was destroyed|Cannot find context|Target closed|Session closed|page has been closed/i.test(m); };
  // A page can wipe __copse WITHOUT detaching anything. An iframe that navigates IN PLACE (`f.src = f.src`,
  // a soft preview reload, the game redirecting itself) keeps its Frame object — verified: still in
  // page.frames(), detached:false, evaluate still succeeds — and simply gets a fresh document. The call
  // then fails with a plain TypeError from reaching into `window.__copse`, which isDetached() cannot see,
  // so no reboot fires and the session wedges exactly as it did before any of this work. Every reconnect
  // measurement here (including on a real editor preview) used page.reload(), the shape that DOES detach —
  // so the whole mechanism rested on a premise the iframe case never satisfies.
  // Ask the page rather than pattern-match the error: __copse missing is the fact that matters, and a
  // TypeError from the game's own code must not be mistaken for it.
  // async + try/catch, NOT .then(v,()=>false): a frame that detaches between the failed op and this probe
  // makes evaluate throw SYNCHRONOUSLY (the same hole ccState's comment documents — and the same mistake,
  // repeated), and a `.then` rejection handler never sees a sync throw, so the raw unbranded detach error
  // escaped the recovery entirely. And if we can't even ask, the frame IS gone — that's a yes, not a no.
  const copseGone = async () => {
    try { return !!(await frame.evaluate(() => !window.__copse)); }
    catch { return true; }
  };

  let reinjects = 0;
  // ONE boot at a time, for EVERY entry point — the initial `ready`, a detach-driven reboot, and reload().
  // bootInPage mutates connect-scoped state (`frame`, `engine`, bootPhase/bootAt, probeAnswered/probeTimedOut,
  // and through
  // trackBoot bootFailed), so two of them interleaving means the last to settle wins: a healthy boot marked
  // failed by the other's rejection, or `frame` left on whatever the loser found. The old guard only deduped
  // reboot against reboot, which the reachable case walks straight past — attach returns stalled with `ready`
  // still booting, the caller does what the connect note tells them and reloads, and reload's boot races the
  // initial one.
  let inFlight = null;   // { at, p } — `at` is when the boot actually STARTED (Infinity until it does)
  const runBoot = (budget, { notBefore = 0, reinject = false } = {}) => {
    // Joining an in-flight boot is only sound if that boot can have SEEN the document the caller cares
    // about. One that hasn't started yet (at = Infinity) will observe whatever exists when it does, so it
    // is fresh for everybody; one that started before the caller's navigation cannot be, so that caller
    // queues behind it rather than being handed a boot of the page that is already gone.
    if (inFlight && inFlight.at >= notBefore) return inFlight.p;
    const prev = inFlight ? inFlight.p.catch(() => {}) : Promise.resolve();   // a prior boot's failure must not poison the chain
    const rec = { at: Infinity, p: null };
    rec.p = trackBoot(prev.then(async () => {
      rec.at = Date.now();
      frame = page.mainFrame();   // a navigation replaced every frame; bootInPage re-finds the cc one
      await bootInPage(budget);
      if (reinject) {
        reinjects++;
        // Re-injection installs a FRESH __copse, so any patch/hold hooks the caller put in the page are gone
        // (bootInPage re-registers framework adapters; caller hooks it can't know about). Say so — a silent
        // re-inject turns "my patch stopped firing" into a false green that's very hard to trace back here.
        cap('warn', 'copse: re-injected after a navigation — window.__copse is fresh, so any patch/hold hooks you installed are GONE (framework adapters were re-registered automatically). Re-apply them if this flow depends on them.');
      }
    }));
    inFlight = rec;
    rec.p.catch(() => {}).then(() => { if (inFlight === rec) inFlight = null; });
    return rec.p;
  };

  const ready = runBoot({});   // the initial boot — cold budget, nothing to queue behind, not a re-inject
  let readySettled = false;
  ready.then(() => { readySettled = true; }, () => { readySettled = true; });  // also keeps an init failure from tripping unhandled-rejection

  // A reboot gets its OWN, much smaller budget than a cold connect — for EVERY wait phase, not just the
  // find. A cold boot may be waiting on a game booting from nothing; a reboot is waiting on a game that
  // was alive moments ago (measured: a healthy reload is back in ~2s on the real preview, and re-found in
  // ~2ms when it's already up). Overshooting is what made ONE op block for the whole cold budget.
  // Undershooting is cheap now that a failed boot is recoverable: the cost is one visible retry (the
  // cooldown below, which the next navigation cancels), not a wedged session.
  // Callers pass `lastNavAt` as the freshness mark rather than Date.now(): every op knocked over by the
  // SAME navigation then shares one boot instead of each queueing its own, while a boot older than that
  // navigation is still correctly refused.
  const reboot = (notBefore = 0) => { const ms = (opts.rebootTries ?? 15) * 1000; return runBoot({ findMs: ms, sceneMs: ms }, { notBefore, reinject: true }); };

  // `ready` is deliberately NOT awaited in attach mode (a tab paused in the debugger, or one that simply
  // hasn't booted yet, must not hang connect) — so it can still be pending here, and if the renderer is
  // halted it stays pending forever. ev() used to open with a bare `await ready`, so every call then
  // blocked on init unbounded and silently: one real session sat there 1953s (32 min) and only stopped
  // because the MCP host's idle timeout cut it.
  //
  // The wait is SHORT on purpose, and answering "not yet" is not the same as giving up: the boot keeps
  // running in the background, so the next call may just succeed. This gate only ever fires when someone
  // attaches to a not-yet-ready tab and drives it immediately — a state connect ALREADY reported as
  // stalled/paused. Waiting out a long budget there adds silence, not information; naming the phase and
  // handing control back adds information. Anyone who genuinely wants to block can raise readyTimeout.
  const readyBudget = opts.readyTimeout ?? 5000;
  const readyGate = async () => {
    if (readySettled) return;   // fast path: once init has settled, no race and no timer per call
    let timer;
    const stuck = await Promise.race([ready.then(() => false, () => false), new Promise((res) => { timer = setTimeout(() => res(true), readyBudget); })]);
    clearTimeout(timer);
    if (stuck) throw err(`copse: in-page init hasn't finished yet (phase=${bootPhase}, ${((Date.now() - bootAt) / 1000).toFixed(1)}s elapsed) — it's still running, so retry in a moment. If it never clears: phase=finding-cc means no frame has a live cc scene (tab still loading / on the wrong page / game never booted), and any phase stuck for minutes usually means the renderer is halted at a breakpoint.`,
      { recoverable: true, code: 'init-pending' });   // init is still running — the retry is the whole point
  };

  // Public evaluator: in-page calls wait for init, so a paused/deferred attach auto-unblocks them once
  // you resume. For launch + a live attach, `ready` is already settled → no extra delay. On a detached
  // frame (a navigation happened under us), re-inject and retry the call ONCE.
  // The ONE place every in-page read goes through, so the "no engine here" contract is enforced once
  // rather than hoped for. bootInPage's `installed:false` path leaves `window.__copse` undefined; a
  // read then died on `Cannot read properties of undefined (reading 'snapshot')`, which is both
  // useless and hides the diagnosis the caller needs. Fail with the finding instead.
  // Goes through err(), like every other SESSION failure: this was the one runtime path still throwing a
  // bare Error, so it carried no `copse` brand and no code — errClass() read nothing off it and a caller
  // branching on the class silently fell through to prose-matching on exactly the diagnosis it most needs
  // to act on. (The bare `new Error`s above are pre-connect CONFIG errors — "you called this wrong" — and
  // deliberately stay unclassed; they are not something a retry or a reconnect can address.)
  // Not recoverable: reaching here means the boot SUCCEEDED and there is still no engine, so retrying
  // re-finds the same engine-less page. The fix is a different page or a different `engine` option.
  const notInstalled = () => err(
    `copse is not installed on this page — no ${engineDetected ? engine : 'engine'} was found. ${NO_ENGINE_HELP}`,
    { code: 'not-installed' },
  );
  const REBOOT_COOLDOWN = opts.rebootCooldown ?? 2000;
  // The LAST unbounded wait. readyGate above only covers init; once init has settled it's a no-op, and
  // this evaluate then had no bound at all — so a renderer that wedges AFTER connect (a breakpoint hit
  // mid-session, a game whose JS thread spins) hung every call forever, silently. Same 32-minute hole the
  // readyGate closed, entered at a later moment (verified: a post-connect wedge was still hanging with no
  // signal). Most ops are milliseconds, so a generous bound never fires for them and only caps the hang.
  // NOT recoverable: the renderer is halted, so an automatic retry just re-hangs for another full budget.
  // A non-positive cap falls back to the default rather than meaning "unbounded": this deadline exists
  // precisely so nothing hangs silently, and `opTimeout:0` / `eval({timeout:'0'})` reintroduced the very
  // 32-minute hang it was added to kill — through the knob its own error message points you at. There is
  // deliberately no way to switch it off; if an op is legitimately long, give it a large number.
  const positive = (ms, dflt) => (ms > 0 ? ms : dflt);
  const OP_TIMEOUT = positive(opts.opTimeout, 60000);
  // The deadline wraps the WHOLE call — readyGate and the reboot recovery included, not just the evaluate.
  // Bounding only the evaluate made the number a lie: `eval({timeout:'5s'})` could still burn readyGate
  // (5s) + a full reboot (~40s) before the 5s cap was even armed. A caller who says "5s" means the call,
  // not one interior step of it.
  const evWith = async (deadlineMs, fn, ...a) => {
    deadlineMs = positive(deadlineMs, OP_TIMEOUT);
    // `sent` — the op has actually been handed to the page. Every claim the deadline/retry logic makes
    // hinges on this bit: before it, the op provably never ran, so failing or retrying is FREE; after it,
    // "failed" can no longer mean "didn't happen". The old unbounded ev() never reported failure before the
    // op ran, so callers could safely read failure as not-run — the deadline broke that invariant, and an
    // agent told "[recoverable] … retry" re-fired presses that a zombie run then ALSO fired (double bet).
    // `sent` is only assigned after frame.evaluate returns its promise — a detached frame throws
    // synchronously, and that path must read as "never sent".
    // `abandoned` — the deadline already REPORTED this call as failed. A zombie run that later finishes its
    // reboot must not fire the original op after the fact.
    let sent = false, abandoned = false;
    const lateAbort = () => err('copse: this call was already reported as timed out — refusing to fire it late (the caller may have retried it already).', { code: 'op-timeout' });
    const run = (async () => {
      await readyGate();   // an init FAILURE isn't rethrown here — bootFailed carries it, so there's one recovery path, not two
      if (bootFailed) {
        // Re-paying the whole boot budget on every call is the opposite failure (a 3-step script paying it
        // per step, linearly); inside the cooldown, fail fast with the real reason instead — UNLESS a
        // navigation has landed since the failure, which is the whole point of the cooldown being cancellable.
        if (Date.now() - bootFailed.at < REBOOT_COOLDOWN && lastNavAt <= bootFailed.at) throw err(`copse: not attached to a live game — the last (re)connect failed: ${bootFailed.error}. It retries on the next call; reconnect if the tab is on the wrong page.`,
          { recoverable: true, code: 'boot-failed' });
        await reboot(lastNavAt);
      }
      // A boot can SUCCEED and still leave nothing to talk to: no engine was found on the page, so
      // __copse never installed (see notInstalled). That is NOT a connection fault, so it must not take
      // the reboot/retry path above — re-finding the same engine-less page 15 times just launders a
      // diagnosis into a timeout. Report the finding, once, and let the caller act on it.
      if (!installed) throw notInstalled();
      try {
        if (abandoned) throw lateAbort();
        const p = frame.evaluate(fn, ...a);   // sync throw (detached frame) → `sent` stays false
        sent = true;
        return await p;
      } catch (e) {
        const det = isDetached(e);
        if (!det && !(await copseGone())) throw e;   // a real in-page error — the game's, not the session's
        // IN FLIGHT when the world moved: the op reached the page and may have taken effect before the
        // context died — unknowable from here. Silently re-firing it was the old behavior, and for a
        // press/pm_set that's a double actuation; for a watch it silently restarted the whole window and
        // returned a timeline that starts AFTER the navigation. Hand the ambiguity to the caller instead.
        if (det && sent) throw err('copse: the page navigated while this call was IN FLIGHT — it may or may not have taken effect. If it mutates state (press/pm_set/pm_notify), verify before retrying: a blind retry can fire it twice. Reads are safe to just retry.',
          { recoverable: true, code: 'interrupted' });
        // Never sent (sync detached throw), or the fn provably died on a missing __copse (copseGone) —
        // nothing ran, so a transparent reboot+retry is safe.
        await reboot(lastNavAt);
        if (abandoned) throw lateAbort();
        try {
          const p = frame.evaluate(fn, ...a);
          sent = true;
          return await p;
        } catch (e2) {
          if (!isDetached(e2)) throw e2;
          throw err('copse: the page navigated AGAIN while this call was being retried — wait for it to settle, then retry.', { recoverable: true, code: 'reconnecting' });
        }
      }
    })();
    run.catch(() => {});   // if the deadline wins, this may still settle later — don't trip unhandled-rejection
    let timer;
    // WHAT the call was doing when the clock ran out decides what to say and whether a retry helps.
    // `sent` is the honest divider — NOT bootPhase, which is also non-'ready' during the INITIAL attach
    // boot (where "the page navigated" would assert an event that never happened):
    //   never sent → nothing ran; retrying is safe by construction (and the zombie is barred above).
    //   sent       → the op is still running in the page and may complete AFTER this error — say so, so a
    //                mutating caller verifies instead of blindly re-firing.
    const capped = new Promise((_, rej) => {
      timer = setTimeout(() => {
        abandoned = true;
        rej(!sent
          ? err(`copse: call gave up after ${Math.round(deadlineMs / 1000)}s — the session is still ${bootPhase !== 'ready' ? `getting to the game (phase=${bootPhase})` : 'recovering the connection'}, and the op was never sent to the page: nothing ran, retrying is safe. If this never clears, the renderer is probably halted at a breakpoint.`,
            { recoverable: true, code: 'reconnecting' })
          : err(`copse: in-page call didn't return within ${Math.round(deadlineMs / 1000)}s — the renderer is almost certainly halted (a breakpoint, or the game's JS thread stuck in a loop). The call is STILL RUNNING in the page and may complete after this error: if it mutates state, verify before retrying. Resume the tab, or reconnect. Raise opTimeout (or pass a timeout) if this op legitimately takes longer.`,
            { code: 'op-timeout' }));
      }, deadlineMs);
    });
    try { return await Promise.race([run, capped]); } finally { clearTimeout(timer); }
  };
  const ev = (fn, ...a) => evWith(OP_TIMEOUT, fn, ...a);

  // Two DISTINCT attach conditions, kept apart so connect never hangs AND never mislabels one as the
  // other (they were conflated into one `paused` before, so a still-loading game read as "paused in the
  // debugger"). `paused` = a trivial evaluate won't even return → the renderer is genuinely HALTED
  // (debugger/OOPIF). `stalled` = evaluate returns fine, but init didn't finish within injectStallMs —
  // the bundle/__copse install is still queued, or the engine has no scene up yet. This used to fire on
  // any intro screen (init waited for interactive()>0, which a Button-less intro never reaches); it now
  // means init genuinely didn't complete. Launch can't be pre-paused → await fully (init errors still throw).
  let paused = false, stalled = false;
  if (!opts.attach) {
    try { await ready; } catch (e) { await bail(e); }   // a launch whose init failed must not leave its Chrome running
  } else {
    const probe = await Promise.race([page.evaluate(() => 1).then(() => 'live', () => 'live'), sleep(opts.pauseProbeMs ?? 1200).then(() => 'frozen')]);
    if (probe === 'frozen') paused = true;
    // Same budget as readyGate, deliberately: "how long copse waits for init before saying it isn't ready"
    // should be ONE number, whether you ask via connect (stalled) or via a call (phase=...). This used to
    // block 20s — back when connect returning was the only chance to learn anything. Now a call answers the
    // same question in 5s AND names the phase, so blocking connect any longer only adds silence.
    else if ((await Promise.race([ready.then(() => 'ok', () => 'ok'), sleep(opts.injectStallMs ?? readyBudget).then(() => 'stall')])) === 'stall') stalled = true;
    if (paused || stalled) ready.catch(() => {}); // settles on resume / once init finishes; don't trip unhandled-rejection
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
    try {
      r = await action();
      // The actuation has HAPPENED. Everything below is OBSERVATION (settle / diff), and an observation
      // failure must not be reported as the action failing: the commonest trigger is the action ITSELF
      // navigating the page (a restart/confirm button), whose settle-snapshot then trips the detach — the
      // caller was handed "[recoverable] … retry" for a press that already fired, an agent obeyed, and the
      // press fired twice (a second bet), with the evidence of the first success silently discarded.
      // Annotate the result instead: the action's ok/fired stand; what was lost is only the after-state.
      try {
        await settle();
        if (before && r && typeof r === 'object') {
          const c = coreDiff(before, await snapDiff());
          if (c.appeared.length || c.disappeared.length || c.activated.length || c.deactivated.length || c.labelChanged.length) r.changed = c;
        }
      } catch (e) {
        if (r && typeof r === 'object') r.observation = { lost: true, error: (e && e.message) || String(e), note: 'the action itself COMPLETED; only its after-state could not be read (the page likely navigated under the settle). Do not re-fire the action to see the state — read it with snapshot/orient once the page is back.' };
      }
    } finally { logWindows.delete(logWin); if (netWin) netWindows.delete(netWin); }
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
  // The visual pipeline's raw page.* calls (screenshot, the in-page decode) bypass evWith on purpose —
  // they aren't cc-frame ops — but unbounded they hung forever on a halted renderer, and because the MCP
  // server serializes tool calls, ONE hung visual_check wedged every tool after it: the exact silent-hang
  // class evWith exists to kill, alive in a side door. The pipeline already degrades loud via `reason`
  // fields, so a timeout degrades the same way instead of hanging.
  const TIMED_OUT = Symbol('timed-out');
  const boundedPage = async (p, ms = OP_TIMEOUT) => {
    let timer;
    try { return await Promise.race([p, new Promise((res) => { timer = setTimeout(() => res(TIMED_OUT), ms); })]); }
    finally { clearTimeout(timer); }
  };
  // The cc frame may be a nested/OOPIF iframe offset from the top page. page.screenshot clips in TOP-page
  // coords while the manifest rect is IFRAME-local, so resolve the cc frame's offset in the top page (0,0
  // for the main frame). Returns null when it can't be determined (an OOPIF with no reachable frameElement)
  // → visualSig then degrades LOUD instead of screenshotting the wrong region.
  async function ccFrameOffset() {
    if (frame === page.mainFrame()) return { x: 0, y: 0 };
    let el; try { el = await boundedPage(frame.frameElement()); } catch { el = null; }
    if (!el || el === TIMED_OUT) return null;
    let box; try { box = await boundedPage(el.boundingBox()); } catch { box = null; } finally { try { await el.dispose(); } catch { /* */ } }
    return box && box !== TIMED_OUT ? { x: box.x, y: box.y } : null;
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
    const shot = await boundedPage(page.screenshot({ clip, type: 'png' }).catch(() => null));
    if (shot === TIMED_OUT) return { manifest, sig: null, reason: 'renderer-silent' };
    if (!shot) return { manifest, sig: null, reason: 'screenshot-failed' };
    const png = Buffer.from(shot).toString('base64');
    // Decode+downsample in-page. Guard it like its siblings above: a CSP that blocks data: imgs (or any
    // decode failure) must degrade LOUD, not throw out of visualSig and reject the whole visualCheck.
    const rgba = await boundedPage(page.evaluate(async ({ b64, grid, masks, clip }) => {
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
    }, { b64: png, grid, masks: manifest.maskRects, clip: local }).catch(() => null)); // masks are iframe-local → pass the local region
    if (rgba === TIMED_OUT) return { manifest, sig: null, reason: 'renderer-silent' };
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
      // Go through reboot(), not a boot of our own. This navigation DETACHES the cc frame, so any op in
      // flight (a watch, a concurrent tool call) trips isDetached and calls reboot() at the same moment —
      // and a second, un-deduped bootInPage would race it for the shared frame/bootPhase/bootFailed, with
      // the last writer winning (a failed boot silently cleared by the other's success, or vice versa).
      // It also earns reload the reinjects++ and the hook-loss warning: reload wipes __copse just as surely
      // as an accidental navigation does, and warning on only the accidental path is the worse half to pick.
      // reboot()'s budget (rebootTries) applies once its boot STARTS — but runBoot's freshness rule can
      // QUEUE this reboot behind a still-running initial cold boot (attach → stalled → the caller reloads,
      // exactly what the stalled note suggests), so the wait here is potentially cold-budget + reboot, not
      // 15s. Cap the CALL like any other op: on timeout the boot keeps running in the background and the
      // next call joins it — reload just stops pretending to be synchronous with it.
      let timer;
      const capped = new Promise((_, rej) => { timer = setTimeout(() => rej(err(`copse: reload's re-boot didn't finish within ${Math.round(OP_TIMEOUT / 1000)}s — it is still running in the background; call orient/snapshot in a moment, or reconnect if this repeats.`, { recoverable: true, code: 'reconnecting' })), OP_TIMEOUT); });
      try { await Promise.race([reboot(lastNavAt), capped]); } finally { clearTimeout(timer); }   // we navigated on purpose — a boot that predates it saw the document we just replaced
      // reboot() already waited for a live engine root, but a slow (headless CI) renderer can still be
      // MID scene-swap when we read — poll so the summary snapshot below (and the caller's very next
      // step, e.g. runScripts) don't hit a null getScene() / an empty Pixi stage.
      for (let i = 0; i < 40; i++) {
        // A raw evaluate, deliberately: ev() would re-enter readyGate/reboot recovery, and this is a
        // best-effort settle check on a frame reboot() just handed us. A transient mid-swap throw means
        // "not settled yet", not "reload failed" — so it degrades to false rather than out of reload().
        if (await frame.evaluate((pixi) => { try { const r = pixi ? window.__copse.app.stage : window.cc.director.getScene(); return !!(r && (r.children || []).length); } catch { return false; } }, isPixi()).catch(() => false)) break;
        await sleep(200);
      }
      const snap = await ev(() => window.__copse.snapshot({ relevant: true }));
      const inter = await ev(() => window.__copse.interactive());
      return { ok: true, reloaded: true, url: page.url(), relevantNodes: snap.length, buttons: inter.length };
    },
    snapshot: (o) => ev((o) => window.__copse.snapshot(o), o ?? {}),
    interactive: () => ev(() => window.__copse.interactive()),
    // join-ready (ref, method) rows for coir cross-reference. Cocos-only BY CONSTRUCTION: the key's
    // `method` is an editor-serialized ClickEvent handler name, and Pixi has no editor and serializes
    // nothing. Refuse with an explanation rather than returning [] — an empty join reads as "nothing is
    // wired", which is a false finding rather than a degraded one (docs/ENGINES.md §5).
    clickSurface: async (o) => {
      await ready;                       // never branch on an engine that hasn't been resolved yet
      if (isPixi()) return Promise.reject(new Error('clickSurface/coverage is Cocos-only: Pixi serializes no click handlers, so every row would be method:null (docs/ENGINES.md §5). Use interactive() + codeHandlers instead.'));
      return ev((o) => window.__copse.clickSurface(o), o ?? {});
    },
    // Which objects here were written by the GAME, and what is callable on them — minify-proof,
    // because method names survive what mangles class names (docs/ENGINES.md §3). Both engines, but
    // it answers a different question on each: on Pixi it's the ADDRESSING entry point (refs are
    // positional gibberish); on Cocos refs are already readable, so its value is the RELEASE build,
    // where component class names are mangled to `e`/`t` while their methods are not.
    anchors: (o) => ev((o) => window.__copse.anchors(o), o ?? {}),
    press: (ref, o = {}) => { const { captureNetwork, ...pageOpts } = o || {}; return mutate(() => ev(([r, oo]) => window.__copse.press(r, oo), [ref, pageOpts]), captureNetwork); },
    call: (sel, ...a) => mutate(() => ev(([s, a]) => window.__copse.call(s, ...a), [sel, a])),
    // Arbitrary expression eval in the cc frame's MAIN WORLD (global scope) — NO pause, unlike the
    // CDP eval_frame (which needs a breakpoint and freezes the renderer). Runs via indirect eval so
    // cc / window / window.__copse / cc.find are all in reach; a returned thenable is awaited; the
    // value is coerced to a JSON-safe form so a non-serialisable return doesn't blow up the bridge.
    // `timeout` ('90s'/ms) raises the op deadline for THIS call — eval is the one op whose duration is
    // user-authored, and the reported 1953s hang was an eval polling loop: it needs the cap most, and is
    // also the only op that can legitimately want more than the default.
    eval: (expr, o = {}) => evWith(positive(parseDur(o.timeout, OP_TIMEOUT), OP_TIMEOUT), (code) => {
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
      // watch runs its whole poll loop IN-PAGE and is SUPPOSED to take as long as its own timeout (40s by
      // default, and callers pass '2m'), so judging it by the default op deadline would kill the healthy
      // case. Derive its budget from the same duration grammar the in-page loop parses, plus room to return.
      // `interval` counts too: the in-page loop checks its deadline between samples, so it can overshoot by
      // up to one interval — a long-interval watch sized to survive would otherwise be killed on the tail.
      const budget = parseDur(o.timeout, 40000) + parseDur(o.settle, 0) + parseDur(o.interval, 1000) + 15000;
      try { r = await evWith(budget, (oo) => window.__copse.watch(oo), o); }
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
    patchCalls: (sel) => ev((s) => window.__copse.patch_calls(s || undefined), sel ?? null),   // a trace:true patch's recorded calls (no sel → the merged timeline)

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
    pmTrace: (opts) => ev((o) => window.__copse.pmTrace(o), opts ?? {}),   // arm every dispatch choke point → patchCalls() reads the merged flow
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
      const b64 = await boundedPage(page.screenshot({ encoding: 'base64', ...(clip ? { clip } : {}) }));
      if (b64 === TIMED_OUT) throw err(`copse: screenshot didn't return within ${Math.round(OP_TIMEOUT / 1000)}s — the renderer is almost certainly halted (a breakpoint). Resume the tab, then retry.`, { code: 'op-timeout' });
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
    // `stalled`: init didn't finish in time (install still queued, or no scene up yet) → reads may not work.
    // NOTE (contract change): `paused` USED to mean "inject deferred for ANY reason"; it now means the
    // debugger case ONLY. A consumer that gated on `paused` to wait for the game to be live must now gate on
    // `!paused && !stalled` (a stalled/loading tab reads paused:false), or it will act on a not-yet-ready tree.
    // list all open tabs in the attached/launched browser → {index,url,title,active} (SUGGESTIONS B4).
    // Pre-attach reconnaissance (which of several look-alike tabs to match) and post-attach sanity.
    tabs: () => listTabs(browser),
    // which tab attach chose ({url,title,index,of}; null when launched) — surfaced so a wrong pick shows now.
    attachedTab,
    // 'cocos'|'pixi', or NULL while `auto` is still resolving — attach mode's paused/stalled paths
    // deliberately return from connect() without awaiting `ready`, so a caller can observe this
    // before bootInPage has decided. Reporting null is the honest answer; `await cp.ready` first if
    // you need the resolved value (`engineReady()` does exactly that).
    get engine() { return engineResolved ? engine : null; },
    // Declared capability profile for the resolved engine — so a consumer (arbor) BRANCHES on facts
    // instead of assuming Cocos: clickSurface/coverage are Cocos-only; a frozen tripwire's refs are only
    // stable on Cocos (docs/ENGINES.md §3, §5). null engine (unresolved / no engine) zeroes everything.
    get capabilities() { return engineCapabilities(engineResolved ? engine : null); },
    get engineResolved() { return engineResolved; },
    /** Await boot, then hand back the settled engine — what to use instead of racing the getter. */
    engineReady: async () => { try { await ready; } catch { /* boot failure is reported elsewhere */ } return engine; },
    get engineDetected() { return engineDetected; }, // false = nothing identified itself (auto fell back to cocos); doctor's key finding
    get installed() { return installed; },   // false = __copse never came up; every read then throws notInstalled()
    // how many times the session re-injected after a navigation — each one wiped the caller's in-page
    // patch/hold hooks (a warning also lands in cp.logs()), so a hook-dependent flow can check it.
    get reinjects() { return reinjects; },
    page, get frame() { return frame; }, browser, ready, paused, stalled,
    close: () => (opts.attach ? browser.disconnect() : browser.close()),
  };
  return cp;
}
