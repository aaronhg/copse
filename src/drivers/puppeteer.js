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
 * reachable/node/diff) plus `page`, `browser`, and `close()`.
 * @param {string} url
 * @param {{bundlePath?:string|URL, executablePath?:string, browserURL?:string, browserWSEndpoint?:string, headless?:any, viewport?:any, fpsCap?:number, timeout?:number, bootTries?:number, readyTries?:number, settle?:boolean|{maxMs?:number,interval?:number}}} [opts]
 *        settle: after a mutating press/call, wait until the tree stabilises (tweens) then
 *        attach a `changed` auto-diff to the result. Default on; `settle:false` to disable.
 */
export async function connect(url, opts = {}) {
  const puppeteer = await loadPuppeteer();
  const bundle = readFileSync(opts.bundlePath || new URL('../../dist/copse.inject.js', import.meta.url), 'utf8');
  const browser = (opts.browserURL || opts.browserWSEndpoint)
    ? await puppeteer.connect({ browserURL: opts.browserURL, browserWSEndpoint: opts.browserWSEndpoint })
    : await puppeteer.launch({ executablePath: opts.executablePath || DEFAULT_CHROME, headless: opts.headless ?? 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--mute-audio'] });
  const page = await browser.newPage();
  await page.setViewport(opts.viewport || { width: 414, height: 896, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: 'load', timeout: opts.timeout ?? 60000 });

  // wait for cc + a loaded scene (supports window.cc or System.import('cc'))
  for (let i = 0, n = opts.bootTries ?? 40; i < n; i++) {
    const ok = await page.evaluate(async () => { let cc = window.cc; if ((!cc || !cc.director) && window.System) { try { cc = (await System.import('cc')).default || await System.import('cc'); } catch {} } if (!(cc && cc.director && cc.director.getScene)) return false; window.cc = cc; const s = cc.director.getScene(); return !!(s && (s.children || []).length); });
    if (ok) break; await sleep(1000);
  }
  await page.evaluate(bundle);
  await page.evaluate(() => { if (!window.__copse && window.copse) window.copse.install(window.cc); });
  await page.waitForFunction(() => !!window.__copse, { timeout: 10000 });

  const ev = (fn, ...a) => page.evaluate(fn, ...a);

  // heat control: cap fps low (NOT pause — pausing here can freeze a game still loading
  // from a Loader scene, and a paused loop won't run scene transitions / tweens / spins).
  const fps = opts.fpsCap ?? 10;
  await ev((f) => { const G = window.cc.game; try { G.frameRate = f; } catch {} try { G.setFrameRate && G.setFrameRate(f); } catch {} }, fps);

  // readiness: let the game settle into a UI scene (some pressable buttons present), bounded.
  for (let i = 0, n = opts.readyTries ?? 25; i < n; i++) {
    if (await ev(() => { try { return window.__copse.interactive().length > 0; } catch { return false; } })) break;
    await sleep(1000);
  }

  // A relevant (small) snapshot is the basis for settle + auto-delta around mutating ops.
  const snapRel = () => ev(() => window.__copse.snapshot({ relevant: true }));
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
    const before = settleCfg ? await snapRel() : null;
    const r = await action();
    await settle();
    if (before && r && typeof r === 'object') {
      const c = coreDiff(before, await snapRel());
      if (c.appeared.length || c.disappeared.length || c.activated.length || c.deactivated.length || c.labelChanged.length) r.changed = c;
    }
    return r;
  }

  /** @type {any} */
  const cp = {
    snapshot: (o) => ev((o) => window.__copse.snapshot(o), o ?? {}),
    interactive: () => ev(() => window.__copse.interactive()),
    press: (ref, o) => mutate(() => ev(([r, o]) => window.__copse.press(r, o), [ref, o ?? {}])),
    call: (sel, ...a) => mutate(() => ev(([s, a]) => window.__copse.call(s, ...a), [sel, a])),
    get: (sel) => ev((s) => window.__copse.get(s), sel),
    reachable: (sel) => ev((s) => window.__copse.reachable(s), sel),
    node: (sel) => ev((s) => window.__copse.node(s), sel),
    diff: (a, b) => ev(([a, b]) => window.__copse.diff(a, b), [a, b]),
    page, browser, close: () => browser.close(),
  };
  return cp;
}
