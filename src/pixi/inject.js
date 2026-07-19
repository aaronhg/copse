// @ts-check
// Auto-installing entry for the Pixi bundle (built to dist/copse.inject.pixi.js by `npm run build`).
// esbuild wraps this as a self-contained IIFE, so it drops into a console paste, a Playwright
// `addInitScript`, or a dev-build hook — the Pixi sibling of src/cocos/inject.js.
//
// ORDER MATTERS HERE in a way it doesn't for Cocos. The reliable attach is Pixi core's
// `__PIXI_APP_INIT__` hook, which only fires if it is set BEFORE the game constructs its
// Application. So the FIRST thing this bundle does — before anything else, before any polling — is
// install that hook. Injected via addInitScript (pre-boot) that captures every v8 app with zero
// game cooperation; injected late (console paste on a running game) it falls back to findPixi's
// ladder. See docs/ENGINES.md §1.
import { snapshot, resolve, get, call } from '../core/index.js';
import { pixiRuntime, install, findPixi, installInitHook, autoInstall } from './runtime.js';

const g = /** @type {any} */ (globalThis);

// FIRST: arm the core hook. Cheap, idempotent, and the only thing that works pre-boot.
const captured = installInitHook(g);

const copse = { snapshot, resolve, get, call, pixiRuntime, install, findPixi, installInitHook, autoInstall };
g.copse = copse;

/** Install once an Application is reachable. @returns {boolean} whether it installed. */
function tryInstall() {
  if (g.__copse && g.__copse.app) return true;
  if (captured.app) { install(captured.app, g, { version: captured.version || undefined }); return true; }
  return !!autoInstall(g);
}

if (!tryInstall()) {
  // Poll a bounded window (~10s) so we never leak a forever-interval on a page that has no Pixi app.
  let tries = 0;
  const id = setInterval(() => {
    if (tryInstall() || ++tries >= 600) clearInterval(id);
  }, 16);
}
