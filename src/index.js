// @ts-check
// Public API. The pure core (core.js) is engine-agnostic — import it to drive a
// snapshot/press over your own Runtime adapter. runtime.js is the Cocos `cc.*`
// adapter + `install(cc)` you inject into a running game.
export { snapshot, clickSurface, resolve, press, get, call, reachable, node, diff } from './core/index.js';
export { engineCapabilities, CONTRACT_VERSION } from './capabilities.js';
// NOTE: coverageJoin moved to arbor (the coverage JOIN is control-layer). copse keeps the ref-matching
// interop adapters (resolveCoirPath/resolveCopseRef) that resolve against a live runtime view, plus the
// `tailMatch` vocabulary they share — now PUBLIC so arbor's vendored copy (match.mjs) can cross-check
// against the single declared contract (arbor resolves copse dynamically, so it keeps its own copy).
export { tailMatch, resolveCoirPath, resolveCopseRef } from './coverage.js';
export { cocosRuntime, install } from './cocos/runtime.js';
// The deterministic flow executor (facts, no verdict). The AI-driver LOOP moved to arbor — copse stays
// deterministic; a consumer builds its own plan→execute→judge loop + veto over `execute`.
export { execute, extractFacts, localDriver } from './harness.js';
export { runScript, subsetMatch } from './script.js';
export { signature, compareSignatures, detail, visualVerdict } from './sensors/pixel.js';
