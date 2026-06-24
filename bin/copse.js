#!/usr/bin/env node
// @ts-check
// copse CLI — the official entry. Thin wrapper over the library:
//   copse ai   <url> --goal "<what to test>" [--stop ..] [--report ..] [--rounds N] [--model ..]
//   copse scan <url>                          # one-shot: print snapshot/interactive/labels
//
// Common flags:  --verbose|-v  (untruncated step results)   -o|--output <folder>  (append run log)
// Needs a built dist/copse.inject.js (npm run build) + peer dep `puppeteer-core`
// (system Chrome). The `ai` command also needs the `claude` CLI on PATH.
import { mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { runHarness } from '../src/index.js';
import { connect } from '../src/drivers/puppeteer.js';
import { makeClaudeAgent } from '../src/agents/claude.js';

const [, , cmd, ...rest] = process.argv;
const url = rest.find((a) => /^https?:\/\//.test(a));
const flag = (f, d) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : d; };
const has = (...fs) => fs.some((f) => rest.includes(f));
const verbose = has('--verbose', '-v');
const outDir = flag('-o') || flag('--output');
const J = (x) => JSON.stringify(x, null, 2);

// tee output to stdout AND, if -o given, an APPEND log file in that folder
let sink = null;
if (outDir) { mkdirSync(outDir, { recursive: true }); sink = createWriteStream(join(outDir, `${cmd}.log`), { flags: 'a' }); }
const out = (s = '') => { process.stdout.write(s + '\n'); if (sink) sink.write(s + '\n'); };

const USAGE = `copse — drive & assert a running Cocos game

  copse ai   <url> --goal "<what to test>" [--stop "<when to stop>"] [--report "<format>"]
                   [--rounds N] [--model sonnet|opus|...] [--chrome <path>] [--browser-url <url>]
  copse scan <url> [--chrome <path>]

  common:  --verbose|-v   untruncated step results
           -o|--output <folder>   append the run log to <folder>/<cmd>.log
           --headed       show a visible browser window (default headless); --fps N raise the fps cap to watch
           --browser-url <url>   attach to your own Chrome (run it with --remote-debugging-port) and drive that

Setup:  npm run build   (produces dist/copse.inject.js)   +   npm i -D puppeteer-core
The 'ai' command also needs the 'claude' CLI logged in.`;

if (!cmd || cmd === '-h' || cmd === '--help' || !url) { console.log(USAGE); process.exit(url ? 0 : 1); }

const connectOpts = {
  executablePath: flag('--chrome'),
  browserURL: flag('--browser-url'),
  headless: has('--headed', '--show') ? false : undefined, // --headed → a visible window (real GPU, cooler)
  fpsCap: flag('--fps') ? Number(flag('--fps')) : undefined, // raise from the default 10 to watch smoothly
};
out('\n' + '='.repeat(72));
out(`# copse ${cmd} @ ${new Date().toISOString()}`);
out(`# url: ${url}`);

if (cmd === 'scan') {
  const cp = await connect(url, connectOpts);
  try {
    const snap = await cp.snapshot();
    const inter = await cp.interactive();
    const labels = snap.filter((d) => d.label != null).map((d) => ({ ref: d.ref, label: d.label }));
    out('='.repeat(72));
    out(`nodes: ${snap.length} | buttons: ${inter.length} | labels: ${labels.length}`);
    out('\ninteractive:\n' + J(inter));
    out('\nlabels:\n' + J(labels));
  } finally { await cp.close(); }
} else if (cmd === 'ai') {
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
  const cp = await connect(url, connectOpts);
  try {
    const report = await runHarness(cp, agent, { context: { goal }, maxRounds: Number(flag('--rounds', '1')) });
    out('\n===== DONE ===== pass: ' + report.pass + ' | rounds: ' + report.rounds.length);
    const u = agent.usage ? agent.usage() : null;
    if (u) out(`cost: $${u.cost.toFixed(4)} | ${u.calls} claude -p calls | tokens in/out ${u.inputTokens}/${u.outputTokens}` + (u.cost === 0 ? '  (cost $0 → likely a Claude subscription, not API billing)' : ''));
    process.exitCode = report.pass ? 0 : 1;
  } finally { await cp.close(); }
} else {
  console.error(`unknown command: ${cmd}\n\n` + USAGE); process.exit(1);
}
if (sink) sink.end();
