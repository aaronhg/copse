// @ts-check
// OPTIONAL agent (subpath `copse/agent-claude`). An Agent for runHarness backed by the
// `claude -p` CLI — no API key plumbing, no npm dep (just the `claude` CLI on PATH).
// Weave your test GOAL (and stop condition / report format) into each stage.
import { execFileSync } from 'node:child_process';

const SYS =
  'You drive a LIVE Cocos game through copse — call wired handlers and read component state; ' +
  'you do NOT see pixels. Test LOGIC/FLOW only (a covered/off-screen button still "passes"; ' +
  'use the `reachable` field to judge coverage).\n' +
  'Steps are copse commands. Field rules (copy exactly):\n' +
  '  press → {"op":"press","ref":"Node/Path"}                         (ref = node path)\n' +
  '  get   → {"op":"get","sel":"Node/Path:Comp.member"}               (sel = FULL path; Comp can be `Node` for active/opacity/etc.)\n' +
  '  call  → {"op":"call","sel":"Node/Path:Comp.method","args":[]}\n' +
  '  interactive/snapshot → {"op":"interactive"} / {"op":"snapshot"}\n' +
  'For get/call the whole "Node/Path:Comp.member" goes in sel — never split the path into ref. ' +
  'press/call results include a `changed` summary ({activated, appeared, deactivated, labelChanged}) ' +
  'auto-computed AFTER the action settles (tweens included). appeared/activated/deactivated entries are ' +
  'node DESCRIPTORS (ref + label/button/click) — read panel contents (titles/costs/options) straight from ' +
  'them; you usually do NOT need separate snapshot/diff steps. A toggle opens/closes with the SAME control: ' +
  'press once and read `changed`; do not press twice or also call its handler. ' +
  'CRITICAL: every ref/sel MUST be copied VERBATIM from a snapshot or a `changed` entry — never ' +
  'retype, abbreviate, guess, or change the capitalisation of a path (e.g. mainFeaturePanel ≠ MainFeaturePanel).';

const trim = (snap) => (snap || []).filter((d) => d.button || d.label || d.interactable)
  .map((d) => ({ ref: d.ref, button: d.button, interactable: d.interactable, reachable: d.reachable, label: d.label, click: d.click }));
const parseJson = (s) => { const f = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i); const b = f ? f[1] : s; try { return JSON.parse(b); } catch { const m = b.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('agent did not return JSON: ' + s.slice(0, 200)); } };

/**
 * Build an Agent for runHarness, driven by `claude -p`. Your guidance is woven into the
 * stages: `goal` → plan + judge, `stopCondition` → next (omit ⇒ single round), `reportFormat`
 * → report (omit ⇒ no summary). `onStage(stage, info)` is an optional progress hook.
 * @param {{goal?:string, stopCondition?:string, reportFormat?:string, model?:string, onStage?:(stage:string,info:any)=>void}} [opts]
 */
export function makeClaudeAgent({ goal = '', stopCondition = '', reportFormat = '', model = 'sonnet', onStage } = {}) {
  const tell = (stage, info) => { if (onStage) onStage(stage, info); };
  const g = goal ? `\nTEST GOAL: ${goal}` : '';
  // Accumulate cost/tokens across every claude -p call (envelope carries total_cost_usd + usage).
  const usage = { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
  const ask = (instruction, payload, json = true) => {
    const out = execFileSync('claude', ['-p', '--output-format', 'json', '--system-prompt', SYS, '--model', model],
      { input: `${instruction}\n\nINPUT:\n${JSON.stringify(payload)}`, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: '/tmp' });
    const env = JSON.parse(out);
    usage.calls++;
    usage.last = { cost: env.total_cost_usd || 0, inputTokens: env.usage?.input_tokens || 0, outputTokens: env.usage?.output_tokens || 0 };
    usage.cost += usage.last.cost; usage.inputTokens += usage.last.inputTokens; usage.outputTokens += usage.last.outputTokens;
    return json ? parseJson(env.result) : env.result;
  };

  /** @type {any} */
  const agent = {
    plan: ({ context, snapshot, round }) => {
      const out = ask('Plan press/get/call steps for THIS round, including get/snapshot to capture state before/after.' + g +
        ' Return ONLY JSON {rationale, steps:[{op,ref?,sel?,args?,note?}]}.', { round, context, snapshot: trim(snapshot) });
      tell('plan', { round, ...out, cost: usage.last });
      return out;
    },
    judge: ({ plan, steps, round }) => {
      const out = ask('Judge whether THIS round\'s executed steps behaved CORRECTLY (no errors; each action ' +
        'produced its expected local effect). pass=false ONLY if a result CONTRADICTS expected behaviour (a real ' +
        'bug). Do NOT fail just because the overall multi-part goal is not complete yet — later rounds continue it.' + g +
        ' Return ONLY JSON {pass, reason, scope:"logic"}.', { round, rationale: plan.rationale, steps });
      tell('judge', { round, steps, verdict: out, cost: usage.last });
      return out;
    },
  };
  if (stopCondition) agent.next = ({ rounds, round }) => {
    // Feed `next` the steps ACTUALLY executed (op/ref/ok + changed-counts), not just verdicts —
    // otherwise it has no evidence and confabulates "all done". Mirrors what `judge` sees.
    const done = (rounds || []).map((r) => ({
      round: r.round, verdict: r.verdict,
      did: (r.steps || []).map((s) => {
        const c = s.result && s.result.changed;
        return { op: s.step.op, ref: s.step.ref || s.step.sel, ok: !!(s.result && s.result.ok !== false),
          changed: c ? { appeared: (c.appeared || []).length, disappeared: (c.disappeared || []).length, activated: (c.activated || []).length, deactivated: (c.deactivated || []).length, labelChanged: (c.labelChanged || []).length } : undefined };
      }),
    }));
    const out = ask('Decide whether to run another round. STOP CONDITION: ' + stopCondition + g +
      ' `rounds` below lists every step ACTUALLY executed so far. Set continue:false ONLY if those executed ' +
      'steps already prove EVERY required check; if any required action is NOT present in the executed steps, ' +
      'you MUST continue. NEVER claim an action happened that is not listed. Return ONLY JSON {continue, reason}.',
      { round, rounds: done });
    tell('next', { round, decision: out, cost: usage.last });
    return out;
  };
  if (reportFormat) agent.report = ({ rounds, pass }) => {
    const out = ask('Give the OVERALL verdict over ALL rounds and write the report. pass=true only if the GOAL ' +
      'is fully achieved by the executed steps (cite evidence); pass=false if any required check was never ' +
      'executed or a result contradicts the goal.' + g + ' summary FORMAT: ' + reportFormat +
      ' Return ONLY JSON {pass: boolean, summary: "<the report as one markdown string>"}.', { pass, rounds });
    tell('report', { summary: out.summary, pass: out.pass, cost: usage.last });
    return out;   // { pass, summary }
  };
  agent.usage = () => ({ ...usage });   // cumulative cost/tokens across all claude -p calls
  return agent;
}
