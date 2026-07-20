// patch/pm_patch TRACE timestamps: the contract that makes a MERGED timeline meaningful. Each traced
// call is stamped against ONE epoch + ONE sequence counter shared by every patch on the page, so calls
// recorded by DIFFERENT patches are comparable. They used to be stamped per-patch (`t0` scoped inside
// the wrap), which made `t` mean "ms since THAT selector was patched" — two patches armed at different
// moments produced two incomparable origins, and the offset was never returned, so a caller merging them
// (the whole point of tracing a command chain: cross-method ORDER) silently got a wrong sequence.
// Runs over a fake `cc` + a stubbed clock — no engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { install } from '../src/cocos/runtime.js';

// The clock every stamp goes through. Date.now() is ms-granular, so the sub-ms case below is not
// contrived: a synchronous command chain really does run inside one millisecond.
let NOW = 0;
const withClock = (fn) => {
  const real = Date.now; NOW = 1000; Date.now = () => NOW;
  try { return fn(); } finally { Date.now = real; }
};

// A component with two traceable methods + a node tree `resolve` can walk. `nest` lets foo() call bar()
// synchronously (the MacroCommand → subcommand shape).
const setup = () => {
  const ran = [];
  const ctrl = { foo() { ran.push('foo'); if (ctrl.nest) ctrl.bar(); return 'F'; }, bar() { ran.push('bar'); return 'B'; }, nest: false };
  const node = {
    name: 'Mgr', children: [], activeInHierarchy: true, parent: null, _eventProcessor: null,
    getComponent: (t) => ((typeof t === 'string' ? t.replace(/^cc\./, '') : t.name) === 'Ctrl' ? ctrl : null),
  };
  const scene = { name: 'Scene', children: [node] };
  const cc = {
    Button: class Button {}, UITransform: class UITransform {}, Camera: class Camera {},
    Vec2: class Vec2 {}, Vec3: class Vec3 {}, BlockInputEvents: class BlockInputEvents {},
    director: { getScene: () => scene, root: {} },
  };
  const win = {};
  return { api: install(cc, win), ctrl, ran, win };
};

test('trace: patches armed at DIFFERENT times share one epoch → `t` stays comparable across them', () => {
  withClock(() => {
    const { api, ctrl } = setup();

    api.patch('Mgr:Ctrl.foo', { trace: true });        // armed at t=1000 → the epoch
    NOW = 2000; ctrl.foo();                            // 1000ms after the epoch
    NOW = 3000; api.patch('Mgr:Ctrl.bar', { trace: true });  // armed 2000ms LATER than foo's patch
    NOW = 3100; ctrl.bar();                            // 2100ms after the epoch

    const foo = api.patch_calls('Mgr:Ctrl.foo').calls;
    const bar = api.patch_calls('Mgr:Ctrl.bar').calls;
    assert.equal(foo[0].t, 1000);
    // Per-patch origins made this 100 ("ms since bar was patched") — which read as EARLIER than foo's
    // 1000 despite happening 1100ms after it. Same epoch → the real offset survives.
    assert.equal(bar[0].t, 2100);
    assert.equal(bar[0].t - foo[0].t, 1100, 'the gap between two traced calls must be the real elapsed time');
  });
});

test('trace: the merged timeline orders calls across patches, and ordering survives sub-ms chains', () => {
  withClock(() => {
    const { api, ctrl } = setup();

    api.patch('Mgr:Ctrl.foo', { trace: true });
    NOW = 5000; api.patch('Mgr:Ctrl.bar', { trace: true });
    // A synchronous chain: same millisecond, so `t` alone cannot order these — `i` (stamped on entry) can.
    NOW = 6000; ctrl.bar(); ctrl.foo(); ctrl.bar();

    const m = api.patch_calls();
    assert.deepEqual(m.traced.sort(), ['Mgr:Ctrl.bar', 'Mgr:Ctrl.foo']);
    assert.deepEqual(m.calls.map((c) => c.sel), ['Mgr:Ctrl.bar', 'Mgr:Ctrl.foo', 'Mgr:Ctrl.bar'], 'merged timeline must be in real call order');
    assert.deepEqual(m.calls.map((c) => c.t), [5000, 5000, 5000], 'all three landed in the same millisecond (5000ms after the epoch)');
    assert.deepEqual(m.calls.map((c) => c.i), [1, 2, 3], 'the shared seq is what carries the order');
    assert.equal(m.calls[1].ret, 'F', 'merged rows keep the per-call payload');
  });
});

