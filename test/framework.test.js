// framework.js — the GENERIC adapter engine (core ships no framework knowledge). Tested over a FAKE
// `win` shaped like a PureMVC facade, driven by the SAME config the local copse.frameworks.mjs uses,
// plus a code-adapter string. Pure over win + adapters: no browser, no cc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAdapter, registerInto, detectWith, describe, stateWith, callWith, patchTargetWith, notifyWith, retrieveWith, traceTargetsWith } from '../src/core/framework.js';

// The PureMVC config adapter (the shape shipped as copse.frameworks.example.mjs).
const PUREMVC = {
  kind: 'puremvc',
  facade: ['puremvc.Facade.instance', 'puremvc.Facade.instanceMap.*', 'facade'],
  proxy: { via: 'retrieveProxy', map: ['model.proxyMap', 'model._proxyMap'] },
  mediator: { via: 'retrieveMediator', map: ['view.mediatorMap'] },
  command: { map: ['controller.commandMap'], execute: ['execute'] },
  notify: { via: ['sendNotification', 'notify'] },
};

function fakeFacade() {
  const gdp = { active: true, sessionData: { remaining: 3 }, mode: 'PowerUp', setBet(v) { this.mode = v; return v; } };
  const med = { toggle(n) { return 'switched:' + n; } };
  const proxyMap = { GameDataProxy: gdp };
  const mediatorMap = { PanelMediator: med };
  class StartupCommand { execute() { return 'started'; } }
  class ActionCommand { execute() { return 'ran'; } }        // transient per notification → patched at the class prototype
  const commandMap = { StartupCommand, ActionCommand };         // keys are the notification names too
  const notes = [];
  const facade = {
    model: { proxyMap }, view: { mediatorMap }, controller: { commandMap },
    retrieveProxy(n) { return proxyMap[n] || null; },
    retrieveMediator(n) { return mediatorMap[n] || null; },
    sendNotification(name, body, type) { notes.push({ name, body, type }); return 'sent:' + name; },
  };
  return { facade, gdp, notes, ActionCommand };
}
const singletonWin = () => { const f = fakeFacade(); return { win: { puremvc: { Facade: { instance: f.facade } } }, ...f }; };

const store = (...adapters) => { const s = []; for (const a of adapters) registerInto(s, a); return s; };

test('registerInto normalizes a config; detectWith finds the singleton facade', () => {
  const s = store(PUREMVC);
  const { win } = singletonWin();
  const hit = detectWith(win, s);
  assert.ok(hit && typeof hit.root.retrieveProxy === 'function');
  assert.equal(detectWith({}, s), null); // no facade anywhere → no hit
});

test('describe enumerates proxies/mediators/commands; unregistered/unmatched → none', () => {
  const s = store(PUREMVC);
  const r = describe(singletonWin().win, s);
  assert.equal(r.kind, 'puremvc');
  assert.deepEqual(r.proxies, ['GameDataProxy']);
  assert.deepEqual(r.mediators, ['PanelMediator']);
  assert.deepEqual(r.commands.sort(), ['ActionCommand', 'StartupCommand']);
  assert.deepEqual(describe({}, s), { kind: 'none' });       // adapter loaded but no match
  assert.deepEqual(describe(singletonWin().win, []), { kind: 'none' }); // no adapter at all
});

test("facade '.*' candidate resolves the .instanceMap multiton shape", () => {
  const { facade } = fakeFacade();
  const win = { puremvc: { Facade: { instanceMap: { game: facade } } } };
  assert.equal(describe(win, store(PUREMVC)).kind, 'puremvc');
});

test('stateWith reads a proxy prop + a nested path via the config `via`/map', () => {
  const s = store(PUREMVC);
  const { win } = singletonWin();
  assert.deepEqual(stateWith(win, s, 'GameDataProxy.active'), { ok: true, ref: 'GameDataProxy.active', value: true });
  assert.deepEqual(stateWith(win, s, 'GameDataProxy.sessionData.remaining'), { ok: true, ref: 'GameDataProxy.sessionData.remaining', value: 3 });
});

