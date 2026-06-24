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
import { cocosRuntime, install } from './runtime.js';

const copse = { snapshot, resolve, press, get, call, cocosRuntime, install };

const g = /** @type {any} */ (globalThis);

// Always available for ad-hoc use / a manual `copse.install(myCc)`.
g.copse = copse;

/** The live engine — usually `window.cc` in a dev/preview build, once booted. */
const findCc = () => (g.cc && g.cc.director ? g.cc : null);

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
