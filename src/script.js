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
 * @property {'press'|'get'|'call'|'snapshot'|'interactive'|'node'|'reachable'|'eval'|'logs'|'sleep'|'pmGet'|'pmSet'|'pmState'|'pmCall'|'pmPatch'|'pmNotify'|'framework'|'registerFramework'|'patch'|'patchClear'|'watch'|'network'|'diff'|'listeners'|'orient'|'probe'|'patchCalls'|'clickSurface'|'screenshot'|'visualCheck'|'captureBaseline'|'hold'|'release'|'holdStatus'} op
 * @property {string} [ref]    node ref — press / node / reachable / listeners / visualCheck
 * @property {string} [sel]    selector — get / call / pmGet / pmSet / pmCall / patch / pmPatch / patchCalls
 * @property {any[]} [args]    arguments — call / pmCall
 * @property {any} [opts]      options passthrough — press / snapshot / reachable / watch / network / clickSurface / screenshot / visualCheck / captureBaseline
 * @property {string} [expr]   expression — eval
 * @property {number} [ms]     duration — sleep
 * @property {number} [since]  log index — logs
 * @property {any} [before]    earlier snapshot — diff
 * @property {any} [after]     later snapshot — diff
 * @property {boolean} [write] legacy pmState write flag (pmSet always writes)
 * @property {any} [value]     value to write — pmSet (or legacy pmState)
 * @property {any} [adapter]   framework adapter (config/code src) — registerFramework
 * @property {any} [hooks]     {before?,after?,replace?,trace?} — patch / pmPatch
 * @property {string} [name]   notification name — pmNotify
 * @property {any} [body]      notification body — pmNotify
 * @property {string} [type]   notification type — pmNotify
 * @property {string} [note]   free-text intent, echoed in the report
 * @property {any} [expect]    subset-match assertion on the result
 * @property {boolean} [allowErrors]  don't fail this step on result.errors (opts out of the errors gate entirely)
 * @property {string|string[]} [ignoreErrors]  regex (or list, OR-joined) — errors whose `text` matches are
 *   dropped from the errors GATE (still kept in result.errors); silences known background noise (SSE/MIME/aborted)
 * @property {'all'|'uncaught'|'off'} [errorGate]  gate source floor: 'all' (default: any console-error/throw),
 *   'uncaught' (only a real throw — level 'pageerror' — fails; console.error tolerated), 'off' (= allowErrors)
 * @property {boolean} [capture]  force/suppress capturing THIS passing step's (truncated) result: true = capture
 *   any op, false = suppress even a READ op's auto-capture. Omit → read ops auto-capture, others don't.
 */