test('stateWith writes the leaf (the write-fix probe: set mode)', () => {
  const s = store(PUREMVC);
  const { win, gdp } = singletonWin();
  assert.deepEqual(stateWith(win, s, 'GameDataProxy.mode', true, 'off'), { ok: true, ref: 'GameDataProxy.mode', wrote: 'off' });
  assert.equal(gdp.mode, 'off');
});

test('stateWith fails loud: no framework / unknown name / non-object path', () => {
  const s = store(PUREMVC);
  assert.deepEqual(stateWith({}, s, 'X.y'), { ok: false, reason: 'no-framework' });
  assert.deepEqual(stateWith(singletonWin().win, s, 'NopeProxy.x'), { ok: false, reason: 'not-found', name: 'NopeProxy' });
  assert.equal(stateWith(singletonWin().win, s, 'GameDataProxy').ok, false);              // needs a property
  assert.equal(stateWith(singletonWin().win, s, 'GameDataProxy.active.deeper').ok, false); // boolean isn't an object
});

test('retrieveWith hands back the RAW proxy/mediator object (the pm.proxy/pm.mediator path); null when absent', () => {
  const s = store(PUREMVC);
  const { win, gdp } = singletonWin();
  assert.equal(retrieveWith(win, s, 'GameDataProxy'), gdp);                 // the live object, not a JSON copy
  assert.ok(retrieveWith(win, s, 'PanelMediator'));                  // forgiving: resolves a mediator too
  assert.equal(retrieveWith(win, s, 'NopeProxy'), null);                    // unknown name → null
  assert.equal(retrieveWith({}, s, 'GameDataProxy'), null);                 // no framework → null
});

test('callWith invokes a mediator method and a proxy method', () => {
  const s = store(PUREMVC);
  const { win, gdp } = singletonWin();
  assert.deepEqual(callWith(win, s, 'PanelMediator.toggle', [7]), { ok: true, ref: 'PanelMediator.toggle', value: 'switched:7' });
  assert.deepEqual(callWith(win, s, 'GameDataProxy.setBet', ['off']), { ok: true, ref: 'GameDataProxy.setBet', value: 'off' });
  assert.equal(gdp.mode, 'off');
  assert.deepEqual(callWith(win, s, 'GameDataProxy.nope'), { ok: false, reason: 'no-method', method: 'nope' });
});

test('a CODE-adapter source string works for a non-PureMVC framework', () => {
  const CODE = "({ kind:'mystore', detect:(w)=> w.app && w.app.store || null, proxies:(r)=>Object.keys(r.mods), mediators:()=>[], commands:()=>[], retrieve:(r,name)=> r.mods[name] || null })";
  const win = { app: { store: { mods: { Wallet: { balance: 42, add(n) { this.balance += n; return this.balance; } } } } } };
  const s = store(CODE);
  assert.equal(describe(win, s).kind, 'mystore');
  assert.deepEqual(describe(win, s).proxies, ['Wallet']);
  assert.deepEqual(stateWith(win, s, 'Wallet.balance'), { ok: true, ref: 'Wallet.balance', value: 42 });
  assert.deepEqual(callWith(win, s, 'Wallet.add', [8]), { ok: true, ref: 'Wallet.add', value: 50 });
});

test('registerInto de-dupes by kind (re-register replaces); junk is rejected', () => {
  const s = store(PUREMVC, { ...PUREMVC });   // same kind twice
  assert.equal(s.length, 1);
  registerInto(s, "({ kind:'other', detect:()=>null })");
  assert.equal(s.length, 2);
  assert.deepEqual(registerInto(s, { nonsense: true }), { ok: false, reason: 'bad-adapter' });
  assert.equal(s.length, 2);
});

test('describe reports capabilities — which of proxy/mediator/command/notify resolved on this build', () => {
  const caps = describe(singletonWin().win, store(PUREMVC)).capabilities;
  assert.deepEqual(caps, { proxy: true, mediator: true, command: 'class', notify: 'sendNotification' });
  // a build whose commandMap holds non-class entries reports command:'map-only' (→ needs a code adapter)
  const win2 = { puremvc: { Facade: { instance: { model: { proxyMap: {} }, view: { mediatorMap: {} }, controller: { commandMap: { X: 1 } }, retrieveProxy: () => null, retrieveMediator: () => null } } } };
  assert.equal(describe(win2, store(PUREMVC)).capabilities.command, 'map-only');
  assert.equal(describe(win2, store(PUREMVC)).capabilities.notify, false); // no sendNotification on that facade
});

