// @ts-check
import { snapshot as snap, press, get, call } from './core/index.js';
// AI-driver harness — the autonomous test loop that sits ON TOP of copse's
// primitives. Like the core (pure over a `Runtime`), this is pure over two
// adapters, so the whole loop is testable in Node against fakes; the real
// Playwright wiring and the real LLM call live only at the adapter edges
// (see examples/ai-driver.md), keeping the package zero-dep.
//
// The decoupling makes the AI intervention points LITERAL code seams —
// everything else is the deterministic rail copse provides:
//
//   agent.plan(ctx)   → AI ①  judge diff+snapshot, decide what to test +
//                              the EXPECTED outcome (the oracle), emit steps
//   driver.<op>(...)  → 機械   execute press/get/call against the live page
//   agent.judge(ctx)  → AI ②  state delta vs expectation → pass/fail
//   agent.next(ctx)   → AI ③  coverage/iterate decision (optional; default: stop)
//   agent.report(ctx) → AI ④  shape the final report (optional; absent ⇒ no summary)
//
// Per-stage guidance is the AGENT's job, not the harness's — the harness stays
// prompt-agnostic. Every stage receives `ctx.context` verbatim (whatever you put
// in `opts.context`), so per-run direction — test goal, stop condition, report
// format — flows through there; static direction is baked into the agent (e.g. a
// `makeAgent({goal, stopCondition, reportFormat})` factory, see examples).
//
// The AI's verdict is scoped to LOGIC/FLOW only — it is fed the node tree, not
// pixels, so it must not claim rendering/reachability correctness (a covered or
// off-screen button passes here but fails for a real player). Surface that in
// the judge's `scope` field.

/**
 * One copse command the plan wants to run.
 * @typedef {Object} Step
 * @property {'press'|'get'|'call'|'snapshot'|'interactive'} op
 * @property {string} [ref]   node ref — for `press`
 * @property {string} [sel]   selector — for `get` / `call`
 * @property {any[]} [args]   arguments — for `call`
 * @property {any} [opts]     options — for `press` (e.g. `{force:true}`) / `snapshot`
 * @property {string} [note]  free-text intent, surfaced to the judge/log
 */

/**
 * The DETERMINISTIC rails — copse proxied into the live page. In production each
 * method is a `page.evaluate(... __copse.X ...)`; in tests it's the fake tree.
 * Methods may be sync or async — the harness awaits either.
 * @typedef {Object} Driver
 * @property {(opts?:any)=>any} snapshot
 * @property {()=>any} interactive
 * @property {(ref:string,opts?:any)=>any} press
 * @property {(sel:string)=>any} get
 * @property {(sel:string,...args:any[])=>any} call
 */

/**
 * @typedef {Object} Plan
 * @property {string} [rationale]   why these steps, given the diff + snapshot
 * @property {Step[]} steps
 */

/**
 * @typedef {Object} Verdict
 * @property {boolean} pass
 * @property {string} [reason]
 * @property {string} [scope]   e.g. 'logic' — must NOT claim visual/reachability
 */

/**
 * The AI seams. Each wraps an LLM call in production (see examples). Every method
 * receives `ctx.context` (your `opts.context`) so you can steer it per run — test
 * goal, stop condition, report format.
 * @typedef {Object} Agent
 * @property {(ctx:any)=>(Plan|Promise<Plan>)} plan         AI ① judge + plan (oracle)
 * @property {(ctx:any)=>(Verdict|Promise<Verdict>)} judge  AI ② pass/fail
 * @property {(ctx:any)=>({continue:boolean,reason?:string}|Promise<{continue:boolean,reason?:string}>)} [next]
 *           AI ③ coverage/iterate decision — optional; absent ⇒ stop after one round.
 * @property {(ctx:any)=>any} [report]  AI ④ final report. Receives `{ context, rounds, pass,
 *           snapshot }`. Return `{ pass, summary }` to set the OVERALL verdict + summary (it
 *           alone sees every round / the whole goal); any other return value is the summary
 *           (overall pass stays the per-round AND). Optional; absent ⇒ no `summary`.
 */

