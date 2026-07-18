// @ts-check
import { snapshot as snap, press, get, call, reachable as coreReachable } from './core/index.js';
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
// the judge's `scope` field. Those two dimensions the agent MUST NOT claim are
// instead supplied as HARNESS-level facts by optional Driver capabilities:
// `reachable` → the reachability hard-fail gate, and `visualCheck` → a "did the
// subtree this action SHOWED actually render on screen" SOFT signal (surfaced as
// out.visual, never a hard fail — see the visualGate below).

/**
 * One copse command the plan wants to run.
 * @typedef {Object} Step
 * @property {'press'|'get'|'call'|'snapshot'|'interactive'|'sleep'|'patch'|'eval'} op
 * @property {string} [ref]   node ref — for `press`
 * @property {string} [sel]   selector — for `get` / `call` / `patch`
 * @property {any[]} [args]   arguments — for `call`
 * @property {any} [opts]     options — for `press` (e.g. `{force:true}`) / `snapshot`
 * @property {number} [ms]    duration — for `sleep`
 * @property {any} [hooks]    {before?,after?,replace?} — for `patch`
 * @property {string} [expr]  expression — for `eval`
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
 * @property {(sel:string)=>any} [reachable]   OPTIONAL: drives the harness's reachability hard-fail gate
 * @property {(ref:string)=>any} [visualCheck] OPTIONAL: drives the harness's visual "did it actually render" soft signal
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

/**
 * Pixel SOFT-signal: after an action whose logic-`diff` (`result.changed`) says a subtree appeared/activated,
 * confirm those nodes actually RENDERED — catches "the tree says the panel opened but the screen is blank"
 * (half-load / missing material / clipped), which the node tree alone can't see. Attaches `result.blankVisual`
 * = the shown-but-not-drawn nodes (soft — never a hard fail; without a baseline only `drawn:false`/`offscreen`
 * is trusted, and even that can misread a solid-colour node — see docs/VISUAL.md). Capability-gated on
 * `driver.visualCheck`, capped at `gates.visualMax` (records the overflow in `result.visualCapped`, no silent
 * truncation). Runs only when the driver exposes pixels — degrades to today's behavior otherwise.
 */
async function visualConfirm(driver, r, gates) {
  if (!(gates.visualGate && typeof driver.visualCheck === 'function' && r && typeof r === 'object' && r.changed)) return;
  const shown = [...(r.changed.appeared || []), ...(r.changed.activated || [])].map((d) => d && d.ref).filter(Boolean);
  const uniq = [...new Set(shown)];
  const n = Math.min(uniq.length, gates.visualMax);
  const blank = [];
  for (let i = 0; i < n; i++) {
    let v; try { v = await driver.visualCheck(uniq[i]); } catch { continue; }
    // reason is DERIVED from state, not v.reason: visualConfirm always calls visualCheck WITHOUT a baseline,
    // so v.reason is 'no-baseline' even for a genuinely blank node — that config-sounding label is exactly
    // the wrong signal here. drawn:false → 'blank'; otherwise the include was for an offscreen node.
    if (v && (v.drawn === false || v.reason === 'offscreen')) blank.push({ ref: uniq[i], reason: v.drawn === false ? 'blank' : 'offscreen' });
  }
  if (blank.length) r.blankVisual = blank;
  if (uniq.length > n) r.visualCapped = uniq.length - n;
}