test('patchTargetWith resolves a proxy/mediator INSTANCE and a command CLASS PROTOTYPE', () => {
  const s = store(PUREMVC);
  const { win, gdp, ActionCommand } = singletonWin();
  const inst = patchTargetWith(win, s, 'GameDataProxy.setBet');
  assert.equal(inst.ok, true); assert.equal(inst.kind, 'instance'); assert.equal(inst.member, 'setBet'); assert.equal(inst.target, gdp);
  const cmd = patchTargetWith(win, s, 'ActionCommand.execute');
  assert.equal(cmd.ok, true); assert.equal(cmd.kind, 'command'); assert.equal(cmd.member, 'execute'); assert.equal(cmd.target, ActionCommand.prototype);
  // fail loud
  assert.deepEqual(patchTargetWith({}, s, 'X.y'), { ok: false, reason: 'no-framework' });
  assert.deepEqual(patchTargetWith(win, s, 'GameDataProxy.nope'), { ok: false, reason: 'no-method', method: 'nope' });
  assert.deepEqual(patchTargetWith(win, s, 'Nope.execute'), { ok: false, reason: 'not-found', name: 'Nope' });
});

test('notifyWith fires the facade notification via a config `via` candidate', () => {
  const s = store(PUREMVC);
  const { win, notes } = singletonWin();
  assert.deepEqual(notifyWith(win, s, 'StartFlow', { amount: 5 }), { ok: true, via: 'sendNotification', value: 'sent:StartFlow' });
  assert.deepEqual(notes[0], { name: 'StartFlow', body: { amount: 5 }, type: undefined });
  assert.deepEqual(notifyWith({}, s, 'X'), { ok: false, reason: 'no-framework' });
});

test('a code adapter supplies its OWN commandTarget/notify for structural quirks', () => {
  // a game whose commandMap holds {ctor} wrappers + dispatches via a custom method — config can't express it.
  const CODE = "({ kind:'q', detect:(w)=> w.app || null, proxies:()=>[], mediators:()=>[], commands:(r)=>Object.keys(r.cmds), "
    + "retrieve:()=>null, commandTarget:(r,name,member)=>{ const c=r.cmds[name]; return c && { proto:c.ctor.prototype, member: member||'run' }; }, "
    + "notify:(r,name,body)=>({ ok:true, via:'dispatch', value: r.dispatch(name, body) }) })";
  class Boot { run() { return 'ran'; } }
  const fired = [];
  const win = { app: { cmds: { Boot: { ctor: Boot } }, dispatch: (n, b) => { fired.push([n, b]); return 'ok'; } } };
  const s = store(CODE);
  const ct = patchTargetWith(win, s, 'Boot.run');
  assert.equal(ct.ok, true); assert.equal(ct.kind, 'command'); assert.equal(ct.target, Boot.prototype);
  assert.deepEqual(notifyWith(win, s, 'Go', 1), { ok: true, via: 'dispatch', value: 'ok' });
  assert.deepEqual(fired, [['Go', 1]]);
});

test('stateWith surfaces `landed` when a setter TRANSFORMS the value; omits it when it lands exactly', () => {
  const gdp = { plain: 1 };
  Object.defineProperty(gdp, 'amount', { get() { return this._b; }, set(v) { this._b = String(v); }, enumerable: true }); // normalising setter
  const win = { puremvc: { Facade: { instance: { model: { proxyMap: { P: gdp } }, retrieveProxy(n) { return this.model.proxyMap[n]; } } } } };
  const s = store({ kind: 'pm', facade: ['puremvc.Facade.instance'], proxy: { via: 'retrieveProxy' } });
  assert.deepEqual(stateWith(win, s, 'P.amount', true, 5), { ok: true, ref: 'P.amount', wrote: 5, landed: '5' }); // wrote number, landed string
  assert.deepEqual(stateWith(win, s, 'P.plain', true, 2), { ok: true, ref: 'P.plain', wrote: 2 });          // landed exactly → no `landed`
});

