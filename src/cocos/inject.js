// @ts-check
// Auto-installing entry for the bundled inject script (built to dist/copse.inject.js
// by `npm run build`). esbuild wraps this as a self-contained IIFE — one file with
// no import/export — so it drops cleanly into a console paste, a Playwright
// `addInitScript`, or a dev-build hook.
//
// `addInitScript` runs *before* the engine boots, so `cc` won't exist yet: we expose
// the in-page surface on `globalThis.copse` immediately and poll for `cc` in the
// background, calling `install(cc)` (→ `window.__copse`) as soon as it appears.
//
// We import the IN-PAGE pieces only (not the barrel) — `runHarness`/`localDriver`
// run driver-side (Node/Playwright), so they have no business in the injected blob.
import { snapshot, resolve, press, get, call } from '../core/index.js';
import { cocosRuntime, install, findCC, startLogCapture } from './runtime.js';

const copse = { snapshot, resolve, press, get, call, cocosRuntime, install, findCC, startLogCapture };

const g = /** @type {any} */ (globalThis);

// Always available for ad-hoc use / a manual `copse.install(myCc)`.
g.copse = copse;

// NOTE: we do NOT auto-capture console here. Patching `console.*` makes it non-native and
// can trip `isNative` guards (some builds treat a patched `console` as tampering and wipe their
// own globals in response). The puppeteer driver captures console passively over CDP instead. If you're doing
// a console-paste and want `__copse.logs()`, opt in explicitly: `copse.startLogCapture()`.

/**
 * The live engine — `window.cc` once booted, OR a same-origin nested (i)frame's `cc`
 * (games are often iframed). Cross-origin frames can't be reached from here; for those,
 * inject this bundle INTO that frame (addInitScript injects every frame automatically).
 */
const findCc = () => findCC(g);

/** Install once `cc` is reachable. @returns {boolean} whether it installed. */
function tryInstall() {
  const cc = findCc();
  if (!cc) return false;
  copse.install(cc);
  return true;
}

if (!tryInstall()) {
  // Poll a bounded window (~10s) so we never leak a forever-interval on a page
  // that has no `cc` (e.g. a released, tree-shaken build).
  let tries = 0;
  const id = setInterval(() => {
    if (tryInstall() || ++tries >= 600) clearInterval(id);
  }, 16);
}
