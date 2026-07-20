// L2 — the puppeteer driver's auto-reconnect against a REAL Chrome, not a fake.
//
// Guards the failure mode that cost a real session ~32 minutes (DEVELOPMENT.md §25F):
// the driver holds ONE `frame` for the whole session, and a tab reload detaches it. `ev()` catches that
// and reboots — which WORKS when the game comes straight back (~4ms). The bug is what happens when the
// reload lands on a page with no cc yet (a preview mid-rebuild — exactly the build→reload loop this
// tool is used in): bootInPage falls back to page.mainFrame(), a perfectly LIVE frame with no game on
// it. Nothing about it is "detached", so isDetached() never fires again and the session is wedged
// FOREVER — it does not recover even after the build finishes and the game is healthy again.
//
// Skips when Chrome / puppeteer-core aren't available → `npm test` stays green everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = process.env.COPSE_CHROME || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : '/usr/bin/google-chrome');
const havePuppeteer = await import('puppeteer-core').then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const canRun = havePuppeteer && existsSync(CHROME);

if (!canRun) {
  test('L2 driver-reconnect: SKIPPED — needs puppeteer-core + Chrome', { skip: true }, () => {});
}

// A stand-in for dist/copse.inject.js: installs __copse ONLY once cc is live, exactly like the real
// bundle (which polls ~10s for the engine). A bundle that installed unconditionally would mask the bug.
// snapshot/interactive are here because cp.reload() builds its summary from them — until this file exercised
// reload(), nothing did, so the surface it needs was easy to miss.
const FAKE_BUNDLE = `(function () {
  if (window.cc && window.cc.director) window.__copse = {
    get: (s) => ({ ok: true, value: 'STATE:' + s }),
    snapshot: () => [{ ref: 'Canvas/Btn', button: true }],
    interactive: () => [{ ref: 'Canvas/Btn', reachable: true }],
    // a restart/confirm-shaped button: the handler completes, THEN the page navigates under the settle
    press: (r) => { setTimeout(() => location.reload(), 80); return { ok: true, ref: r, fired: 1 }; },
    install: function () {},
  };
})();`;

// A game whose cc can be toggled off to simulate a preview mid-rebuild, served inside an iframe —
// the Cocos editor-preview shape, and the ONLY shape where a reload actually detaches copse's frame
// (a main-frame game's Frame object survives both reload and cross-site navigation).
function fakeGame() {
  // slowMs: make cc appear only after a delay, so a connect returns with its initial boot still running —
  // the state every "boot races another boot" scenario needs.
  const state = { ccPresent: true, port: 0, slowMs: 0 };
  const CC = 'window.cc={game:{},director:{getScene:()=>({children:[{}]})}};';
  const GAME = () => '<!doctype html><title>game</title><script>' + (state.ccPresent
    ? (state.slowMs ? `setTimeout(function(){${CC}}, ${state.slowMs});` : CC)
    : '/* mid-rebuild: no cc */') + '</script>game';
  const server = http.createServer((req, r) => {
    r.setHeader('content-type', 'text/html');
    r.end(req.url.startsWith('/host') ? `<!doctype html><title>host</title><iframe id="f" src="http://localhost:${state.port}/game"></iframe>` : GAME());
  });
  // closeAllConnections: Chrome holds keep-alive sockets, and a bare server.close() waits for them to
  // drain — which never happens, so `node --test` hangs after the assertions pass.
  const close = () => { try { server.closeAllConnections(); } catch { /* older node */ } server.close(); };
  return { state, server, close, listen: () => new Promise((res) => server.listen(0, () => { state.port = server.address().port; res(`http://localhost:${state.port}/host`); })) };
}

