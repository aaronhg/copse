#!/usr/bin/env node
// @ts-check
// copse CLI — the official entry (registered as `copse`, runs this file directly; no build).
//   copse ai   <url> --goal "<what to test>" [--stop ..] [--report ..] [--rounds N] [--model ..]
//   copse scan <url>                          # one-shot: print snapshot/interactive/labels
//   copse mcp  [url] [--debug]                # JSON-RPC/stdio MCP server (see docs/MCP.md)
//   copse get/press/call/node/reachable <url> <sel>   # single-shot primitive → JSON (pipe to jq)
//
// Heavy/optional bits (puppeteer-core driver, the claude agent, the MCP server) are
// LAZY-imported per command, so `copse --help` / `copse mcp` don't require puppeteer-core
// and the common path stays light. Needs a built dist/copse.inject.js (npm run build).
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
const VAL_FLAGS = new Set(['--goal', '--stop', '--report', '--rounds', '--model', '--chrome', '--browser-url', '--fps', '--match', '--framework', '-o', '--output', '--junit']);
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
};

const USAGE = `copse — drive & assert a running Cocos game

  copse ai   <url> --goal "<what to test>" [--stop "<when to stop>"] [--report "<format>"]
                   [--rounds N] [--model sonnet|opus|...] [--chrome <path>] [--browser-url <url>]
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
  copse probe <url>                          engine-coupling self-diagnostic (version + which internals resolve)
  copse coverage <url> <coir-rows.json>      coir×copse join → coverage buckets (rows = coir's static ClickEvent JSON; file or inline)
  copse run  <url> <script.json>             replay a frozen test script (docs/SCRIPTS.md) → result JSON; exit 0 pass / 1 fail (CI)
  copse run  <url> <dir> [--junit <file>]    run every *.json in <dir> as a suite (reset between) → JUnit + exit 0/1 (CI)

  common:  --version|-V   print the copse version    (--verbose|-v is untruncated step results)
           -o|--output <folder>   append the run log to <folder>/<cmd>.log
           --headed       show a visible browser window (default headless); --fps N raise the fps cap to watch
           --browser-url <url>   attach to your own Chrome (run it with --remote-debugging-port) and drive that
           --attach [--match <substr>]   drive an ALREADY-OPEN tab in that Chrome without navigating
                         (for your game behind a login/staging gate you opened yourself) — needs --browser-url;
                         omit --match (and <url>) to drive the ACTIVE tab (the one you're looking at)
           --framework <file>[,<file>]   extra framework adapter file(s) (config/code) on top of the
                         auto-loaded copse.frameworks.mjs — enables framework/pm_get/pm_set/pm_call

Setup:  npm run build   (produces dist/copse.inject.js)   +   npm i -D puppeteer-core
The 'ai' command also needs the 'claude' CLI logged in.`;

if (!cmd || cmd === '-h' || cmd === '--help') { console.log(USAGE); process.exit(cmd ? 0 : 1); }

