// @ts-check
// LITE auto-installing inject entry (built to dist/copse.inject.lite.js by `npm run build`).
// The MINIMAL in-page surface — snapshot / resolve / press / get / call / node / diff — with NO
// reachability and NO console patching. For callers that only drive handlers + read state (e.g.
// mast's `press:` action stages): about half the code of the full bundle, a smaller injected
// surface (fewer patched globals, no reachability machinery), and a FROZEN contract that copse's
// reachability/coverage work can't disturb. The full QA/coverage bundle is inject.js.
//
// Same boot model as inject.js: expose `globalThis.copse` immediately, poll ~10s for `cc`, then
// install `window.__copse` (via installLite) as soon as the engine appears. `__copse.press`/`get`/
// `call` here are byte-for-byte identical to the full bundle's — a lite caller can swap up to full
// (or vice-versa) without touching call sites.
import { snapshot, resolve, press, get, call, node, diff } from '../core/index.js';
import { cocosRuntimeLite, installLite, findCC } from './runtime.js';

const copse = { snapshot, resolve, press, get, call, node, diff, cocosRuntimeLite, installLite, findCC };

const g = /** @type {any} */ (globalThis);
g.copse = copse;

const findCc = () => findCC(g);

/** Install once `cc` is reachable. @returns {boolean} whether it installed. */
function tryInstall() {
  const cc = findCc();
  if (!cc) return false;
  copse.installLite(cc);
  return true;
}

if (!tryInstall()) {
  // Poll a bounded window (~10s) so we never leak a forever-interval on a page with no `cc`.
  let tries = 0;
  const id = setInterval(() => {
    if (tryInstall() || ++tries >= 600) clearInterval(id);
  }, 16);
}