test('trace: a NESTED call is ordered after its caller (stamped on entry, not on return)', () => {
  withClock(() => {
    const { api, ctrl } = setup();
    ctrl.nest = true;                                  // foo() now calls bar() synchronously

    api.patch('Mgr:Ctrl.foo', { trace: true });
    api.patch('Mgr:Ctrl.bar', { trace: true });
    ctrl.foo();                                        // bar RETURNS first; foo STARTED first

    // Stamping on the trace push (after the original returns) would invert these — the callee completes
    // before its caller, so the MacroCommand would sort after its own subcommand.
    assert.deepEqual(api.patch_calls().calls.map((c) => c.sel), ['Mgr:Ctrl.foo', 'Mgr:Ctrl.bar']);
  });
});

test('trace: merged read reports armed-but-silent patches, and skips untraced ones', () => {
  withClock(() => {
    const { api, ctrl } = setup();

    api.patch('Mgr:Ctrl.foo', { trace: true });        // traced, never called
    api.patch('Mgr:Ctrl.bar', { before: '(a,self)=>{}' });  // patched WITHOUT trace
    ctrl.bar();

    const m = api.patch_calls();
    assert.deepEqual(m.traced, ['Mgr:Ctrl.foo'], 'an armed-but-silent patch must still be named (empty ≠ ambiguous blank)');
    assert.deepEqual(m.calls, [], 'an untraced patch contributes nothing');
  });
});

test('trace: clear-all resets the epoch → the next patch starts a fresh timeline', () => {
  withClock(() => {
    const { api, ctrl, win } = setup();

    api.patch('Mgr:Ctrl.foo', { trace: true });
    NOW = 9000; ctrl.foo();
    api.patch_clear();
    assert.equal(win.__copsePatchEpoch, undefined);
    assert.equal(win.__copsePatchSeq, undefined);

    api.patch('Mgr:Ctrl.foo', { trace: true });        // re-armed at 9000 → the new epoch
    NOW = 9500; ctrl.foo();
    const c = api.patch_calls('Mgr:Ctrl.foo').calls;
    assert.deepEqual([c.length, c[0].t, c[0].i], [1, 500, 1], 'a cleared session must not carry the old origin/seq forward');
  });
});

test('trace: clearing ONE selector leaves the surviving patches on the same timeline', () => {
  withClock(() => {
    const { api, ctrl } = setup();

    api.patch('Mgr:Ctrl.foo', { trace: true });
    api.patch('Mgr:Ctrl.bar', { trace: true });
    NOW = 1200; ctrl.foo();
    api.patch_clear('Mgr:Ctrl.foo');                   // targeted clear — bar keeps tracing
    NOW = 1600; ctrl.bar();

    const c = api.patch_calls('Mgr:Ctrl.bar').calls;
    assert.equal(c[0].t, 600, 'the epoch must survive a targeted clear');
  });
});

test('patch_calls(sel) keeps its per-selector shape (ref + calls, ok:false when unpatched)', () => {
  withClock(() => {
    const { api, ctrl } = setup();
    api.patch('Mgr:Ctrl.foo', { trace: true });
    ctrl.foo();

    const r = api.patch_calls('Mgr:Ctrl.foo');
    assert.equal(r.ok, true);
    assert.equal(r.ref, 'Mgr:Ctrl.foo');
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].sel, undefined, 'the per-sel read stays unpolluted by the merged tag');

    const miss = api.patch_calls('Mgr:Ctrl.nope');
    assert.equal(miss.ok, false);
    assert.deepEqual(miss.calls, []);
  });
});

// ---- depth + label + pm_trace (docs/PM-TRACE.md) -------------------------------------------
// A framework's dispatch is depth-first and its choke-point args are opaque objects, so the merged
// timeline needs two more things than order: `d` (to indent the tree back out of the flat list) and a
// `label` extractor (to turn a Notification into a readable row). Both are stamped on ENTRY.

test('depth: a nested call records d one deeper than its caller, and the counter unwinds', () => {
  withClock(() => {
    const { api, ctrl, win } = setup();
    ctrl.nest = true;                                  // foo() calls bar() synchronously
    api.patch('Mgr:Ctrl.foo', { trace: true });
    api.patch('Mgr:Ctrl.bar', { trace: true });

    ctrl.foo();                                        // foo(d=0) → bar(d=1)
    ctrl.bar();                                        // top-level again → d=0
    const rows = api.patch_calls().calls.map((c) => [c.sel, c.d]);
    assert.deepEqual(rows, [['Mgr:Ctrl.foo', 0], ['Mgr:Ctrl.bar', 1], ['Mgr:Ctrl.bar', 0]]);
    assert.equal(win.__copsePatchDepth, 0, 'depth must unwind to 0 — a leak would deepen every later row');
  });
});