/** Run one planned step against the driver, capturing throws (doesn't-crash is a signal we WANT). */
async function execStep(driver, step) {
  try {
    switch (step.op) {
      case 'press':       return await driver.press(step.ref, step.opts);
      case 'get':         return await driver.get(step.sel);
      case 'call':        return await driver.call(step.sel, ...(step.args || []));
      case 'snapshot':    return await driver.snapshot(step.opts);
      case 'interactive': return await driver.interactive();
      default:            return { ok: false, reason: 'unknown-op', op: step.op };
    }
  } catch (e) {
    return { ok: false, reason: 'threw', error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Run the AI-driver loop: discover → (plan → execute → judge) → maybe iterate.
 * Policy-free by design — the agent decides what/whether; the harness only
 * sequences, captures results, and bounds the rounds.
 * @param {Driver} driver
 * @param {Agent} agent
 * @param {Object} [opts]
 * @param {any} [opts.context]     anything the agent needs + per-run guidance
 *        (e.g. `{ diff, goal, stopCondition, reportFormat }`) — passed verbatim to every stage.
 * @param {number} [opts.maxRounds]  hard cap on iterations (default 1)
 * @returns {Promise<{pass:boolean, rounds:Array<{round:number, rationale?:string, steps:Array<{step:Step, result:any}>, verdict:Verdict}>, snapshot:any, summary?:any}>}
 */
export async function runHarness(driver, agent, opts = {}) {
  const { context = null, maxRounds = 1 } = opts;
  const rounds = [];
  let snapshot = await driver.snapshot();

  for (let round = 0; round < maxRounds; round++) {
    const plan = (await agent.plan({ context, snapshot, rounds, round })) || { steps: [] };

    const steps = [];
    for (const step of plan.steps || []) steps.push({ step, result: await execStep(driver, step) });

    const verdict = await agent.judge({ context, snapshot, plan, steps, rounds, round });
    rounds.push({ round, rationale: plan.rationale, steps, verdict });

    if (!agent.next) break;                       // default policy: one round
    const cont = await agent.next({ context, snapshot, rounds, round });
    if (!cont || !cont.continue) break;
    if (round < maxRounds - 1) snapshot = await driver.snapshot(); // re-discover only if another round will run
  }

  // Per-round AND is a weak overall verdict: a multi-round goal's early rounds legitimately
  // judge "not complete yet". So this is only the FALLBACK — the report (which alone sees
  // every round / the whole goal) is the authoritative verdict when it provides one.
  const pass = rounds.length > 0 && rounds.every((r) => r.verdict && r.verdict.pass !== false);
  const out = { pass, rounds, snapshot };
  // AI ④ (optional). Returning `{ pass, summary }` sets the OVERALL verdict + summary
  // (overrides the per-round AND); any other return value is treated as the summary.
  if (agent.report) {
    const rep = await agent.report({ context, rounds, pass, snapshot });
    if (rep && typeof rep === 'object' && 'pass' in rep) { out.pass = rep.pass; out.summary = rep.summary; }
    else out.summary = rep;
  }
  return out;
}

/**
 * Build a copse Driver over an in-process scene + Runtime — the same shape the
 * Playwright `page.evaluate` driver has, but synchronous and engine-free. Use it
 * for tests and for a same-process engine; for a real browser game, wire a
 * driver whose methods are `page.evaluate(... __copse.X ...)` (see examples).
 * @param {any} root @param {import('./core/index.js').Runtime} rt
 * @returns {Driver}
 */
export function localDriver(root, rt) {
  return {
    snapshot: (opts) => snap(root, rt, opts),
    interactive: () => snap(root, rt, { onlyInteractive: true }),
    press: (ref, opts) => press(root, rt, ref, opts),
    get: (sel) => get(root, rt, sel),
    call: (sel, ...args) => call(root, rt, sel, args),
  };
}
