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
      'puremvc.Facade.instance',        // the common singleton — where most real builds keep it
      'puremvc.Facade.instanceMap.*',   // the multiton: Facade.instanceMap keyed by module name
      'PureMVC.Facade.instance',
      'gameFacade', 'appFacade', 'facade',
    ],
    // HOW to reach a proxy/mediator: a retrieve METHOD name (`via`) and/or registry-map path candidates
    // (`map`). copse tries `via` first, then the map. List the field variants your build uses.
    proxy: { via: 'retrieveProxy', map: ['model.proxyMap', 'model._proxyMap', '_model.proxyMap', 'm_model.proxyMap'] },
    mediator: { via: 'retrieveMediator', map: ['view.mediatorMap', 'view._mediatorMap', '_view.mediatorMap', 'm_view.mediatorMap'] },
    // command: for pm_patch of a COMMAND (transient → its class prototype is patched). `map` locates the
    // name→class registry; `execute` names the method to wrap. `map` keys are the notification names too.
    command: { map: ['controller.commandMap', 'controller._commandMap', '_controller.commandMap'], execute: ['execute'] },
    // notify: how pm_notify FIRES a notification — the facade method name candidates. If your game dispatches
    // notifications a non-standard way, use a code adapter's own notify(root,name,body,type) instead.
    notify: { via: ['sendNotification', 'notify'] },
    // trace: the DISPATCH choke points pm_trace arms (docs/PM-TRACE.md). `at` is a candidate list of dotted
    // paths from the WINDOW to a class prototype — NOT a registry lookup, and that distinction is the whole
    // point: PureMVC's View.registerMediator does `new Observer(mediator.handleNotification, mediator)` and
    // Controller.registerCommand does `new Observer(this.executeCommand, this)`, both capturing the function
    // VALUE at registration — so wrapping what the registry hands you back observes NOTHING (measured on a real
    // build: 0 hits across 60 command executions). These prototypes are what the Observer calls THROUGH.
    // `label` (a fn-expr src, compiled in-page) extracts the readable row and runs on ENTRY — see the macro note.
    trace: {
      send: {
        at: ['puremvc.Facade.prototype.sendNotification', 'PureMVC.Facade.prototype.sendNotification'],
        label: '(a) => ({ n: a[0] })',
      },
      // notifyObserver's notifyContext IS the mediator (or the Controller — a row whose to==='Controller' is
      // that notification's command running, since commandMap is keyed by notification name).
      observe: {
        at: ['puremvc.Observer.prototype.notifyObserver', 'PureMVC.Observer.prototype.notifyObserver'],
        label: '(a, self) => { const c = self.getNotifyContext && self.getNotifyContext(); const n = a[0] && a[0].getName && a[0].getName(); return { n, to: (c && c.getMediatorName && c.getMediatorName()) || (c && c.constructor && c.constructor.name) }; }',
      },
      // MacroCommand.execute ENDS with this.subCommands.splice(0) — a label reading it at exit would report 0
      // on every macro. Labels run on entry, so this counts them; NAMING them is coir's `⊕ addSubCommand` job
      // (the refs here are minified and can even collide — a real macro reports ['r','n','r']).
      macro: {
        at: ['puremvc.MacroCommand.prototype.execute', 'PureMVC.MacroCommand.prototype.execute'],
        label: '(a, self) => ({ n: a[0] && a[0].getName && a[0].getName(), subs: (self.subCommands || []).length })',
      },
    },
  },

  // CODE adapter (advanced) — a source string eval'd IN-PAGE to an object with the same interface, for a
  // custom framework the config can't describe. `detect(win)` returns the root; the rest read it. STRUCTURAL
  // quirks (commandMap holds a factory not a class, a custom dispatch) go here via commandTarget / notify:
  // "({ kind:'mystore', detect: (w) => w.myApp?.store ?? null, proxies:(r)=>Object.keys(r.modules), " +
  // "mediators:()=>[], commands:()=>Object.keys(r.cmds), retrieve:(r,name)=>r.modules[name] ?? null, " +
  // "commandTarget:(r,name,member)=>{ const c=r.cmds[name]; return c && { proto:c.prototype, member: member||'run' }; }, " +
  // "notify:(r,name,body)=>({ ok:true, value: r.dispatch(name, body) }) })",
];