test('a facade with ONLY a mediator registry (no proxy match) is still detected', () => {
  // canRoot used to anchor on proxy alone → a mediator/command-only facade read as frameworkless.
  const win = { puremvc: { Facade: { instance: { view: { mediatorMap: { M: { go() { return 'g'; } } } } } } } };
  const s = store({ kind: 'pm', facade: ['puremvc.Facade.instance'], mediator: { map: ['view.mediatorMap'] } });
  assert.equal(describe(win, s).kind, 'pm');
  assert.deepEqual(describe(win, s).mediators, ['M']);
  assert.deepEqual(callWith(win, s, 'M.go'), { ok: true, ref: 'M.go', value: 'g' });
});

test('stateWith write is VERIFIED: a no-op (read-only) write fails loud, not a false ok', () => {
  // a Proxy whose set trap silently ignores 'frozen' (the sloppy-mode no-op the fix guards against)
  const proxy = new Proxy({ real: 1 }, { set(t, k, v) { if (k === 'frozen') return true; t[k] = v; return true; }, get(t, k) { return t[k]; } });
  const win = { puremvc: { Facade: { instance: { model: { proxyMap: { P: proxy } }, retrieveProxy(n) { return this.model.proxyMap[n]; } } } } };
  const s = store({ kind: 'pm', facade: ['puremvc.Facade.instance'], proxy: { via: 'retrieveProxy' } });
  const bad = stateWith(win, s, 'P.frozen', true, 9);
  assert.equal(bad.ok, false); assert.equal(bad.reason, 'write-no-effect');
  const good = stateWith(win, s, 'P.real', true, 2);
  assert.deepEqual(good, { ok: true, ref: 'P.real', wrote: 2 });
});

test('a code adapter missing `retrieve` fails loud (adapter-no-retrieve), not a raw TypeError', () => {
  const CODE = "({ kind:'noret', detect:(w)=> w.x || null, proxies:()=>[], mediators:()=>[], commands:()=>[] })";
  const s = store(CODE);
  assert.deepEqual(stateWith({ x: {} }, s, 'A.b'), { ok: false, reason: 'adapter-no-retrieve' });
  assert.deepEqual(callWith({ x: {} }, s, 'A.b'), { ok: false, reason: 'adapter-no-retrieve' });
  // patchTargetWith degrades to not-found (a command-only adapter may omit retrieve legitimately)
  assert.deepEqual(patchTargetWith({ x: {} }, s, 'A.b'), { ok: false, reason: 'not-found', name: 'A' });
});

test('detectWith honors registration order: first matching adapter wins', () => {
  const A = "({ kind:'a', detect:(w)=> w.a || null, proxies:()=>['pa'], mediators:()=>[], commands:()=>[], retrieve:()=>null })";
  const B = "({ kind:'b', detect:(w)=> w.b || null, proxies:()=>['pb'], mediators:()=>[], commands:()=>[], retrieve:()=>null })";
  const s = store(A, B);
  assert.equal(describe({ b: {} }, s).kind, 'b');                 // only B matches
  assert.equal(describe({ a: {}, b: {} }, s).kind, 'a');          // both match → first registered (A)
});

// ---- traceTargetsWith: the DISPATCH choke points (docs/PM-TRACE.md) ------------------------
// Resolved from the WINDOW to a class prototype, not from the facade through a registry — because a real
// PureMVC View/Controller captures mediator.handleNotification / this.executeCommand as a function VALUE at
// registration, so the registry-reachable objects are the ones patching them observes nothing on.
const TRACE_CFG = {
  send: { at: ['puremvc.Facade.prototype.sendNotification'], label: '(a) => ({ n: a[0] })' },
  observe: { at: ['nope.missing', 'puremvc.Observer.prototype.notifyObserver'], label: '(a, self) => ({})' },
  macro: { at: ['puremvc.MacroCommand.prototype.execute'] },
};
// A win carrying the puremvc CLASSES (what trace targets), on top of the facade instance (what detect needs).
const classWin = () => {
  const f = fakeFacade();
  class Facade { sendNotification() {} }
  class Observer { notifyObserver() {} }
  class MacroCommand { execute() {} }
  return { win: { puremvc: { Facade: Object.assign(Facade, { instance: f.facade }), Observer, MacroCommand } }, ...f };
};