// The double-actuation contract. The old unbounded ev() never reported failure before an op ran, so
// "failed" safely implied "didn't happen" — the deadline and the recovery path both broke that invariant
// silently: a call killed mid-flight was retried by the agent it told "[recoverable] retry", and the op
// fired twice (a second bet). These pin the restored contract: an op that MAY have run is handed back as
// `interrupted` (verify, don't blind-retry), and an actuation that COMPLETED is never converted into a
// thrown "retry me" by a failure that happened after it (observation lost ≠ action failed).
test('L2 driver: an op in flight when the page navigates is `interrupted`, not silently re-fired', { skip: !canRun, timeout: 120000 }, async (t) => {
  const { connect } = await import('../src/drivers/puppeteer.js');
  const bundlePath = join(mkdtempSync(join(tmpdir(), 'copse-l2-')), 'fake.inject.js');
  writeFileSync(bundlePath, FAKE_BUNDLE);
  const game = fakeGame();
  const url = await game.listen();
  const cp = await connect(url, { bundlePath, executablePath: CHROME, headless: 'new', bootTries: 2, rebootTries: 2, readyTries: 2 });
  t.after(async () => { await cp.close(); game.close(); });

  const inflight = cp.eval('await new Promise(r => setTimeout(r, 30000))');   // parked in the page
  inflight.catch(() => {});
  await sleep(500);
  await cp.page.reload({ waitUntil: 'load' });                                // destroys its context mid-flight
  await assert.rejects(() => inflight, (e) => {
    assert.equal(e.code, 'interrupted', 'in-flight + navigation = MAY have run — the caller decides, not a silent re-fire');
    assert.equal(e.recoverable, true);
    assert.match(e.message, /verify before retrying/i, 'the ambiguity must be stated, or an agent double-fires mutations');
    return true;
  });
  assert.deepEqual(await cp.get('X'), { ok: true, value: 'STATE:X' }, 'and the session itself recovers for the next call');
});

test('L2 driver: an actuation that completed is never re-labelled failed by a lost observation', { skip: !canRun, timeout: 120000 }, async (t) => {
  const { connect } = await import('../src/drivers/puppeteer.js');
  const bundlePath = join(mkdtempSync(join(tmpdir(), 'copse-l2-')), 'fake.inject.js');
  writeFileSync(bundlePath, FAKE_BUNDLE);
  const game = fakeGame();
  const url = await game.listen();
  const cp = await connect(url, { bundlePath, executablePath: CHROME, headless: 'new', bootTries: 2, rebootTries: 2, readyTries: 2 });
  t.after(async () => { await cp.close(); game.close(); });

  // The press handler completes, then navigates — INTO a mid-rebuild page, so the settle snapshot's
  // recovery reboot fails too. The press still HAPPENED: reporting it "[recoverable] … retry" is an
  // instruction to fire it twice, with the evidence of the first success discarded.
  game.state.ccPresent = false;                    // the document the press navigates into has no cc
  const r = await cp.press('Canvas/Btn');
  assert.equal(r.ok, true, 'the actuation result must survive — it happened');
  assert.equal(r.fired, 1);
  assert.equal(r.observation && r.observation.lost, true, 'what was lost is the AFTER-state, and it must say so');
  assert.match(r.observation.note, /Do not re-fire/i);
});

// Three entry points call bootInPage — the initial `ready`, a detach-driven reboot, and reload() — and the
// old guard only deduped reboot against reboot. This is the gap it left, and it is not exotic: attach is
// DESIGNED to return stalled while `ready` is still booting, the connect note then tells the caller to
// "call orient/snapshot again in a moment, or reload", and reload's boot races the initial one for `frame`,
// bootPhase, ccAnswered and (via trackBoot) bootFailed — last settler wins, so a healthy session can be
// left marked boot-failed by the loser's rejection.
// This pins the reachable scenario end-to-end, not every interleaving; the serialization is what makes the
// interleavings impossible, and a test that raced them would only be flaky about saying so.
test('L2 driver: reload while the initial boot is still running must not corrupt the session', { skip: !canRun, timeout: 120000 }, async (t) => {
  const puppeteer = (await import('puppeteer-core')).default;
  const { connect } = await import('../src/drivers/puppeteer.js');
  const bundlePath = join(mkdtempSync(join(tmpdir(), 'copse-l2-')), 'fake.inject.js');
  writeFileSync(bundlePath, FAKE_BUNDLE);
  const game = fakeGame();
  game.state.slowMs = 2500;                 // cc lands well after connect gives up waiting → `ready` still in flight
  const url = await game.listen();

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  t.after(async () => { try { await browser.close(); } catch { /* */ } game.close(); });
  const pg = await browser.newPage();
  await pg.goto(url, { waitUntil: 'domcontentloaded' });

  const cp = await connect(url, { bundlePath, attach: true, browserWSEndpoint: browser.wsEndpoint(), match: '/host', injectStallMs: 300 });
  t.after(() => cp.close());
  assert.equal(cp.stalled, true, 'precondition: connect returns with the initial boot still running');

  await cp.reload();                        // exactly what the stalled note tells you to do
  assert.deepEqual(await cp.get('X'), { ok: true, value: 'STATE:X' }, 'the session must be usable, not left marked boot-failed by the losing boot');
  assert.deepEqual(await cp.get('X'), { ok: true, value: 'STATE:X' }, 'and must stay usable — a corrupted `frame` shows up on the next call');
});

