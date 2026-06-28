// @ts-check
// Runnable demo of the coir × copse COVERAGE join — NO browser, NO real game, NO npm
// deps, NO CLI (unlike ai-driver-demo.js, which needs `claude`). It proves the machinery
// that makes the two tools compose: joining coir's STATIC ClickEvent map to copse's
// RUNTIME click surface with `coverageJoin` (shared key `(nodePath, method)`, two-tier
// match so prefab-internal buttons join too).
//
//   Run:  node scripts/coverage-demo.js
//
// copse side is the REAL core (`snapshot` + `clickSurface`) over a hand-built fake scene
// (same shape as test/core.test.js). For a live game, replace the fake scene/runtime with
// a connect() Driver and call `cp.clickSurface()` (or the `click_surface` MCP tool) — the
// join is unchanged. coir side is a fixture standing in for what an agent assembles from
// coir's ClickEvent edges (per button: nodePath, method, real handler class — see
// docs/COVERAGE.md). The join needs no live coir here.
import { snapshot, clickSurface, coverageJoin } from '../src/index.js';

// ---- copse RUNTIME side: a fake live scene + Runtime (mirrors test/core.test.js) --------
const node = (name, children = [], comps = []) => ({ name, children, comps, active: true, clicked: 0 });
const fakeRuntime = () => ({
  name: (n) => n.name,
  children: (n) => n.children || [],
  isActive: (n) => n.active !== false,
  components: (n) => (n.comps || []).map((c) => ({ type: c.type, raw: c })),
  getComponent: (n, t) => (n.comps || []).find((c) => c.type === t || c.type === `cc.${t}`) || null,
  readProp: (c, p) => c[p],
  callMethod: (c, m, args) => c[m](...args),
  asButton: (n) => (n.comps || []).find((c) => c.type === 'Button') || null,
  isInteractable: (b) => b.interactable !== false,
  clickHandlers: (b) => b.clickEvents || [],
  fireClickHandlers: (b) => { (b.clickEvents || []).forEach((h) => h.fire && h.fire()); return (b.clickEvents || []).length; },
  emitClick: (n) => { n.clicked++; },
  // best-effort reachability — here a hard-coded fake; the real runtime hitTests z-order.
  reachable: (n) => n.name === 'CoveredBtn'
    ? { reachable: false, blockedBy: 'Canvas/Popup/mask' }
    : { reachable: true, blockedBy: null },
});

// A live scene. Component names are MINIFIED at runtime on a release build — that's why
// ShopBtn's handler shows component 't', not 'ShopController'. coir keeps the real name.
const btn = (name, handler, component, interactable = true) =>
  node(name, [], [{ type: 'Button', interactable, clickEvents: [{ handler, component, fire() {} }] }]);
const scene = node('Scene', [node('Canvas', [
  btn('ShopBtn', 'openShop', 't'),
  btn('BuyBtn', 'buy', 'e'),
  btn('CoveredBtn', 'claim', 'n'),                 // wired + live, but a popup covers it → reachable:false
  node('SettingsPanel', [btn('CloseBtn', 'close', 'r')]), // a PREFAB instantiated under Canvas (coir knows it as SettingsPanel/CloseBtn)
  node('TouchBtn', [], [{ type: 'Button', interactable: true, clickEvents: [] }]), // touch-/code-wired → method:null
  // (Canvas/Shop/BuyTab is NOT in this scene — that tab isn't open. coir still knows it exists.)
])]);

const runtime = clickSurface(snapshot(scene, fakeRuntime(), { onlyInteractive: true, reachability: true }));

// ---- coir STATIC side: every editor-wired button, across ALL scenes/prefabs ------------
// (What an agent assembles from coir's ClickEvent edges. `handlerClass` is coir's superpower:
//  the real script name, which copse can't recover from a minified runtime. Note CloseBtn's
//  path is WITHIN its prefab — coir can't know where it gets mounted; the prefix join finds it.)
const coirStatic = [
  { nodePath: 'Canvas/ShopBtn', method: 'openShop', handlerClass: 'ShopController' },
  { nodePath: 'Canvas/BuyBtn', method: 'buy', handlerClass: 'ShopController' },
  { nodePath: 'Canvas/CoveredBtn', method: 'claim', handlerClass: 'RewardController' },
  { nodePath: 'SettingsPanel/CloseBtn', method: 'close', handlerClass: 'SettingsPanel' }, // prefab-internal
  { nodePath: 'Canvas/Shop/BuyTab', method: 'openBuy', handlerClass: 'ShopController' },  // not instantiated now
];

const { covered, blocked, unreached, ambiguous, codeOnly } = coverageJoin(coirStatic, runtime);

// ---- report ----------------------------------------------------------------------------
console.log('coir × copse coverage  (join key: nodePath + method)\n');
console.log(`static buttons (coir): ${coirStatic.length}   live click rows (copse): ${runtime.length}\n`);

console.log(`✅ COVERED — wired + live + reachable (press & assert state delta): ${covered.length}`);
for (const c of covered) {
  const how = c.via === 'prefix' ? `  [prefix join — prefab mounted at ${c.mount || '(root)'} → ${c.runtime.ref}]`
    : `  [handler ${c.handlerClass} → minified '${c.runtime.component}' at runtime]`;
  console.log(`    ${c.nodePath}  ${c.method}${how}`);
}

console.log(`\n⛔ BLOCKED / DEAD WIRING — wired + live but a player can't reach it: ${blocked.length}`);
for (const b of blocked) console.log(`    ${b.nodePath}  ${b.method}   blockedBy ${b.runtime.blockedBy || '(interactable:false)'}`);

console.log(`\n🧭 UNREACHED SURFACE — wired but not live in this scene (navigate to it, re-run): ${unreached.length}`);
for (const u of unreached) console.log(`    ${u.nodePath}  ${u.method}`);

if (ambiguous.length) {
  console.log(`\n❓ AMBIGUOUS — >1 runtime button suffix-matched; resolve by hand: ${ambiguous.length}`);
  for (const a of ambiguous) console.log(`    ${a.nodePath}  ${a.method}   candidates: ${a.candidates.join(', ')}`);
}

console.log(`\n👻 CODE-ONLY — live but outside coir's static ClickEvent map (touch-/code-wired): ${codeOnly.length}`);
for (const r of codeOnly) console.log(`    ${r.ref}  ${r.method ?? '(no clickEvent)'}`);

console.log(`\nstatic coverage: ${covered.length}/${coirStatic.length} pressable & reachable now ` +
  `(${covered.filter((c) => c.via === 'prefix').length} via prefab-prefix join), ` +
  `${blocked.length} blocked, ${unreached.length} not yet reached.`);
