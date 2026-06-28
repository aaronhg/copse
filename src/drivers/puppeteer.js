// NOTE: intentionally NOT `// @ts-check` — this file is browser-driver glue; its
// `page.evaluate` callbacks run in the GAME's window (where `window.__copse`/`cc` live),
// so type-checking them against Node's lib produces only false positives.
// OPTIONAL driver (subpath `copse/driver-puppeteer`). Drives a running Cocos game in a
// real browser (system Chrome via puppeteer-core), injects copse, and returns a Driver
// for runHarness. NOT loaded by `import 'copse'` — keeps the core zero-dep. Needs the
// peer dep `puppeteer-core` and a built `dist/copse.inject.js`.
import { readFileSync } from 'node:fs';
import { diff as coreDiff } from '../core/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_CHROME = process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : '/usr/bin/google-chrome';

async function loadPuppeteer() {
  try { return (await import('puppeteer-core')).default; }
  catch { throw new Error("copse/driver-puppeteer needs `puppeteer-core` — run: npm i -D puppeteer-core"); }
}

/**
 * Launch (or connect to) a browser, load the game, inject copse → a Driver for
 * runHarness. The returned object is the Driver (snapshot/interactive/press/get/call/
 * reachable/node/diff/listeners/hijack/captured/logs) plus `page`, `frame` (the frame cc was found in — may be a
 * nested/cross-origin iframe), `browser`, and `close()`.
 * @param {string} url
 * @param {{bundlePath?:string|URL, executablePath?:string, browserURL?:string, browserWSEndpoint?:string, attach?:boolean, match?:string, attachTries?:number, headless?:any, viewport?:any, fpsCap?:number, timeout?:number, bootTries?:number, readyTries?:number, maxLogs?:number, settle?:boolean|{maxMs?:number,interval?:number}}} [opts]
 *        attach: drive an ALREADY-OPEN tab in `browserURL`'s Chrome (find it by `match` URL
 *        substring; no navigation — for Cloudflare/login sites a human got past, so a fresh
 *        goto won't re-trigger the gate). `close()` then just disconnects, leaving your browser open.
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

  // attach mode: drive an ALREADY-OPEN tab (you passed Cloudflare / login as a human and
  // launched the game) — find it by URL substring and DON'T navigate (a fresh goto would
  // re-trigger the bot gate; CDP attach opens no DevTools panel, so anti-devtools stays dormant).
  let page;
  if (opts.attach) {
    const needle = opts.match || url || '';
    for (let i = 0, n = opts.attachTries ?? 30; i < n && !page; i++) {
      const pages = await browser.pages();
      page = pages.find((pg) => pg.url().includes(needle)) || (needle ? null : pages[0]);
      if (!page) await sleep(1000);
    }
    if (!page) throw new Error(`attach: no open tab matching "${needle}" — open the game in that Chrome first`);
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
  const cap = (level, text, extra) => { logs.push({ level, text, t: Date.now(), ...extra }); if (logs.length > (opts.maxLogs ?? 2000)) logs.shift(); };
  page.on('console', (m) => { try { cap(m.type(), m.text()); } catch {} });
  page.on('pageerror', (e) => cap('pageerror', e.message, { stack: e.stack }));

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
    if (fps != null) await rawEv((f) => { const G = window.cc.game; try { G.frameRate = f; } catch {} try { G.setFrameRate && G.setFrameRate(f); } catch {} }, fps);
    for (let i = 0, n = opts.readyTries ?? 25; i < n; i++) {
      if (await rawEv(() => { try { return window.__copse.interactive().length > 0; } catch { return false; } })) break;
      await sleep(1000);
    }
  };
  const ready = bootInPage();

  // Public evaluator: in-page calls wait for init, so a paused/deferred attach auto-unblocks them once
  // you resume. For launch + a live attach, `ready` is already settled → no extra delay.
  const ev = async (fn, ...a) => { await ready; return frame.evaluate(fn, ...a); };

  // Auto-detect "you're paused in the debugger" so connect never hangs. Launch can't be pre-paused →
  // await fully (init errors still throw). Attach → a trivial evaluate returns instantly unless the
  // renderer is halted; if the probe (or a generous init window, e.g. an OOPIF pause / slow boot)
  // stalls, return now with init DEFERRED — it completes when you resume.
  let paused = false;
  if (!opts.attach) {
    await ready;
  } else {
    const probe = await Promise.race([page.evaluate(() => 1).then(() => 'live', () => 'live'), sleep(opts.pauseProbeMs ?? 1200).then(() => 'paused')]);
    paused = probe === 'paused'
      ? true
      : (await Promise.race([ready.then(() => 'ok', () => 'ok'), sleep(opts.injectStallMs ?? 20000).then(() => 'stall')])) === 'stall';
    if (paused) ready.catch(() => {}); // settles on resume; don't trip an unhandled-rejection meanwhile
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
  async function mutate(action) {
    const before = settleCfg ? await snapDiff() : null;
    const errFrom = logs.length;          // mark the log buffer so we can attribute new errors to THIS action
    const r = await action();
    await settle();
    if (before && r && typeof r === 'object') {
      const c = coreDiff(before, await snapDiff());
      if (c.appeared.length || c.disappeared.length || c.activated.length || c.deactivated.length || c.labelChanged.length) r.changed = c;
    }
    // doesn't-crash signal: any error console / uncaught pageerror during the action+settle window. Catches a
    // handler that THREW even when the engine swallowed it to console.error — `press` still returns ok:true, but
    // `errors` surfaces it (and the harness hard-fails on it). Captured out-of-band over CDP, so it's reliable.
    if (r && typeof r === 'object') {
      const errs = logs.slice(errFrom).filter((l) => l.level === 'error' || l.level === 'pageerror');
      if (errs.length) r.errors = errs.map((l) => ({ level: l.level, text: l.text, ...(l.stack ? { stack: l.stack } : {}) }));
    }
    return r;
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
    press: (ref, o) => mutate(() => ev(([r, o]) => window.__copse.press(r, o), [ref, o ?? {}])),
    call: (sel, ...a) => mutate(() => ev(([s, a]) => window.__copse.call(s, ...a), [sel, a])),
    get: (sel) => ev((s) => window.__copse.get(s), sel),
    reachable: (sel) => ev((s) => window.__copse.reachable(s), sel),
    node: (sel) => ev((s) => window.__copse.node(s), sel),
    diff: (a, b) => ev(([a, b]) => window.__copse.diff(a, b), [a, b]),
    listeners: (sel) => ev((s) => window.__copse.listeners(s), sel),   // user node.on() handlers (best-effort)
    hijack: () => ev(() => window.__copse.hijack()),                   // opt-in: record node.on() made AFTER this
    captured: (sel) => ev((s) => window.__copse.captured(s), sel),     // what hijack() recorded for this node
    logs: (since = 0) => logs.slice(since),               // console + page errors (all frames); since = index already seen
    // attach mode drives the user's own browser → disconnect, don't close it.
    page, get frame() { return frame; }, browser, ready, paused, // `paused`: attached while halted in the debugger → inject deferred
    close: () => (opts.attach ? browser.disconnect() : browser.close()),
  };
  return cp;
}