// Reconnect speed was measured entirely on VISIBLE tabs — but attach exists to drive your own browser,
// where the game tab is routinely not the frontmost one. Chrome freezes requestAnimationFrame in a hidden
// tab, so the scene gate's in-page rAF poll never ran there and every reboot paid its whole budget instead
// of milliseconds (measured on a bare condition that flips at 1s: visible 960ms, hidden NEVER). Polling
// from Node instead is immune — CDP evaluate isn't throttled — which is why this test hides the tab first.
test('L2 driver: reconnect must be fast on a HIDDEN tab, not just a visible one', { skip: !canRun, timeout: 120000 }, async (t) => {
  const puppeteer = (await import('puppeteer-core')).default;
  const { connect } = await import('../src/drivers/puppeteer.js');
  const bundlePath = join(mkdtempSync(join(tmpdir(), 'copse-l2-')), 'fake.inject.js');
  writeFileSync(bundlePath, FAKE_BUNDLE);
  const game = fakeGame();
  const url = await game.listen();

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  t.after(async () => { try { await browser.close(); } catch { /* */ } game.close(); });
  const pg = await browser.newPage();
  await pg.goto(url, { waitUntil: 'networkidle0' });
  const front = await browser.newPage();
  await front.goto('about:blank');
  await front.bringToFront();                       // the game tab is now hidden — rAF is frozen in it
  assert.equal(await pg.evaluate(() => document.visibilityState), 'hidden', 'precondition: the tab must actually be hidden');

  const cp = await connect(url, { bundlePath, attach: true, browserWSEndpoint: browser.wsEndpoint(), match: '/host' });
  t.after(() => cp.close());
  assert.deepEqual(await cp.get('X'), { ok: true, value: 'STATE:X' });

  await pg.reload({ waitUntil: 'networkidle0' });
  const t0 = Date.now();
  assert.deepEqual(await cp.get('X'), { ok: true, value: 'STATE:X' }, 'must reconnect on a hidden tab');
  assert.ok(Date.now() - t0 < 5000, `a hidden tab must not pay the whole scene budget, took ${Date.now() - t0}ms`);
});

// bail(): a connect that throws after the browser exists must give the browser back. The leak this guards
// is an ORPHANED Chrome plus a live CDP socket that keeps the caller's node process alive forever — so if
// this regresses, the symptom is `node --test` hanging at exit rather than a failed assertion. goto is the
// path that matters: "dev server isn't running" is the most common connect failure there is.
test('L2 driver: a launch whose goto fails must reject promptly and not orphan its browser', { skip: !canRun, timeout: 60000 }, async () => {
  const { connect } = await import('../src/drivers/puppeteer.js');
  const t0 = Date.now();
  await assert.rejects(
    () => connect('http://127.0.0.1:1/nothing-here', { executablePath: CHROME, headless: 'new', timeout: 4000 }),
    /net::|timeout|ERR_/i,
  );
  assert.ok(Date.now() - t0 < 30000, `must surface the goto failure, took ${Date.now() - t0}ms`);
});

