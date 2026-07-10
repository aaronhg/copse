// framework.js — the GENERIC adapter engine (core ships no framework knowledge). Tested over a FAKE
// `win` shaped like a PureMVC facade, driven by the SAME config the local copse.frameworks.mjs uses,
// plus a code-adapter string. Pure over win + adapters: no browser, no cc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAdapter, registerInto, detectWith, describe, stateWith, callWith } from '../src/cocos/framework.js';

// The PureMVC config adapter (the shape shipped as copse.frameworks.example.mjs).
const PUREMVC = {
  kind: 'puremvc',
  facade: ['puremvc.Facade.instance', 'puremvc.Facade.instanceMap.*', 'facade'],
  proxy: { via: 'retrieveProxy', map: ['model.proxyMap', 'model._proxyMap'] },
  mediator: { via: 'retrieveMediator', map: ['view.mediatorMap'] },
  command: { map: ['controller.commandMap'] },
};

function fakeFacade() {
  const gdp = { active: true, sessionData: { remaining: 3 }, mode: 'PowerUp', setBet(v) { this.mode = v; return v; } };
  const med = { toggle(n) { return 'switched:' + n; } };
  const proxyMap = { GameDataProxy: gdp };
  const mediatorMap = { PanelMediator: med };
  const facade = {
    model: { proxyMap }, view: { mediatorMap }, controller: { commandMap: { StartupCommand: 1, ActionCommand: 1 } },
    retrieveProxy(n) { return proxyMap[n] || null; },
    retrieveMediator(n) { return mediatorMap[n] || null; },
  };
  return { facade, gdp };
}
const singletonWin = () => { const { facade, gdp } = fakeFacade(); return { win: { puremvc: { Facade: { instance: facade } } }, gdp }; };

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

test('detectWith honors registration order: first matching adapter wins', () => {
  const A = "({ kind:'a', detect:(w)=> w.a || null, proxies:()=>['pa'], mediators:()=>[], commands:()=>[], retrieve:()=>null })";
  const B = "({ kind:'b', detect:(w)=> w.b || null, proxies:()=>['pb'], mediators:()=>[], commands:()=>[], retrieve:()=>null })";
  const s = store(A, B);
  assert.equal(describe({ b: {} }, s).kind, 'b');                 // only B matches
  assert.equal(describe({ a: {}, b: {} }, s).kind, 'a');          // both match → first registered (A)
});