/** Run one planned step against the driver, capturing throws (doesn't-crash is a signal we WANT). */
async function execStep(driver, step, gates) {
  try {
    switch (step.op) {
      case 'press': {
        // A button copse CAN press (it calls the handler directly) but a player CANNOT reach (covered by an
        // overlay / off-screen) is a REAL fail, not a pass. Check before pressing; honor `force` (explicit
        // override) and skip silently when the driver has no reachability (degrades to today's behavior).
        let unreachable = null, uncertain = null;
        if (gates.reachableGate && !(step.opts && step.opts.force) && typeof driver.reachable === 'function') {
          try {
            const rr = await driver.reachable(step.ref);
            if (rr && rr.reachable === false) unreachable = rr.blockedBy || true;
            else if (rr && (rr.reachable === 'unsure' || rr.occludedBy)) uncertain = rr.occludedBy ? `occluded:${rr.occludedBy}` : 'unsure'; // can't confirm a player reaches/sees it
          } catch { /* best-effort */ }
        }
        const r = await driver.press(step.ref, step.opts);
        if (unreachable && r && typeof r === 'object') r.unreachable = unreachable; // surfaced to judge + hard-failed below
        // a synthetic tap into a button with no VISIBLE handler — verify, don't hard-fail (copse's codeHandlers can miss a real one)
        if (!uncertain && r && Array.isArray(r.drove) && r.drove.length === 1 && r.drove[0] === 'touch' && r.wired === false) uncertain = 'touch-into-void';
        if (uncertain && r && typeof r === 'object') r.uncertain = uncertain; // surfaced as out.uncertain (verify), NOT hard-failed
        await visualConfirm(driver, r, gates); // pixel soft-signal: did the subtree this press SHOWED actually render?
        return r;
      }
      case 'get':         return await driver.get(step.sel);
      case 'call':        { const r = await driver.call(step.sel, ...(step.args || [])); await visualConfirm(driver, r, gates); return r; }
      case 'snapshot':    return await driver.snapshot(step.opts);
      case 'interactive': return await driver.interactive();
      // Timing + setup ops so an AI plan can pace a turn-based/animated game (sleep between
      // presses), pin RNG (patch), or read arbitrary state (eval) — the same vocab the frozen
      // runner (script.js) has. patch/eval degrade to unsupported-op when the driver lacks them.
      case 'sleep':       await new Promise((r) => setTimeout(r, step.ms || 0)); return { ok: true };
      case 'patch':       return typeof driver.patch === 'function' ? await driver.patch(step.sel, step.hooks || {}) : { ok: false, reason: 'unsupported-op', op: step.op };
      case 'eval':        return typeof driver.eval === 'function' ? await driver.eval(step.expr) : { ok: false, reason: 'unsupported-op', op: step.op };
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
 * @param {boolean} [opts.reachableGate]  hard-fail a press to a covered/unreachable button (default true)
 * @param {boolean} [opts.errorGate]  hard-fail a step whose handler threw / logged an error (default true)
 * @param {boolean} [opts.driveGate]  hard-fail a press that drove NOTHING (drove:'nothing') (default true)
 * @param {boolean} [opts.visualGate]  SOFT-surface (out.visual) a subtree an action showed in the logic diff
 *        but that didn't render on screen — needs a driver with `visualCheck` (default true; no-op without it)
 * @param {number} [opts.visualMax]  max nodes to visual-check per action (default 4; each is a screenshot, so
 *        this bounds the added latency — overflow is recorded in result.visualCapped, never silently dropped)
 * @returns {Promise<{pass:boolean, rounds:Array<{round:number, rationale?:string, steps:Array<{step:Step, result:any}>, verdict:Verdict}>, snapshot:any, summary?:any, unreachable?:Array<{ref:string, blockedBy:any}>, errored?:Array<{ref:string, error:string}>, undriven?:Array<{ref:string}>, uncertain?:Array<{ref:string, why:string}>, visual?:Array<{press:string, node:string, reason:string}>}>}
 */
export async function runHarness(driver, agent, opts = {}) {
  const { context = null, maxRounds = 1, reachableGate = true, errorGate = true, driveGate = true, visualGate = true, visualMax = 4 } = opts;
  const gates = { reachableGate, visualGate, visualMax };
  const rounds = [];
  let snapshot = await driver.snapshot();

  for (let round = 0; round < maxRounds; round++) {
    const plan = (await agent.plan({ context, snapshot, rounds, round })) || { steps: [] };

    const steps = [];
    for (const step of plan.steps || []) steps.push({ step, result: await execStep(driver, step, gates) });

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
  // A press that hit a covered/unreachable button is a HARD fail — a real player couldn't have done it, so
  // the flow isn't actually exercisable. This overrides even a passing judge/report (it's a fact, not an
  // opinion). The offending refs are surfaced so the report can explain it. Disable with reachableGate:false.
  const unreachablePresses = rounds.flatMap((r) => (r.steps || []).filter((s) => s.result && s.result.unreachable).map((s) => ({ ref: s.step.ref, blockedBy: s.result.unreachable })));
  // A step whose handler THREW (execStep caught it → reason:'threw') or whose action logged an error / uncaught
  // pageerror (the driver's log-diff → result.errors, catching an engine-swallowed throw a passing ok:true hides)
  // is a HARD fail — "doesn't-crash" must be a fact, not the judge's opinion. Override with errorGate:false.
  const erroredSteps = rounds.flatMap((r) => (r.steps || [])
    .filter((s) => s.result && ((s.result.errors && s.result.errors.length) || s.result.reason === 'threw'))
    .map((s) => ({ ref: s.step.ref || s.step.sel || s.step.op, error: s.result.reason === 'threw' ? s.result.error : s.result.errors[0].text })));
  // A press that actuated NOTHING (drove:'nothing' — no clickEvent fired, no on('click'), no synthetic tap)
  // can't be a passing test: nothing was exercised. Surfaced + hard-failed (a misread `fired:0` as pass is the
  // exact trap this closes). The richer per-step `drove`/`wired` lets the agent reason about the touch-into-void
  // case (drove:['touch'], wired:false). Override with driveGate:false.
  const undrivenPresses = rounds.flatMap((r) => (r.steps || []).filter((s) => s.result && s.result.drove === 'nothing').map((s) => ({ ref: s.step.ref })));
  // SURFACED but NOT hard-failed: a press copse couldn't confirm a player reaches/sees (reachable:'unsure' / occludedBy)
  // or a synthetic tap into a no-visible-handler button. Fail-loud uncertainty reaches the report instead of a silent pass.
  const uncertainSteps = rounds.flatMap((r) => (r.steps || []).filter((s) => s.result && s.result.uncertain).map((s) => ({ ref: s.step.ref, why: s.result.uncertain })));
  // SOFT (surfaced, never a hard fail — like uncertain): a node the action's logic diff showed (appeared/
  // activated) that did NOT render on screen (drawn:false / offscreen). "Tree says the panel opened, screen is
  // blank." Left for the judge/report to weigh — no baseline here, so we don't auto-fail (see visualConfirm).
  const blankVisuals = rounds.flatMap((r) => (r.steps || []).filter((s) => s.result && s.result.blankVisual).flatMap((s) => s.result.blankVisual.map((b) => ({ press: s.step.ref || s.step.sel || s.step.op, node: b.ref, reason: b.reason }))));
  const out = { pass: pass && unreachablePresses.length === 0 && (!errorGate || erroredSteps.length === 0) && (!driveGate || undrivenPresses.length === 0), rounds, snapshot };
  if (unreachablePresses.length) out.unreachable = unreachablePresses;
  if (erroredSteps.length) out.errored = erroredSteps;
  if (undrivenPresses.length) out.undriven = undrivenPresses;
  if (uncertainSteps.length) out.uncertain = uncertainSteps;
  if (blankVisuals.length) out.visual = blankVisuals;
  // AI ④ (optional). Returning `{ pass, summary }` sets the OVERALL verdict + summary
  // (overrides the per-round AND); any other return value is treated as the summary.
  if (agent.report) {
    const rep = await agent.report({ context, rounds, pass: out.pass, snapshot, unreachable: unreachablePresses });
    if (rep && typeof rep === 'object' && 'pass' in rep) { out.pass = rep.pass; out.summary = rep.summary; }
    else out.summary = rep;
  }
  if (unreachablePresses.length) out.pass = false; // hard gate: not even the report can pass over an unreachable press
  if (errorGate && erroredSteps.length) out.pass = false; // hard gate: a handler that threw / logged an error is never a pass
  if (driveGate && undrivenPresses.length) out.pass = false; // hard gate: a press that drove nothing isn't a pass
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
    reachable: (sel) => coreReachable(root, rt, sel), // degrades to {reason:'unsupported'} when rt has no reachable
  };
}
