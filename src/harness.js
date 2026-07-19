// @ts-check
import { snapshot as snap, press, get, call, reachable as coreReachable } from './core/index.js';
// The deterministic FLOW EXECUTOR — `execute(driver, steps)` runs a step list against copse's live-page
// driver and reports the FACTS (extractFacts): unreachable/errored/undriven presses, uncertain actions,
// shown-but-not-drawn nodes. NO agent, NO loop, NO pass/fail verdict — that's policy, and policy is the
// consumer's (arbor drives this with its own plan→execute→judge loop + veto). Pure over the Driver
// adapter, so it's testable in Node against a fake tree; the real Playwright wiring lives at the edge.
//
// The verdict is intentionally NOT decided here — a press to a covered button, a handler that threw, a
// press that drove nothing are reported as FACTS; whether any of them fails a run is the consumer's call.

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
 * @property {string} [note]  free-text intent, surfaced to the log
 */

/**
 * The DETERMINISTIC rails — copse proxied into the live page. In production each
 * method is a `page.evaluate(... __copse.X ...)`; in tests it's the fake tree.
 * Methods may be sync or async — `execute` awaits either.
 * @typedef {Object} Driver
 * @property {(opts?:any)=>any} snapshot
 * @property {()=>any} interactive
 * @property {(ref:string,opts?:any)=>any} press
 * @property {(sel:string)=>any} get
 * @property {(sel:string,...args:any[])=>any} call
 * @property {(sel:string)=>any} [reachable]   OPTIONAL: surfaces the `unreachable` fact for a covered button
 * @property {(ref:string)=>any} [visualCheck] OPTIONAL: surfaces the `visual` fact (shown-but-not-drawn)
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
 * Extract the harness-level FACTS from a flat list of executed steps — the observations copse can state
 * as fact (not opinion): a press to an unreachable button, a step that threw / logged an error, a press
 * that drove nothing, an unconfirmable (uncertain) press, and a shown-but-not-drawn (visual) node. A
 * consumer applies its OWN veto/verdict over these; copse never decides pass/fail here.
 * @param {Array<{step:Step, result:any}>} steps
 * @returns {{unreachable:Array<{ref:string, blockedBy:any}>, errored:Array<{ref:string, error:string}>, undriven:Array<{ref:string}>, uncertain:Array<{ref:string, why:string}>, visual:Array<{press:string, node:string, reason:string}>}}
 */
export function extractFacts(steps) {
  const S = steps || [];
  return {
    unreachable: S.filter((s) => s.result && s.result.unreachable).map((s) => ({ ref: s.step.ref, blockedBy: s.result.unreachable })),
    errored: S.filter((s) => s.result && ((s.result.errors && s.result.errors.length) || s.result.reason === 'threw')).map((s) => ({ ref: s.step.ref || s.step.sel || s.step.op, error: s.result.reason === 'threw' ? s.result.error : s.result.errors[0].text })),
    undriven: S.filter((s) => s.result && s.result.drove === 'nothing').map((s) => ({ ref: s.step.ref })),
    uncertain: S.filter((s) => s.result && s.result.uncertain).map((s) => ({ ref: s.step.ref, why: s.result.uncertain })),
    visual: S.filter((s) => s.result && s.result.blankVisual).flatMap((s) => s.result.blankVisual.map((b) => ({ press: s.step.ref || s.step.sel || s.step.op, node: b.ref, reason: b.reason }))),
  };
}

/**
 * The DETERMINISTIC executor (the FlowTrace rail): run a step list against the driver and report the
 * per-step results + the harness FACTS — NO agent, NO loop, NO verdict. This is copse's whole AI-testing
 * surface now: a consumer (arbor) builds its own plan→execute→judge loop and its own veto over these
 * facts. `reachableGate`/`visualGate` only toggle whether the reachability / pixel FACTS are gathered.
 * @param {Driver} driver @param {Step[]} steps
 * @param {{reachableGate?:boolean, visualGate?:boolean, visualMax?:number}} [opts] fact-gathering toggles (NOT a verdict)
 * @returns {Promise<{steps:Array<{step:Step, result:any}>, facts:ReturnType<typeof extractFacts>}>}
 */
export async function execute(driver, steps, opts = {}) {
  const { reachableGate = true, visualGate = true, visualMax = 4 } = opts;
  const gates = { reachableGate, visualGate, visualMax };
  const executed = [];
  for (const step of steps || []) executed.push({ step, result: await execStep(driver, step, gates) });
  return { steps: executed, facts: extractFacts(executed) };
}

// NOTE: the AI-driver LOOP (runHarness: plan → execute → judge → iterate + a batteries-included gate
// verdict) + the `claude -p` agent moved to arbor — the loop shape and the pass/fail verdict are policy,
// which is arbor's layer. copse stays deterministic: `execute` (above) runs a step list and reports the
// FACTS; arbor owns the loop (its runLoop) and decides what the facts mean. The `copse ai` CLI verb +
// src/agents/claude.js went with it.

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