test('depth: unwinds even when the patched method THROWS (no permanent skew)', () => {
  withClock(() => {
    const { api, ctrl, win } = setup();
    ctrl.boom = () => { throw new Error('kaboom'); };
    api.patch('Mgr:Ctrl.boom', { trace: true });
    api.patch('Mgr:Ctrl.bar', { trace: true });

    assert.throws(() => ctrl.boom(), /kaboom/, 'the original throw must still propagate');
    ctrl.bar();
    assert.equal(win.__copsePatchDepth, 0);
    const rows = api.patch_calls().calls;
    assert.equal(rows[0].threw, 'kaboom');
    assert.equal(rows[1].d, 0, 'the throw must not leave the next call stuck at depth 1');
  });
});

test('label runs on ENTRY, so it sees state the original destroys (the MacroCommand.splice case)', () => {
  withClock(() => {
    const { api, ctrl } = setup();
    // Exactly PureMVC's MacroCommand.execute shape: read subCommands, then splice them away.
    ctrl.subCommands = ['a', 'b', 'c'];
    ctrl.runMacro = function () { const n = this.subCommands.length; this.subCommands.splice(0); return n; };
    api.patch('Mgr:Ctrl.runMacro', { trace: true, label: '(a, self) => ({ subs: self.subCommands.length })' });

    assert.equal(ctrl.runMacro(), 3);
    assert.deepEqual(api.patch_calls('Mgr:Ctrl.runMacro').calls[0].label, { subs: 3 }, 'a label stamped at exit would report 0 on every macro');
    assert.equal(ctrl.subCommands.length, 0, 'the original still spliced — the label only observed');
  });
});

test('label REPLACES args, receives (args, self), and a throwing label degrades to a hookError', () => {
  withClock(() => {
    const { api, ctrl } = setup();
    api.patch('Mgr:Ctrl.foo', { trace: true, label: '(a, self) => ({ got: a[0], mode: self.tag })' });
    api.patch('Mgr:Ctrl.bar', { trace: true, label: '() => { throw new Error("bad label"); }' });
    ctrl.tag = 'T';
    ctrl.foo(42);
    ctrl.bar();

    const foo = api.patch_calls('Mgr:Ctrl.foo').calls[0];
    assert.deepEqual(foo.label, { got: 42, mode: 'T' });
    assert.equal(foo.args, undefined, 'label replaces args — these hooks’ raw args are noise');
    const bar = api.patch_calls('Mgr:Ctrl.bar').calls[0];
    assert.equal(bar.label, undefined);
    assert.deepEqual(bar.args, [], 'a failed label falls back to recording args, it does not lose the row');
    const cleared = api.patch_clear();
    assert.match(cleared.hookErrors['Mgr:Ctrl.bar'][0], /^label: bad label/);
  });
});

test('merged timeline carries dt — the gap that the same-millisecond bursts hide', () => {
  withClock(() => {
    const { api, ctrl } = setup();
    api.patch('Mgr:Ctrl.foo', { trace: true });
    api.patch('Mgr:Ctrl.bar', { trace: true });
    ctrl.foo(); ctrl.bar();          // t=0, same ms
    NOW = 2848; ctrl.foo();          // the long silence (a spine animation, in the real thing)
    NOW = 2850; ctrl.bar();

    const c = api.patch_calls().calls;
    assert.deepEqual(c.map((r) => r.t), [0, 0, 1848, 1850]);
    assert.deepEqual(c.map((r) => r.dt), [0, 0, 1848, 2], 'dt is where the time actually went');
  });
});