// MCP first: its stdout IS the JSON-RPC channel, so emit NOTHING else to stdout.
// It runs until stdin EOF, then exits from inside startMcpServer.
if (cmd === 'mcp') {
  const { startMcpServer } = await import('./mcp/server.js');
  await startMcpServer({ url, connectOpts, debug: has('--debug') }); // Debugger tools hidden by default; --debug surfaces them
} else if (cmd === 'scan' || cmd === 'ai') {
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
  } else { // ai
    const { runHarness } = await import('./index.js');
    const { makeClaudeAgent } = await import('./agents/claude.js');
    const goal = flag('--goal');
    if (!goal) { console.error('ai: --goal is required\n\n' + USAGE); process.exit(1); }
    out(`# goal: ${goal}`);
    out('='.repeat(72));
    const agent = makeClaudeAgent({
      goal, stopCondition: flag('--stop', ''), reportFormat: flag('--report', ''), model: flag('--model', 'sonnet'),
      onStage: (stage, info) => {
        const c = info.cost ? ` ($${(info.cost.cost || 0).toFixed(4)})` : '';
        if (stage === 'plan') { out(`\n===== ROUND ${info.round} =====\n[plan]${c} ${info.rationale || ''}`); (info.steps || []).forEach((s, i) => out(`  ${i + 1}. ${JSON.stringify(s)}`)); }
        else if (stage === 'judge') { (info.steps || []).forEach((s) => { const r = JSON.stringify(s.result); out(`   ${JSON.stringify(s.step)} → ${verbose ? r : r.slice(0, 300)}`); }); out(`[judge]${c} ` + JSON.stringify(info.verdict)); }
        else if (stage === 'next') out(`[next]${c} ` + JSON.stringify(info.decision));
        else if (stage === 'report') out(`\n===== REPORT${c} =====\n` + info.summary);
      },
    });
    const cp = await connect(target, connectOpts);
    try {
      const report = await runHarness(cp, agent, { context: { goal }, maxRounds: Number(flag('--rounds', '1')) });
      out('\n===== DONE ===== pass: ' + report.pass + ' | rounds: ' + report.rounds.length);
      const u = agent.usage ? agent.usage() : null;
      if (u) out(`cost: $${u.cost.toFixed(4)} | ${u.calls} claude -p calls | tokens in/out ${u.inputTokens}/${u.outputTokens}` + (u.cost === 0 ? '  (cost $0 → likely a Claude subscription, not API billing)' : ''));
      process.exitCode = report.pass ? 0 : 1;
    } finally { await cp.close(); }
  }
  if (sink) sink.end();
} else if (['get', 'press', 'call', 'node', 'reachable'].includes(cmd)) {
  // single-shot: connect → run ONE primitive → print the JSON result → close. Fills the gap
  // between `scan` (read-only discovery) and `ai` (the whole LLM loop) — a quick shell-level
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
} else if (cmd === 'probe') {
  // single-shot with NO selector: connect → __copse.probe() → print the engine-coupling diagnostic.
  // Run it on an unfamiliar build to see whether copse's version-sensitive internals resolve here.
  const target = url || connectOpts.match;
  if (!target && !connectOpts.attach) { console.error(`probe: a <url> (or --attach [--match <substr>]) is required\n\n${USAGE}`); process.exit(1); } // bare --attach → active tab
  const { connect } = await import('./drivers/puppeteer.js');
  const cp = await connect(target, connectOpts);
  try { console.log(J(await cp.probe())); } finally { await cp.close(); }
} else if (cmd === 'run') {
  // Deterministic replay: connect → runScript(script.json) → result JSON → exit code for CI.
  // The zero-LLM half of the test loop (docs/SCRIPTS.md) — scripts come from a dumped MCP
  // session / a frozen `copse ai` run / by hand.
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
} else if (cmd === 'coverage') {
  // The combined coir×copse capability at the shell: connect → clickSurface(live) → coverageJoin(coir's
  // static rows) → the coverage buckets as JSON. <rows> is coir's ClickEvent JSON ([{nodePath, method}]) —
  // a file path or inline; get it from coir's CLI/MCP. --no-reachable skips the reachable pass.
  const target = url || connectOpts.match;
  if (!target && !connectOpts.attach) { console.error(`coverage: a <url> (or --attach [--match <substr>]) is required\n\n${USAGE}`); process.exit(1); } // bare --attach → active tab
  const positionals = rest.filter((a, i) => !/^-/.test(a) && !VAL_FLAGS.has(rest[i - 1]) && a !== url);
  const src = positionals[0];
  if (!src) { console.error(`coverage: a coir static-rows JSON (file path or inline) is required, e.g. copse coverage ${target || '<url>'} coir-rows.json\n\n${USAGE}`); process.exit(1); }
  let raw = src; try { raw = readFileSync(src, 'utf8'); } catch { /* not a file → treat the arg as inline JSON */ }
  let staticRows; try { staticRows = JSON.parse(raw); } catch (e) { console.error(`coverage: couldn't parse static rows from "${src}" — need a JSON file path or inline JSON array ([{nodePath, method}]): ${e.message}`); process.exit(1); }
  if (!Array.isArray(staticRows)) { console.error('coverage: static rows must be a JSON ARRAY of {nodePath, method} (coir\'s ClickEvent edges)'); process.exit(1); }
  const { coverageJoin } = await import('./coverage.js');
  const { connect } = await import('./drivers/puppeteer.js');
  const cp = await connect(target, connectOpts);
  try {
    const surface = await cp.clickSurface({ reachability: !has('--no-reachable') });
    console.log(J(coverageJoin(staticRows, surface)));
  } finally { await cp.close(); }
} else {
  console.error(`unknown command: ${cmd}\n\n` + USAGE); process.exit(1);
}
