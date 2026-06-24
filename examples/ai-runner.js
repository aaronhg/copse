// @ts-check
// Programmatic AI-driver usage (the library path). The CLI `copse ai <url> --goal …`
// is a thin wrapper over exactly this. Run:  node examples/ai-runner.js <url> "<goal>"
//   npm run build           # once → dist/copse.inject.js
//   npm i -D puppeteer-core # the browser driver (peer dep)
import { runHarness } from '../src/index.js';
import { connect } from '../src/drivers/puppeteer.js';       // copse/driver-puppeteer
import { makeClaudeAgent } from '../src/agents/claude.js';   // copse/agent-claude

const [url, goal] = process.argv.slice(2);
if (!url || !goal) { console.error('usage: node examples/ai-runner.js <url> "<goal>"'); process.exit(1); }

const cp = await connect(url);                       // launch browser + inject copse → Driver
const agent = makeClaudeAgent({                       // claude -p agent, your goal woven in
  goal,
  stopCondition: 'stop once the goal is verified, or after the round budget',
  reportFormat: 'a short markdown report: "## Result" PASS/FAIL, one bullet per round, one-line verdict',
  onStage: (stage, info) => console.log(`[${stage}] ${JSON.stringify(info).slice(0, 240)}`),
});
try {
  const report = await runHarness(cp, agent, { context: { goal }, maxRounds: 3 });
  console.log('\npass:', report.pass, '\n' + (report.summary || ''));
  process.exitCode = report.pass ? 0 : 1;
} finally { await cp.close(); }