// The reconnect keyed on isDetached() — but an iframe that navigates IN PLACE (a soft preview reload, the
// game redirecting itself) does NOT detach: verified that its Frame object stays in page.frames() with
// detached:false and evaluate still succeeding, just against a fresh document with no __copse. The failure
// is then a plain TypeError that isDetached() cannot see, so no reboot fired and the session wedged exactly
// as it did before any of this work — while every reconnect measurement, including the one on a real editor preview
// preview, had used page.reload(): the one shape that DOES detach. The mechanism rested on a premise this
// case never satisfies. copseGone() asks the page instead of pattern-matching the error.
test('L2 driver: an iframe that navigates IN PLACE (no detach) must still reconnect', { skip: !canRun, timeout: 120000 }, async (t) => {
  const { connect } = await import('../src/drivers/puppeteer.js');
  const bundlePath = join(mkdtempSync(join(tmpdir(), 'copse-l2-')), 'fake.inject.js');
  writeFileSync(bundlePath, FAKE_BUNDLE);
  const game = fakeGame();
  const url = await game.listen();
  const cp = await connect(url, { bundlePath, executablePath: CHROME, headless: 'new', bootTries: 2, rebootTries: 2, readyTries: 2 });
  t.after(async () => { await cp.close(); game.close(); });
  const reloadIframe = () => cp.page.evaluate(() => new Promise((r) => { const f = document.getElementById('f'); f.onload = r; f.src = f.src; }));

  assert.equal(cp.frame === cp.page.mainFrame(), false, 'precondition: cc is in the iframe — the real preview shape');
  assert.deepEqual(await cp.get('X'), { ok: true, value: 'STATE:X' });

  await reloadIframe();   // the Frame object SURVIVES this; only its document is replaced
  assert.equal(cp.frame.detached, false, 'precondition: an in-place nav does not detach, so isDetached() is blind to it');
  assert.deepEqual(await cp.get('X'), { ok: true, value: 'STATE:X' }, 'must reconnect even though nothing detached');
  assert.equal(cp.reinjects, 1, 'and must report the re-inject, since it wiped any caller hooks');

  // …and the mid-rebuild round trip must work through in-place navs too: a navigation in ANY frame cancels
  // the cooldown (filtering on mainFrame excluded the very shape this tool exists for).
  game.state.ccPresent = false;
  await reloadIframe();
  await assert.rejects(() => cp.get('X'), (e) => {
    // 'no-engine', not 'no-cc': the find phase probes cocos AND pixi (docs/ENGINES.md), so the code
    // names the finding — no engine of any kind answered — rather than the cocos-only lane it started as.
    assert.equal(e.code, 'no-engine');
    assert.equal(e.recoverable, true, 'a mid-rebuild page is recoverable — it must not be blamed on a halted renderer');
    return true;
  });
  game.state.ccPresent = true;
  await reloadIframe();
  assert.deepEqual(await cp.get('X'), { ok: true, value: 'STATE:X' }, 'the iframe nav must cancel the cooldown and self-heal');
});

test('L2 driver: a reboot that fails mid-rebuild must not wedge the session forever', { skip: !canRun, timeout: 120000 }, async (t) => {
  const { connect } = await import('../src/drivers/puppeteer.js');
  const bundlePath = join(mkdtempSync(join(tmpdir(), 'copse-l2-')), 'fake.inject.js');
  writeFileSync(bundlePath, FAKE_BUNDLE);
  const game = fakeGame();
  const url = await game.listen();
  // boot/reboot budgets small so a FAILED boot costs ~2s of find-loop instead of the 40s/15s defaults.
  const cp = await connect(url, { bundlePath, executablePath: CHROME, headless: 'new', bootTries: 2, rebootTries: 2, readyTries: 2 });
  t.after(async () => { await cp.close(); game.close(); });

  assert.deepEqual(await cp.get('X'), { ok: true, value: 'STATE:X' }, 'baseline: the session drives the game');

  // A healthy F5 must recover transparently — this already worked; pin it so a fix can't regress it.
  await cp.page.reload({ waitUntil: 'networkidle0' });
  assert.deepEqual(await cp.get('X'), { ok: true, value: 'STATE:X' }, 'a healthy reload must auto-reconnect');

  // Now the reload lands mid-rebuild: no cc → the reboot fails and leaves `frame` on a live-but-gameless
  // main frame.
  game.state.ccPresent = false;
  await cp.page.reload({ waitUntil: 'networkidle0' });
  await assert.rejects(() => cp.get('X'), 'a call against a gameless page must fail, not silently succeed');

  // …and every FOLLOWING call must fail FAST. The driver must not re-pay the whole boot budget per call
  // (the doc measured 40s × N linear amplification on a 3-step script).
  const t0 = Date.now();
  await assert.rejects(() => cp.get('X'));
  assert.ok(Date.now() - t0 < 1000, `a call on a known-broken session must fail fast, took ${Date.now() - t0}ms`);

  // THE REGRESSION: the build finishes, the preview reloads, the game is healthy again. The session
  // must heal itself. Before the fix this stays broken forever (isDetached never fires again on the
  // main frame, so reboot is never retried) and only a manual connect() recovers it.
  game.state.ccPresent = true;
  await cp.page.reload({ waitUntil: 'networkidle0' });
  assert.deepEqual(await cp.get('X'), { ok: true, value: 'STATE:X' }, 'the session must self-heal once the game is back');
});

