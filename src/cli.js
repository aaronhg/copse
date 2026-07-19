#!/usr/bin/env node
// @ts-check
// copse CLI — the official entry (registered as `copse`, runs this file directly; no build).
//   copse scan <url>                          # one-shot: print snapshot/interactive/labels
//   copse mcp  [url] [--debug]                # JSON-RPC/stdio MCP server (see docs/MCP.md)
//   copse get/press/call/node/reachable <url> <sel>   # single-shot primitive → JSON (pipe to jq)
//   copse run  <url> <script.json|dir>        # replay a frozen flow script → exit 0/1 (CI)
// (The AI-driver loop is NOT here — that's arbor's layer, built on copse's `execute` primitive.)
//
// Heavy/optional bits (puppeteer-core driver, the MCP server) are LAZY-imported per command, so
// `copse --help` / `copse mcp` don't require puppeteer-core and the common path stays light.
// Needs a built dist/copse.inject.js (npm run build).
import { mkdirSync, createWriteStream, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const [, , cmd, ...rest] = process.argv;
const flag = (f, d) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : d; };
const has = (...fs) => fs.some((f) => rest.includes(f));

// `copse --version` / `-V` (note: -v is --verbose below, so version takes -V) — straight from package.json.
if (cmd === '--version' || cmd === '-V' || rest.includes('--version')) {
  try { console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version); }
  catch { console.log('?'); }
  process.exit(0);
}
// value-taking flags — so the positional <url> finder below never grabs a flag's value
// (e.g. `--browser-url http://…` must NOT be read as the game url, or `copse mcp` pre-opens it).
const VAL_FLAGS = new Set(['--model', '--chrome', '--browser-url', '--fps', '--match', '--framework', '--engine', '-o', '--output', '--junit']);
const url = rest.find((a, i) => /^https?:\/\//.test(a) && !VAL_FLAGS.has(rest[i - 1])); // declared AFTER VAL_FLAGS (no TDZ)
const verbose = has('--verbose', '-v');
const J = (x) => JSON.stringify(x, null, 2);

const connectOpts = {
  executablePath: flag('--chrome'),
  browserURL: flag('--browser-url'),
  headless: has('--headed', '--show') ? false : undefined, // --headed → a visible window (real GPU, cooler)
  fpsCap: flag('--fps') ? Number(flag('--fps')) : undefined, // raise from the default 10 to watch smoothly
  attach: has('--attach') || undefined,                     // drive an already-open tab (no navigation)
  match: flag('--match'),                                   // pick that tab by URL substring
  frameworks: flag('--framework') ? flag('--framework').split(',') : undefined, // extra adapter file(s) on top of copse.frameworks.mjs
  engine: flag('--engine'),                                 // 'cocos' (default) | 'pixi' — see docs/ENGINES.md
};

const USAGE = `copse — drive & assert a running Cocos/Pixi game

  copse scan <url> [--chrome <path>]
  copse mcp  [url] [--debug]  start a JSON-RPC/stdio MCP server (any MCP client drives the game;
                    omit url to let the client's 'connect' tool choose — see docs/MCP.md;
                    --debug also surfaces the CDP Debugger tools, hidden by default)

  one-shot (connect → run one op → print JSON → close; pipe to jq):
  copse get   <url> <path:Comp.member>      read a member, e.g. Canvas/Score:Label.string
  copse press <url> <ref> [--force] [--reachable-gate]  press a button (clickEvents + CLICK); --reachable-gate refuses a covered button
  copse call  <url> <path:Comp.method> [args…]  invoke a method (each arg JSON-parsed, else string)
  copse node  <url> <ref>                    node intrinsics (active/opacity/scale/worldPos/size)
  copse reachable <url> <ref>                best-effort: is the button covered by an overlay?
  copse doctor <url>                         health check: WebGL/scene/console + engine coupling → why won't it run (exit 0 booted / 1 not)
  copse run  <url> <script.json>             replay a frozen test script (docs/SCRIPTS.md) → result JSON; exit 0 pass / 1 fail (CI)
  copse run  <url> <dir> [--junit <file>]    run every *.json in <dir> as a suite (reset between) → JUnit + exit 0/1 (CI)

  common:  --version|-V   print the copse version    (--verbose|-v is untruncated step results)
           -o|--output <folder>   append the run log to <folder>/<cmd>.log
           --headed       show a visible browser window (default headless); --fps N raise the fps cap to watch
           --browser-url <url>   attach to your own Chrome (run it with --remote-debugging-port) and drive that
           --attach [--match <substr>]   drive an ALREADY-OPEN tab in that Chrome without navigating
                         (for your game behind a login/staging gate you opened yourself) — needs --browser-url;
                         omit --match (and <url>) to drive the ACTIVE tab (the one you're looking at)
           --engine <cocos|pixi>         engine layer (default cocos). pixi = PixiJS 8; injected
                                         pre-boot, so it must be set at connect time. See docs/ENGINES.md
           --framework <file>[,<file>]   extra framework adapter file(s) (config/code) on top of the
                         auto-loaded copse.frameworks.mjs — enables framework/pm_get/pm_set/pm_call

Setup:  npm run build   (produces dist/copse.inject.js)   +   npm i -D puppeteer-core`;

if (!cmd || cmd === '-h' || cmd === '--help') { console.log(USAGE); process.exit(cmd ? 0 : 1); }

// MCP first: its stdout IS the JSON-RPC channel, so emit NOTHING else to stdout.
// It runs until stdin EOF, then exits from inside startMcpServer.
if (cmd === 'mcp') {
  const { startMcpServer } = await import('./mcp/server.js');
  await startMcpServer({ url, connectOpts, debug: has('--debug') }); // Debugger tools hidden by default; --debug surfaces them
} else if (cmd === 'scan') {
  const target = url || connectOpts.match;                  // attach mode can use --match instead of a <url>
  if (!target && !connectOpts.attach) { console.error(`${cmd}: a <url> (or --attach [--match <substr>]) is required\n\n${USAGE}`); process.exit(1); } // bare --attach → active tab
  const outDir = flag('-o') || flag('--output');
  let sink = null;
  if (outDir) { mkdirSync(outDir, { recursive: true }); sink = createWriteStream(join(outDir, `${cmd}.log`), { flags: 'a' }); }
  const out = (s = '') => { process.stdout.write(s + '\n'); if (sink) sink.write(s + '\n'); };
  const { connect } = await import('./drivers/puppeteer.js'); // lazy: only load puppeteer-core when actually driving
  out('\n' + '='.repeat(72));
  out(`# copse ${cmd} @ ${new Date().toISOString()}`);
  out(`# ${connectOpts.attach ? 'attach' : 'url'}: ${target || '(active tab)'}`);

  if (cmd === 'scan') {
    const cp = await connect(target, connectOpts);
    try {
      const snap = await cp.snapshot();
      const inter = await cp.interactive();
      const labels = snap.filter((d) => d.label != null).map((d) => ({ ref: d.ref, label: d.label }));
      out('='.repeat(72));
      out(`nodes: ${snap.length} | buttons: ${inter.length} | labels: ${labels.length}`);
      out('\ninteractive:\n' + J(inter));
      out('\nlabels:\n' + J(labels));
    } finally { await cp.close(); }
  }
  if (sink) sink.end();
} else if (['get', 'press', 'call', 'node', 'reachable'].includes(cmd)) {
  // single-shot: connect → run ONE primitive → print the JSON result → close. Fills the gap
  // between `scan` (read-only discovery) and `run` (a whole frozen flow) — a quick shell-level
  // press/get/call without writing a script or opening MCP. Prints raw JSON (pipe to jq).
  const target = url || connectOpts.match;
  if (!target && !connectOpts.attach) { console.error(`${cmd}: a <url> (or --attach [--match <substr>]) is required\n\n${USAGE}`); process.exit(1); } // bare --attach → active tab
  // the selector/ref is the first positional that isn't the <url>; `call` takes trailing args.
  const positionals = rest.filter((a, i) => !/^-/.test(a) && !VAL_FLAGS.has(rest[i - 1]) && a !== url);
  const sel = positionals[0];
  if (!sel) {
    const eg = cmd === 'get' ? 'Canvas/Score:Label.string' : cmd === 'call' ? 'Canvas/Mgr:Ctrl.buy 30' : 'Canvas/ShopBtn';
    console.error(`${cmd}: a selector/ref is required, e.g. copse ${cmd} ${target || '<url>'} ${eg}\n\n${USAGE}`); process.exit(1);
  }
  const jsonOr = (s) => { try { return JSON.parse(s); } catch { return s; } }; // call args: JSON if it parses, else a string
  const callArgs = positionals.slice(1).map(jsonOr);
  const { connect } = await import('./drivers/puppeteer.js');
  const cp = await connect(target, connectOpts);
  try {
    const r = cmd === 'press' ? await cp.press(sel, { force: has('--force'), reachableGate: has('--reachable-gate') })
      : cmd === 'call' ? await cp.call(sel, ...callArgs)
        : cmd === 'get' ? await cp.get(sel)
          : cmd === 'node' ? await cp.node(sel)
            : await cp.reachable(sel);
    console.log(J(r));
    process.exitCode = (r && r.ok === false) ? 1 : 0; // ok:false → non-zero so scripts can branch
  } finally { await cp.close(); }
} else if (cmd === 'doctor') {
  // Health check — the "why won't it even run" verb (folds in the old `probe` + the boot diagnostic).
  // connect → environment/boot (WebGL renderer, scene populated, game console errors) + copse's
  // engine-coupling → ONE report; exit 0 if the game booted, 1 if not. Run it first when a build
  // won't drive in headless CI (e.g. no software Vulkan device → NULL WebGL → empty scene).
  const target = url || connectOpts.match;
  if (!target && !connectOpts.attach) { console.error(`doctor: a <url> (or --attach [--match <substr>]) is required\n\n${USAGE}`); process.exit(1); } // bare --attach → active tab
  // doctor auto-detects the engine unless told: you run it precisely when you DON'T know what's
  // wrong, so demanding --engine first would defeat the point. Pays a pre-injected Pixi bundle for
  // the privilege — irrelevant for a one-shot diagnostic (see connect's `auto`).
  // Only force auto when the caller hasn't pinned a bundle — bundlePath and auto are mutually
  // exclusive (connect refuses the pair), and doctor must not manufacture that conflict itself.
  const doctorOpts = { ...connectOpts, engine: connectOpts.engine || (connectOpts.bundlePath ? 'cocos' : 'auto') };
  const { connect } = await import('./drivers/puppeteer.js');
  const cp = await connect(target, doctorOpts);
  const val = (r) => (r && typeof r === 'object' && 'value' in r) ? r.value : r;
  try {
    const webgl = val(await cp.eval("(()=>{try{const c=document.createElement('canvas');const g=c.getContext('webgl2')||c.getContext('webgl');const e=g&&g.getExtension('WEBGL_debug_renderer_info');return g?((g instanceof WebGL2RenderingContext?'webgl2 ':'webgl1 ')+(e?g.getParameter(e.UNMASKED_RENDERER_WEBGL):'ctx-ok')):'NULL-CONTEXT'}catch(e){return 'ERR:'+e.message}})()").catch(() => 'eval-failed'));
    // Probe the PAGE (not just the session) so the report names what is actually running there.
    const onPage = val(await cp.eval("(()=>{try{const cocos=!!(window.cc&&window.cc.director&&window.cc.director.getScene&&window.cc.director.getScene());const app=(window.__copse&&window.__copse.app)||(window.__copsePixi&&window.__copsePixi.app)||(window.__PIXI_DEVTOOLS__&&window.__PIXI_DEVTOOLS__.app)||window.__PIXI_APP__;return{cocos,pixi:!!(app&&app.stage)}}catch(e){return{cocos:false,pixi:false}}})()").catch(() => ({ cocos: false, pixi: false })));
    const pageEngine = onPage && onPage.pixi ? 'pixi' : onPage && onPage.cocos ? 'cocos' : null;
    if (typeof cp.engineReady === 'function') await cp.engineReady();   // never branch on an engine auto hasn't resolved yet
    const scene = val(await cp.eval((cp.engine === 'pixi'
        ? "(()=>{try{const s=window.__copse&&window.__copse.app&&window.__copse.app.stage;return s?{name:(window.__copse.orient().scene||'stage'),children:(s.children||[]).length}:'NO-SCENE'}catch(e){return 'ERR:'+e.message}})()"
        : "(()=>{try{const s=window.cc&&window.cc.director&&window.cc.director.getScene&&window.cc.director.getScene();return s?{name:s.name,children:(s.children||[]).length}:'NO-SCENE'}catch(e){return 'ERR:'+e.message}})()")).catch(() => 'eval-failed'));
    const cc = val(await cp.eval((cp.engine === 'pixi'
        ? "(()=>{try{const a=window.__copse&&window.__copse.app;return{hasPixi:!!a,hasStage:!!(a&&a.stage),hasTicker:!!(a&&a.ticker),canvases:document.querySelectorAll('canvas').length}}catch(e){return 'ERR:'+e.message}})()"
        : "(()=>{try{return{hasCc:!!window.cc,hasDirector:!!(window.cc&&window.cc.director),game:!!(window.cc&&window.cc.game),canvases:document.querySelectorAll('canvas').length}}catch(e){return 'ERR:'+e.message}})()")).catch(() => 'eval-failed'));
    const errors = (cp.logs({ level: ['error', 'pageerror'], tail: 20 }) || []).map((l) => l.text);
    const coupling = await cp.probe().catch(() => null);
    const booted = scene && typeof scene === 'object' && scene.children > 0;
    console.log(J({
      ok: booted, webgl,
      engine: pageEngine,
      injected: cp.installed,
      ...(pageEngine ? {} : { engineNote: 'no engine identified itself on this page — copse looked for a live cc.director scene and a Pixi Application (init hook / __PIXI_APP__ / devtools globals). A Pixi game is INVISIBLE here unless copse was injected pre-boot, because its init hook fires once during Application.init: re-run with --engine pixi to rule that in or out. Otherwise the page may be a release Cocos build whose `cc` was tree-shaken away (docs/INJECT.md), or simply not a canvas game.' }),
      scene, [cp.engine === 'pixi' ? 'pixi' : 'cc']: cc, errors, coupling,
    }));
    process.exitCode = booted ? 0 : 1;
  } finally { await cp.close(); }
} else if (cmd === 'run') {
  // Deterministic replay: connect → runScript(script.json) → result JSON → exit code for CI.
  // The zero-LLM half of the test loop (docs/SCRIPTS.md) — scripts come from a dumped MCP
  // session / an arbor-frozen tripwire / by hand.
  const target = url || connectOpts.match;
  if (!target && !connectOpts.attach) { console.error(`run: a <url> (or --attach [--match <substr>]) is required\n\n${USAGE}`); process.exit(1); } // bare --attach → active tab
  const positionals = rest.filter((a, i) => !/^-/.test(a) && !VAL_FLAGS.has(rest[i - 1]) && a !== url);
  const src = positionals[0];
  if (!src) { console.error(`run: a script JSON (file, inline, or a DIR of *.json) is required, e.g. copse run ${target || '<url>'} tests/shop.json\n\n${USAGE}`); process.exit(1); }
  const junitPath = flag('--junit');
  // A directory → run every *.json in it as a SUITE; else a single file / inline JSON.
  let isDir = false; try { isDir = statSync(src).isDirectory(); } catch { /* not a path → inline or missing */ }
  const parse1 = (raw, name) => { try { return JSON.parse(raw); } catch (e) { console.error(`run: couldn't parse ${name} — need JSON ({name?, steps:[…]}): ${e.message}`); process.exit(1); } };
  /** @type {Array<{name:string, script:any}>} */
  const scripts = [];
  if (isDir) {
    const files = readdirSync(src).filter((f) => f.endsWith('.json')).sort();
    if (!files.length) { console.error(`run: no *.json scripts in ${src}`); process.exit(1); }
    for (const f of files) scripts.push({ name: f.replace(/\.json$/, ''), script: parse1(readFileSync(join(src, f), 'utf8'), f) });
  } else {
    let raw = src, name = 'inline'; try { raw = readFileSync(src, 'utf8'); name = src.replace(/.*[/\\]/, '').replace(/\.json$/, ''); } catch { /* inline JSON */ }
    scripts.push({ name, script: parse1(raw, src) });
  }
  const { runScript, runScripts } = await import('./script.js');
  const { connect } = await import('./drivers/puppeteer.js');
  const cp = await connect(target, connectOpts);
  try {
    if (!isDir && !junitPath) {
      // single script, no report → unchanged: print the one result object, exit 0/1.
      const r = await runScript(cp, scripts[0].script);
      console.log(J(r));
      process.exitCode = r.pass ? 0 : 1;
    } else {
      // suite (a dir, or a single file asked to emit JUnit): reset between scripts, aggregate.
      const agg = await runScripts(cp, scripts, { reset: !has('--no-reset') });
      if (junitPath) {
        const { toJUnit } = await import('./junit.js');
        mkdirSync(dirname(junitPath) || '.', { recursive: true });
        writeFileSync(junitPath, toJUnit(agg.suites));
      }
      for (const s of agg.suites) console.log(`${s.result.pass ? 'pass' : 'FAIL'}  ${s.name}  (${(s.result.steps || []).length} steps${s.result.pass ? '' : `, failed at ${s.result.failedAt}`})`);
      console.log(`\n${agg.total - agg.failed}/${agg.total} scripts passed${junitPath ? `  ·  ${junitPath}` : ''}`);
      process.exitCode = agg.pass ? 0 : 1;
    }
  } finally { await cp.close(); }
} else {
  console.error(`unknown command: ${cmd}\n\n` + USAGE); process.exit(1);
}