/**
 * @typedef {Object} Script
 * @property {string} [name]
 * @property {boolean} [continueOnFail]  keep running after a failed step (default: stop)
 * @property {string|string[]} [ignoreErrors]  errors-gate noise filter applied to EVERY step (a step's own overrides)
 * @property {'all'|'uncaught'|'off'} [errorGate]  errors-gate source floor for EVERY step (a step's own overrides)
 * @property {boolean} [capture]  capture EVERY passing step's (truncated) result (opt-in; overrides the per-op default)
 * @property {ScriptStep[]} steps
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// READ ops whose whole point is the value they return — a green one that omitted its value read as
// counterintuitive ("active is… what?"), forcing a redundant single-shot pm_get/eval to peek. So a
// passing read AUTO-captures its (truncated) result; `capture:false` on the step opts out. Actuations
// (press/call/pmCall/…) and the big list ops (snapshot/interactive/clickSurface/watch/network/logs) stay
// silent unless `capture:true` — their result is large and usually asserted via `expect`, not eyeballed.
const READ_OPS = new Set(['get', 'pmGet', 'node', 'reachable', 'framework', 'probe', 'orient', 'listeners', 'patchCalls', 'diff', 'holdStatus']);

// Cap a result so a captured whole-scene snapshot doesn't bloat the output: long arrays keep the first 12
// (+ a marker), long strings sliced, depth bounded. The SAME truncation dump_script applies to `observed`,
// so a captured live-run value and a dumped step read identically. Imported by tools.js (one copy).
export const truncate = (v, depth = 0) => {
  if (v === null || typeof v !== 'object') return typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '…' : v;
  if (depth >= 6) return '…(deep)';
  if (Array.isArray(v)) {
    const head = v.slice(0, 12).map((x) => truncate(x, depth + 1));
    if (v.length > 12) head.push(`…(+${v.length - 12} more)`);
    return head;
  }
  const o = {};
  for (const k of Object.keys(v)) o[k] = truncate(v[k], depth + 1);
  return o;
};

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
      case 'reachable':   return need('reachable') || await driver.reachable(step.ref, step.opts || {});
      case 'eval':        return need('eval') || await driver.eval(step.expr);
      case 'logs':        return need('logs') || await driver.logs(step.since || 0);
      // framework-aware + patch ops (frozen from an MCP session by toStep) — same Driver methods.
      case 'pmGet':       return need('pmGet') || await driver.pmGet(step.sel);
      case 'pmSet':       return need('pmSet') || await driver.pmSet(step.sel, step.value);
      // back-compat: an older dumped {op:'pmState', write?/value} routes to the split pmGet/pmSet.
      case 'pmState': { const w = step.write || Object.prototype.hasOwnProperty.call(step, 'value'); return need(w ? 'pmSet' : 'pmGet') || (w ? await driver.pmSet(step.sel, step.value) : await driver.pmGet(step.sel)); }
      case 'pmCall':      return need('pmCall') || await driver.pmCall(step.sel, ...(step.args || []));
      case 'pmPatch':     return need('pmPatch') || await driver.pmPatch(step.sel, step.hooks || {});
      case 'pmNotify':    return need('pmNotify') || await driver.pmNotify(step.name, step.body, step.type);
      case 'framework':   return need('framework') || await driver.framework();
      case 'registerFramework': return need('registerFramework') || await driver.registerFramework(step.adapter);
      case 'patch':       return need('patch') || await driver.patch(step.sel, step.hooks || {});
      case 'patchClear':  return need('patchClear') || await driver.patchClear(step.sel);
      // observational / query ops — so run_script doubles as a BATCH over the FULL driver surface
      // ("do call + pm_call then watch" in one call; steps run back-to-back, no agent-turn latency between).
      case 'watch':       return need('watch') || await driver.watch(step.opts || {});
      case 'network':     return need('network') || await driver.network(step.opts || {});
      case 'diff':        return need('diff') || await driver.diff(step.before, step.after);
      case 'listeners':   return need('listeners') || await driver.listeners(step.ref);
      case 'orient':      return need('orient') || await driver.orient();
      case 'probe':       return need('probe') || await driver.probe();
      case 'patchCalls':  return need('patchCalls') || await driver.patchCalls(step.sel);
      case 'clickSurface': return need('clickSurface') || await driver.clickSurface(step.opts || {});
      case 'screenshot':  return need('screenshot') || await driver.screenshot(step.opts || {});
      case 'visualCheck': return need('visualCheck') || await driver.visualCheck(step.ref, step.opts || {});
      case 'captureBaseline': return need('captureBaseline') || await driver.captureBaseline(step.opts || {});
      // hold/release — freeze the loop at a trigger to screenshot a transient state, then resume (C1)
      case 'hold':        return need('hold') || await driver.hold(step.sel, step.opts || {});
      case 'release':     return need('release') || await driver.release();
      case 'holdStatus':  return need('holdStatus') || await driver.holdStatus();
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
 *          per-step `{step, result}` mirrors runHarness's rounds[].steps. A passing step carries a TRUNCATED
 *          `result` when it's a READ op (auto) or step.capture/script.capture is set (and not capture:false);
 *          other passing steps omit it; failing steps carry the full result whole.
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
      // Two opt-in levers narrow the gate (step overrides script), so a real crash still fails but background
      // noise doesn't: `errorGate` sets the source floor ('uncaught' → only a real throw, level 'pageerror';
      // 'off' → nothing gates), and `ignoreErrors` drops errors whose text matches a regex (a chatty game's
      // SSE/MIME/aborted warnings). Filtered errors stay in result.errors — visible, just not gating.
      const mode = step.errorGate ?? (script && script.errorGate) ?? 'all';
      const ig = step.ignoreErrors ?? (script && script.ignoreErrors);
      let re = null;
      if (ig) { try { re = new RegExp([].concat(ig).join('|'), 'i'); } catch { re = null; } } // bad pattern → no filter (gate stays strict)
      const gateable = mode === 'off' ? [] : result.errors.filter((e) =>
        (mode !== 'uncaught' || (e && e.level === 'pageerror')) && !(re && re.test((e && e.text) || '')));
      if (gateable.length) { rec.ok = false; rec.gate = 'errors'; }
    }
    if (rec.ok && step.op === 'press' && !asserts('drove') && result && result.drove === 'nothing') {
      rec.ok = false; rec.gate = 'drove';
    }
    // Failing steps carry the FULL result (untruncated, for debugging). A passing step carries a
    // TRUNCATED result when it's a READ op (auto — the value is the point), or when opted in via
    // step.capture / script.capture; `capture:false` suppresses even a read's auto-capture. Same
    // truncation as dump_script's `observed`, so a live-run value and a dumped step read identically.
    if (!rec.ok) rec.result = result;
    else if (step.capture !== false && (step.capture === true || READ_OPS.has(step.op) || (script && script.capture))) rec.result = truncate(result);
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
