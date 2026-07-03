// @ts-check
// Deterministic script runner — replay a FROZEN test flow (JSON steps + subset-match
// assertions, see docs/SCRIPTS.md) over the same Driver adapter runHarness uses.
// The zero-LLM half of the test loop: an agent explores once (an MCP session, or
// runHarness), the flow is frozen into a script, and this replays it forever — CI-grade,
// no opinions. Pure + zero-dep like harness.js: testable in Node against a fake driver.
//
// Judgment per step:
//   • `expect` present → subsetMatch(expect, result) decides (assert ok:false flows too).
//   • `expect` absent  → result.ok !== false.
//   plus the same FACT gates runHarness applies over the judge's opinion:
//   • errors gate — result.errors (a handler that threw / logged a console error) fails
//     the step even when `expect` matched, unless `allowErrors:true` OR the expect
//     explicitly asserts `errors` (an explicit assertion overrides the gate).
//   • drove gate — a press with drove:'nothing' (actuated nothing) fails, unless the
//     expect explicitly asserts `drove`.

/**
 * A script step — the harness's `Step` shape plus assertion fields, so steps freeze 1:1
 * out of runHarness rounds and recorded MCP tool calls.
 * @typedef {Object} ScriptStep
 * @property {'press'|'get'|'call'|'snapshot'|'interactive'|'node'|'reachable'|'eval'|'logs'|'sleep'} op
 * @property {string} [ref]    node ref — press / node / reachable
 * @property {string} [sel]    selector — get / call
 * @property {any[]} [args]    arguments — call
 * @property {any} [opts]      options passthrough — press ({force, reachableGate}) / snapshot
 * @property {string} [expr]   expression — eval
 * @property {number} [ms]     duration — sleep
 * @property {number} [since]  log index — logs
 * @property {string} [note]   free-text intent, echoed in the report
 * @property {any} [expect]    subset-match assertion on the result
 * @property {boolean} [allowErrors]  don't fail this step on result.errors
 */

/**
 * @typedef {Object} Script
 * @property {string} [name]
 * @property {boolean} [continueOnFail]  keep running after a failed step (default: stop)
 * @property {ScriptStep[]} steps
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * expected ⊆ actual. Primitives `===`; objects: every expected key must subset-match;
 * arrays are CONTAINS (each expected element must subset-match SOME actual element).
 * @returns {null | {path:string, expected:any, actual:any}} null on match, else the first mismatch.
 */
export function subsetMatch(expected, actual, path = '') {
  const at = path || '(root)';
  if (expected === null || typeof expected !== 'object') {
    return expected === actual ? null : { path: at, expected, actual };
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return { path: at, expected, actual };
    for (let i = 0; i < expected.length; i++) {
      if (!actual.some((a) => !subsetMatch(expected[i], a))) return { path: `${at}[${i}]`, expected: expected[i], actual };
    }
    return null;
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return { path: at, expected, actual };
  for (const k of Object.keys(expected)) {
    const m = subsetMatch(expected[k], actual[k], path ? `${path}.${k}` : k);
    if (m) return m;
  }
  return null;
}

/** Run one step against the driver, capturing throws (a crash is a signal, not a runner failure). */
async function execStep(driver, step) {
  const need = (method) => {
    if (typeof driver[method] !== 'function') return { ok: false, reason: 'unsupported-op', op: step.op };
    return null;
  };
  try {
    switch (step.op) {
      case 'press':       return need('press') || await driver.press(step.ref, step.opts);
      case 'get':         return need('get') || await driver.get(step.sel);
      case 'call':        return need('call') || await driver.call(step.sel, ...(step.args || []));
      case 'snapshot':    return need('snapshot') || await driver.snapshot(step.opts);
      case 'interactive': return need('interactive') || await driver.interactive();
      case 'node':        return need('node') || await driver.node(step.ref);
      case 'reachable':   return need('reachable') || await driver.reachable(step.ref);
      case 'eval':        return need('eval') || await driver.eval(step.expr);
      case 'logs':        return need('logs') || await driver.logs(step.since || 0);
      default:            return { ok: false, reason: 'unknown-op', op: step.op };
    }
  } catch (e) {
    return { ok: false, reason: 'threw', error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Replay a script. Linear, deterministic; a failed step stops the run (later steps
 * depend on earlier state) unless `script.continueOnFail`.
 * @param {any} driver  the same Driver adapter runHarness consumes
 * @param {Script} script
 * @returns {Promise<{pass:boolean, name?:string, failedAt?:number, steps:Array<{step:ScriptStep, ok:boolean, ms:number, result?:any, mismatch?:{path:string,expected:any,actual:any}, gate?:'errors'|'drove'}>}>}
 *          per-step `{step, result}` mirrors runHarness's rounds[].steps. Passing steps
 *          omit `result`; failing steps carry it whole for debugging.
 */
export async function runScript(driver, script) {
  const out = { pass: true, steps: [] };
  if (script && script.name) out.name = script.name;
  for (const step of (script && script.steps) || []) {
    const t0 = Date.now();
    if (step.op === 'sleep') {
      await sleep(step.ms || 0);
      out.steps.push({ step, ok: true, ms: Date.now() - t0 });
      continue;
    }
    const result = await execStep(driver, step);
    /** @type {any} */
    const rec = { step, ok: true, ms: Date.now() - t0 };
    const expected = step.expect;
    if (expected !== undefined) {
      const m = subsetMatch(expected, result);
      if (m) { rec.ok = false; rec.mismatch = m; }
    } else if (result && result.ok === false) {
      rec.ok = false;
    }
    // fact gates (mirror runHarness's errorGate/driveGate) — an explicit expect on the
    // gated field overrides the gate; `allowErrors` opts out of the errors gate.
    const asserts = (k) => expected !== null && typeof expected === 'object' && !Array.isArray(expected) && k in expected;
    if (rec.ok && !step.allowErrors && !asserts('errors') && result && Array.isArray(result.errors) && result.errors.length) {
      rec.ok = false; rec.gate = 'errors';
    }
    if (rec.ok && step.op === 'press' && !asserts('drove') && result && result.drove === 'nothing') {
      rec.ok = false; rec.gate = 'drove';
    }
    if (!rec.ok) rec.result = result;
    out.steps.push(rec);
    if (!rec.ok) {
      out.pass = false;
      if (out.failedAt === undefined) out.failedAt = out.steps.length - 1;
      if (!(script && script.continueOnFail)) break;
    }
  }
  if (!out.steps.length) out.pass = false; // an empty script proves nothing
  return out;
}