// The OTHER way a call hangs forever, and the one readyGate does NOT cover: init finished fine, so the
// gate is a no-op — then the renderer wedges (a breakpoint hit mid-session, a JS thread stuck in a loop)
// and the evaluate underneath never returns. Same silent 32-minute hole as the doc's case B, entered at a
// later moment. `opTimeout` is what makes copse's "never hangs silently" claim actually true.
test('L2 driver: a renderer that wedges AFTER connect must fail loud, not hang', { skip: !canRun, timeout: 120000 }, async (t) => {
  const { connect } = await import('../src/drivers/puppeteer.js');
  const bundlePath = join(mkdtempSync(join(tmpdir(), 'copse-l2-')), 'fake.inject.js');
  writeFileSync(bundlePath, FAKE_BUNDLE);
  const game = fakeGame();
  const url = await game.listen();
  const cp = await connect(url, { bundlePath, executablePath: CHROME, headless: 'new', opTimeout: 3000 });
  // SIGKILL, not close(): this test wedges the renderer in an infinite loop ON PURPOSE, and a graceful
  // close waits for it — the teardown would outlive the test it cleans up after.
  t.after(() => { try { cp.browser.process().kill('SIGKILL'); } catch { /* already gone */ } game.close(); });

  assert.deepEqual(await cp.get('X'), { ok: true, value: 'STATE:X' }, 'precondition: init is done, so readyGate is a no-op from here');

  const t0 = Date.now();
  await assert.rejects(
    () => Promise.race([cp.eval('while(true){}'), new Promise((_, rej) => setTimeout(() => rej(new Error('HUNG: ev() never settled')), 30000))]),
    (e) => {
      assert.doesNotMatch(e.message, /^HUNG/, 'a wedged renderer must not hang the call forever');
      assert.equal(e.code, 'op-timeout');
      // A wedged renderer is NOT recoverable: retrying just re-hangs for another full budget. The flag
      // has to mean "a retry may work", or a caller that trusts it makes things worse.
      assert.equal(e.recoverable, false, 'a wedged renderer must not invite an automatic retry');
      return true;
    },
  );
  assert.ok(Date.now() - t0 < 10000, `must give up near opTimeout, took ${Date.now() - t0}ms`);
});