test('traceTargetsWith resolves each role to a prototype + member, carrying its label', () => {
  const s = store({ ...PUREMVC, trace: TRACE_CFG });
  const { win } = classWin();
  const r = traceTargetsWith(win, s);
  assert.equal(r.ok, true);
  assert.deepEqual(r.targets.map((t) => t.role).sort(), ['macro', 'observe', 'send']);
  const send = r.targets.find((t) => t.role === 'send');
  assert.equal(send.at, 'puremvc.Facade.prototype.sendNotification');
  assert.equal(send.target, win.puremvc.Facade.prototype, 'must hand back the PROTOTYPE object to wrap');
  assert.equal(send.member, 'sendNotification');
  assert.equal(send.label, '(a) => ({ n: a[0] })');
  // candidate lists absorb per-build naming: the first path missed, the second resolved
  assert.equal(r.targets.find((t) => t.role === 'observe').at, 'puremvc.Observer.prototype.notifyObserver');
  assert.equal(r.targets.find((t) => t.role === 'macro').label, null, 'a role may omit its label');
  assert.equal(r.unresolved, undefined);
});

test('traceTargetsWith reports an unresolvable role LOUDLY instead of thinning the timeline', () => {
  const s = store({ ...PUREMVC, trace: { ...TRACE_CFG, ghost: { at: ['puremvc.Nope.prototype.gone', 'also.missing'] } } });
  const { win } = classWin();
  const r = traceTargetsWith(win, s);
  assert.equal(r.ok, true, 'the roles that DID resolve still arm');
  assert.deepEqual(r.unresolved, [{ role: 'ghost', tried: ['puremvc.Nope.prototype.gone', 'also.missing'] }]);
});

test('traceTargetsWith honors a roles filter, and names a role the adapter never declared', () => {
  const s = store({ ...PUREMVC, trace: TRACE_CFG });
  const { win } = classWin();
  const r = traceTargetsWith(win, s, ['send', 'bogus']);
  assert.deepEqual(r.targets.map((t) => t.role), ['send']);
  assert.deepEqual(r.unresolved, [{ role: 'bogus', tried: [], reason: 'no-such-role' }]);
});

test('traceTargetsWith fails loud: no framework, and an adapter with no trace block', () => {
  const s = store({ ...PUREMVC, trace: TRACE_CFG });
  assert.deepEqual(traceTargetsWith({}, s), { ok: false, reason: 'no-framework' });
  const bare = store(PUREMVC);                       // the shipped config, no trace block
  const r = traceTargetsWith(classWin().win, bare);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'adapter-has-no-trace');
  assert.match(r.hint, /copse\.frameworks\.mjs/);    // says where to fix it
});

test('a path resolving to a NON-function is not a trace target (a data field named like a method)', () => {
  const s = store({ ...PUREMVC, trace: { send: { at: ['puremvc.Facade.prototype.notAFunction', 'puremvc.Facade.prototype.sendNotification'] } } });
  const { win } = classWin();
  win.puremvc.Facade.prototype.notAFunction = 42;
  assert.equal(traceTargetsWith(win, s).targets[0].at, 'puremvc.Facade.prototype.sendNotification');
});

test('a code adapter supplies its OWN traceTargets', () => {
  const src = "({ kind:'custom', detect:(w)=> w.app || null, proxies:()=>[], mediators:()=>[], commands:()=>[], retrieve:()=>null," +
    " traceTargets:(w, roles)=> ({ ok:true, targets:[{ role:'bus', at:'app.bus.emit', target:w.app.bus, member:'emit', label:null }], asked: roles || null }) })";
  const s = store(src);
  const win = { app: { bus: { emit() {} } } };
  const r = traceTargetsWith(win, s, ['bus']);
  assert.equal(r.ok, true);
  assert.equal(r.targets[0].member, 'emit');
  assert.deepEqual(r.asked, ['bus'], 'the roles filter is passed through to the code adapter');
});
