// @ts-check
// Public API. The pure core (core.js) is engine-agnostic — import it to drive a
// snapshot/press over your own Runtime adapter. runtime.js is the Cocos `cc.*`
// adapter + `install(cc)` you inject into a running game.
export { snapshot, resolve, press, get, call, reachable, node, diff } from './core/index.js';
export { cocosRuntime, install } from './cocos/runtime.js';
export { runHarness, localDriver } from './harness.js';
