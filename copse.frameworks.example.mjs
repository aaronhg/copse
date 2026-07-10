// TEMPLATE — copy to `copse.frameworks.mjs` (git-ignored) to enable framework-aware state access.
//
// copse core ships NO framework knowledge (not every Cocos game uses PureMVC, and those that do wire
// it differently). A game's logic state often lives OUTSIDE the cc node tree — in PureMVC a
// GameDataProxy holds active/stateData, which get/call can't reach. An ADAPTER here teaches copse how
// to find that state; the driver auto-loads this file on connect() and injects the adapters into the
// game, so `framework`, `pm_state`, `pm_call` (MCP) / `cp.framework/pmState/pmCall` (lib) light up.
//
// Auto-load order (later overrides earlier by `kind`):
//   1. <copse>/copse.frameworks.mjs   — this machine's global (git-ignored; "all the games I attach")
//   2. <cwd>/copse.frameworks.mjs     — a per-project override, if you run copse from a game repo
//   3. connect({frameworks:[…]}) / `copse … --framework <file>` / the register_framework MCP tool
//
// Default-export an ARRAY of adapters. Each is either a CONFIG object (below) or a CODE-adapter source
// string for a framework the config shape can't express.
export default [
  {
    kind: 'puremvc',
    // WHERE the facade lives — candidate locations relative to the game window, tried in order.
    // 'a.b.*' expands a map object and tries each value (e.g. the .instanceMap multiton). Add your
    // game's location here if auto-detect misses.
    facade: [
      'puremvc.Facade.instance',        // the common singleton (what most real builds keep it)
      'puremvc.Facade.instanceMap.*',   // the multiton: Facade.instanceMap keyed by module name
      'PureMVC.Facade.instance',
      'gameFacade', 'appFacade', 'facade',
    ],
    // HOW to reach a proxy/mediator: a retrieve METHOD name (`via`) and/or registry-map path candidates
    // (`map`). copse tries `via` first, then the map. List the field variants your build uses.
    proxy: { via: 'retrieveProxy', map: ['model.proxyMap', 'model._proxyMap', '_model.proxyMap', 'm_model.proxyMap'] },
    mediator: { via: 'retrieveMediator', map: ['view.mediatorMap', 'view._mediatorMap', '_view.mediatorMap', 'm_view.mediatorMap'] },
    command: { map: ['controller.commandMap', 'controller._commandMap', '_controller.commandMap'] },
  },

  // CODE adapter (advanced) — a source string eval'd IN-PAGE to an object with the same interface, for a
  // custom framework the config can't describe. `detect(win)` returns the root (or null); the rest read it.
  // "({ kind:'mystore', detect: (w) => w.myApp?.store ?? null, proxies:(r)=>Object.keys(r.modules), " +
  // "mediators:()=>[], commands:()=>[], retrieve:(r,name)=>r.modules[name] ?? null })",
];
