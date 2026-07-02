// @ts-check
// Auto-installing entry for the PROBE bundle (built to dist/copse.inject.probe.js by `npm run build`).
// esbuild wraps this as a self-contained IIFE — one file, no import/export. Like inject.js it runs before
// the engine boots (addInitScript / addScriptToEvaluateOnNewDocument), so it polls for `cc` and calls
// installProbe(cc) (→ window.__copse) as soon as it appears.
//
// This is the READ-ONLY load-metrics surface (probe/firstClickable/interactive/reachable) for a driver that
// only MEASURES — no press/get/call/diff. esbuild tree-shakes those out (this entry never imports them),
// leaving reachability (the reused core) as the only heavy piece. Smaller anti-tamper footprint than the
// full bundle; unlike inject-lite it KEEPS reachability (which lite drops).
import { installProbe, findCC } from './runtime.js';

const g = /** @type {any} */ (globalThis);
const findCc = () => findCC(g);

/** Install once `cc` is reachable. @returns {boolean} whether it installed. */
function tryInstall() {
  const cc = findCc();
  if (!cc) return false;
  installProbe(cc);
  return true;
}

if (!tryInstall()) {
  // Poll a bounded window (~10s) so we never leak a forever-interval on a page with no `cc`
  // (a released, tree-shaken build, or a non-Cocos frame).
  let tries = 0;
  const id = setInterval(() => {
    if (tryInstall() || ++tries >= 600) clearInterval(id);
  }, 16);
}