// The hang, re-entered through the RECOVERY path — the one place nothing guarded. `opTimeout` wraps the
// evaluate, but a boot that already failed sends the next call into reboot() FIRST, and the find-loop's cc
// probe was the last un-raced await in the file: a halted renderer answers it with neither a value nor a
// throw, so findMs (checked only between iterations) could never fire. Verified before the fix: an op with
// opTimeout:4000 was still hanging at 12s. The machinery built to make failure safe was itself the hang.
test('L2 driver: a halted renderer must not hang the reboot recovery path', { skip: !canRun, timeout: 120000 }, async (t) => {
  const puppeteer = (await import('puppeteer-core')).default;
  const { connect } = await import('../src/drivers/puppeteer.js');
  const bundlePath = join(mkdtempSync(join(tmpdir(), 'copse-l2-')), 'fake.inject.js');
  writeFileSync(bundlePath, FAKE_BUNDLE);
  const game = fakeGame();
  game.state.ccPresent = false;            // cold boot fails → bootFailed set → the next call reboots
  const url = await game.listen();

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  t.after(() => { try { browser.process().kill('SIGKILL'); } catch { /* */ } game.close(); });
  const pg = await browser.newPage();
  await pg.goto(url, { waitUntil: 'networkidle0' });

  const cp = await connect(url, { bundlePath, attach: true, browserWSEndpoint: browser.wsEndpoint(), bootTries: 1, rebootTries: 3, injectStallMs: 500, opTimeout: 20000 });
  t.after(() => cp.close());
  await sleep(2500);                       // let the cold boot fail and the cooldown lapse
  pg.evaluate('while(true){}').catch(() => {});   // wedge the renderer, as a mid-session breakpoint would
  await sleep(300);

  const t0 = Date.now();
  await assert.rejects(
    () => Promise.race([cp.get('X'), new Promise((_, rej) => setTimeout(() => rej(new Error('HUNG: reboot never settled')), 25000))]),
    (e) => {
      assert.doesNotMatch(e.message, /^HUNG/, 'the reboot path must not hang on a silent renderer');
      // "nobody answered" must not be reported as "no cc here" — they call for opposite actions (resume
      // the debugger vs wait for the build), and a retry cannot fix a halted renderer.
      assert.equal(e.code, 'renderer-silent');
      assert.equal(e.recoverable, false);
      return true;
    },
  );
  assert.ok(Date.now() - t0 < 20000, `must give up inside the reboot budget, took ${Date.now() - t0}ms`);
});

// The second half of the doc's report: a call that neither resolves NOR rejects. `ev()` opens with a
// bare `await ready` — and attach mode DELIBERATELY leaves `ready` pending (a tab paused in the
// debugger, or one that just hasn't booted, must not hang connect). So every call blocks on init for
// as long as init takes, with no bound and no signal. A real session sat there 1953s (32 min) and only
// stopped because the MCP host's idle timeout cut it. Here init is made to take ~60s and the wait is
// asked to give up at 2s: what's under test is that the wait is BOUNDED and says why, not that it wins.
test('L2 driver: ev() must bound its wait on in-page init instead of blocking on it silently', { skip: !canRun, timeout: 120000 }, async (t) => {
  const puppeteer = (await import('puppeteer-core')).default;
  const { connect } = await import('../src/drivers/puppeteer.js');
  const bundlePath = join(mkdtempSync(join(tmpdir(), 'copse-l2-')), 'fake.inject.js');
  writeFileSync(bundlePath, FAKE_BUNDLE);
  const game = fakeGame();
  game.state.ccPresent = false;            // no cc → bootInPage spins its find-loop → `ready` stays pending
  const url = await game.listen();

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); game.close(); });
  const pg = await browser.newPage();
  await pg.goto(url, { waitUntil: 'networkidle0' });

  // injectStallMs small so connect returns promptly (stalled:true) instead of waiting out init itself.
  // bootTries keeps `ready` pending well past readyTimeout (so the gate is what settles the call), but
  // not so long that the still-spinning find-loop holds the test process open after teardown.
  const cp = await connect(url, { bundlePath, attach: true, browserWSEndpoint: browser.wsEndpoint(), bootTries: 10, readyTries: 1, injectStallMs: 500, readyTimeout: 2000 });
  t.after(() => cp.close());
  assert.equal(cp.stalled, true, 'precondition: init has not finished, so `ready` is still pending');

  const t0 = Date.now();
  await assert.rejects(
    () => Promise.race([cp.get('X'), new Promise((_, rej) => setTimeout(() => rej(new Error('HUNG: ev() never settled')), 30000))]),
    (e) => {
      assert.doesNotMatch(e.message, /^HUNG/, 'ev() must settle rather than hang');
      // Settling isn't enough — the whole point is that the caller learns WHERE init is stuck. Without a
      // phase there's still no way to tell "game still loading" from "script wrong" from "renderer halted".
      assert.match(e.message, /phase=finding-cc/, 'the error must name the init phase it gave up in');
      // …and init is still running, so this is the case a caller SHOULD retry. Prose can't say that to a
      // script; the flag can.
      assert.equal(e.recoverable, true);
      assert.equal(e.code, 'init-pending');
      return true;
    },
  );
  assert.ok(Date.now() - t0 < 10000, `ev() must give up on a stuck init promptly, took ${Date.now() - t0}ms`);
});
