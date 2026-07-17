// @ts-check
// Pure JUnit XML emitter — turns copse script results into the report format every CI
// system parses (GitHub / GitLab / Jenkins → per-test green/red as PR checks + inline
// annotations on the failing step). Zero-dep, no I/O: the CLI writes the returned string.
//
// One <testcase> per STEP (not per script), so a failure annotates the exact step —
// `shop-open · open the shop panel` rather than a whole-file pass/fail. The failure
// message is the same mismatch/gate detail runScript records, so a red PR check reads
// like the local run.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** A failing step's human reason, from the same fields runScript sets. */
function reason(st) {
  if (st.mismatch) return `expected ${JSON.stringify(st.mismatch.expected)} at ${st.mismatch.path}, got ${JSON.stringify(st.mismatch.actual)}`;
  if (st.gate) return `${st.gate} gate: the action ${st.gate === 'drove' ? 'actuated nothing' : 'logged an error / threw'}`;
  if (st.result && st.result.reason) return String(st.result.reason);
  return 'step failed';
}

const label = (st, i) => st.step?.note || `${st.step?.op || ''} ${st.step?.ref || st.step?.sel || ''}`.trim() || `step ${i}`;

/**
 * @param {Array<{name:string, result:{pass:boolean, steps:Array<{step:any, ok:boolean, ms:number, mismatch?:any, gate?:string, result?:any}>}}>} suites
 * @returns {string} JUnit XML (one <testsuite> per script, one <testcase> per step)
 */
export function toJUnit(suites) {
  let tests = 0, failures = 0, time = 0;
  const chunks = [];
  for (const s of suites) {
    const steps = s.result.steps || [];
    const cases = [];
    let sfail = 0, stime = 0;

    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      const t = (st.ms || 0) / 1000;
      stime += t;
      const open = `    <testcase name="${esc(`${s.name} · ${label(st, i)}`)}" classname="${esc(s.name)}" time="${t.toFixed(3)}">`;
      if (st.ok) {
        cases.push(`${open}</testcase>`);
      } else {
        sfail++;
        const detail = esc(JSON.stringify(st.result ?? st.mismatch ?? st, null, 0).slice(0, 1000));
        cases.push(`${open}\n      <failure message="${esc(reason(st).slice(0, 200))}">${detail}</failure>\n    </testcase>`);
      }
    }
    if (!steps.length) { // an empty script proves nothing → surface it as a failing case, not silence
      cases.push(`    <testcase name="${esc(`${s.name} · (no steps)`)}" classname="${esc(s.name)}" time="0.000">\n      <failure message="script has no steps — proves nothing"></failure>\n    </testcase>`);
      sfail++;
    }

    const count = steps.length || 1;
    tests += count; failures += sfail; time += stime;
    chunks.push(`  <testsuite name="${esc(s.name)}" tests="${count}" failures="${sfail}" time="${stime.toFixed(3)}">\n${cases.join('\n')}\n  </testsuite>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="copse" tests="${tests}" failures="${failures}" time="${time.toFixed(3)}">\n${chunks.join('\n')}\n</testsuites>\n`;
}