// pm_trace needs an adapter + a win carrying the framework CLASSES (the choke points live on prototypes).
const setupTraceable = () => {
  const seen = { sent: [], observed: [], macro: [] };
  class Facade { sendNotification(n) { seen.sent.push(n); } }
  class Observer {
    constructor(ctx) { this.ctx = ctx; }
    getNotifyContext() { return this.ctx; }
    notifyObserver(note) { seen.observed.push(note.name); }
  }
  class MacroCommand { execute(note) { seen.macro.push(note.name); this.subCommands.splice(0); } }
  const facade = { model: { proxyMap: {} }, view: { mediatorMap: {} }, controller: { commandMap: {} }, retrieveProxy: () => null, retrieveMediator: () => null, sendNotification() {} };
  Facade.instance = facade;
  const win = { puremvc: { Facade, Observer, MacroCommand } };
  const api = install({ Button: class {}, UITransform: class {}, Camera: class {}, Vec2: class {}, Vec3: class {}, BlockInputEvents: class {}, director: { getScene: () => ({ name: 'S', children: [] }), root: {} } }, win);
  api.registerFramework({
    kind: 'puremvc',
    facade: ['puremvc.Facade.instance'],
    proxy: { via: 'retrieveProxy', map: ['model.proxyMap'] },
    mediator: { via: 'retrieveMediator', map: ['view.mediatorMap'] },
    command: { map: ['controller.commandMap'] },
    trace: {
      send: { at: ['puremvc.Facade.prototype.sendNotification'], label: '(a) => ({ n: a[0] })' },
      observe: { at: ['puremvc.Observer.prototype.notifyObserver'], label: '(a, self) => ({ n: a[0].name, to: self.getNotifyContext() })' },
      macro: { at: ['puremvc.MacroCommand.prototype.execute'], label: '(a, self) => ({ n: a[0].name, subs: self.subCommands.length })' },
    },
  });
  return { api, win, seen, Facade, Observer, MacroCommand };
};

test('pm_trace arms every declared role at its class prototype and reports where', () => {
  withClock(() => {
    const { api } = setupTraceable();
    const r = api.pmTrace();
    assert.equal(r.ok, true);
    assert.deepEqual(r.armed.map((a) => a.sel).sort(), ['@macro', '@observe', '@send']);
    assert.equal(r.armed.find((a) => a.role === 'send').at, 'puremvc.Facade.prototype.sendNotification');
    assert.equal(r.armed.every((a) => a.labelled), true);
    assert.equal(r.traceMax, 5000, 'one action is ~237 rows and a sustained sequence ~190/s — patch’s 200 would drop the start');
  });
});

test('pm_trace: one armed run yields a merged, labelled, depth-aware flow through the real dispatch', () => {
  withClock(() => {
    const { api, seen, Facade, Observer, MacroCommand } = setupTraceable();
    api.pmTrace();

    // Dispatch as PureMVC does: a send, observed by a mediator then by the Controller, whose macro runs.
    const f = new Facade();
    const macro = new MacroCommand(); macro.subCommands = ['s1', 's2'];
    f.sendNotification('appEvAction');
    new Observer('MainViewMediator').notifyObserver({ name: 'appEvAction' });
    new Observer('Controller').notifyObserver({ name: 'appEvAction' });
    macro.execute({ name: 'RouteCommand' });

    const t = api.patch_calls();
    assert.deepEqual(t.traced.sort(), ['@macro', '@observe', '@send']);
    assert.deepEqual(t.calls.map((c) => [c.sel, c.label]), [
      ['@send', { n: 'appEvAction' }],
      ['@observe', { n: 'appEvAction', to: 'MainViewMediator' }],
      ['@observe', { n: 'appEvAction', to: 'Controller' }],   // ← this row IS the command running
      ['@macro', { n: 'RouteCommand', subs: 2 }],      // ← read before execute() spliced them
    ]);
    assert.deepEqual(t.calls.map((c) => c.d), [0, 0, 0, 0]);
    assert.deepEqual(seen, { sent: ['appEvAction'], observed: ['appEvAction', 'appEvAction'], macro: ['RouteCommand'] }, 'the originals all still ran');
    api.patch_clear();
    assert.equal(String(Facade.prototype.sendNotification).includes('calls.push'), false, 'clear restores the prototypes');
  });
});

test('pm_trace: roles filter arms a subset; unresolved roles are named, not silently dropped', () => {
  withClock(() => {
    const { api, win } = setupTraceable();
    assert.deepEqual(api.pmTrace({ roles: ['send'] }).armed.map((a) => a.role), ['send']);
    api.patch_clear();
    delete win.puremvc.MacroCommand;                 // a build without that class
    const r = api.pmTrace();
    assert.equal(r.ok, true);
    assert.deepEqual(r.armed.map((a) => a.role).sort(), ['observe', 'send']);
    assert.deepEqual(r.unresolved, [{ role: 'macro', tried: ['puremvc.MacroCommand.prototype.execute'] }]);
  });
});

test('pm_trace fails loud when no adapter declares a trace block', () => {
  withClock(() => {
    const { api } = setup();                          // install with NO framework registered
    assert.deepEqual(api.pmTrace(), { ok: false, reason: 'no-framework' });
  });
});
