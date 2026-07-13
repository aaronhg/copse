// hold/release (SUGGESTIONS C1): freeze the engine loop at a trigger so a transient state can be
// screenshot/inspected, then resume. Tested over the FULL install() with a minimal fake `cc` (game.pause
// tracked) + a fake PureMVC facade as the trigger target — no browser. Covers: one-shot freeze, the
// original still runs (the state IS produced), the trigger self-restores (no re-freeze), release resumes,
// fail-loud when no freeze API resolves, and release-before-fire clears the armed patch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { install } from '../src/cocos/runtime.js';

const PUREMVC = {
  kind: 'puremvc', facade: ['puremvc.Facade.instance'],
  proxy: { via: 'retrieveProxy', map: ['model.proxyMap'] },
  mediator: { via: 'retrieveMediator', map: ['view.mediatorMap'] },
  command: { map: ['controller.commandMap'], execute: ['execute'] },
  notify: { via: ['sendNotification'] },
};

// A minimal fake `cc` (enough to CONSTRUCT the full runtime) + a game with pause/resume we can count.
function setup({ freeze = true } = {}) {
  const calls = { pause: 0, resume: 0, switched: 0 };
  const med = { toggle(n) { calls.switched++; return 'switched:' + n; } };
  const facade = {
    view: { mediatorMap: { PanelMediator: med } }, model: { proxyMap: {} }, controller: { commandMap: {} },
    retrieveMediator(n) { return this.view.mediatorMap[n] || null; }, retrieveProxy() { return null; },
  };
  const cc = {
    Button: class {}, UITransform: class {}, Camera: class {}, Vec2: class {}, Vec3: class {}, BlockInputEvents: class {},
    director: { getScene: () => ({ children: [] }), root: {} },
    game: freeze ? { pause() { calls.pause++; }, resume() { calls.resume++; } } : {},
  };
  const target = { puremvc: { Facade: { instance: facade } } }; // framework detection roots at `target`
  const api = install(cc, target);
  api.registerFramework(PUREMVC);
  return { api, med, calls };
}

test('hold: arms a one-shot freeze on a framework trigger; original runs; release resumes', () => {
  const { api, med, calls } = setup();
  assert.deepEqual(api.hold_status(), { armed: false, held: false });

  const armed = api.hold('PanelMediator.toggle', { pmMode: true });
  assert.equal(armed.ok, true);
  assert.equal(armed.armed, true);
  assert.equal(api.hold_status().armed, true);
  assert.equal(api.hold_status().held, false);

  // the trigger fires → after-hook freezes AFTER the original ran (the state it produces is held)
  const r = med.toggle('X');
  assert.equal(r, 'switched:X');        // original ran
  assert.equal(calls.pause, 1);         // froze exactly once
  const st = api.hold_status();
  assert.equal(st.held, true);
  assert.equal(st.via, 'game');

  // one-shot: firing again does NOT re-freeze (the trigger was restored), and the method still works
  med.toggle('Y');
  assert.equal(calls.pause, 1);
  assert.equal(calls.switched, 2);

  const rel = api.release();
  assert.equal(rel.resumed, true);
  assert.equal(rel.wasHeld, true);
  assert.equal(calls.resume, 1);
  assert.deepEqual(api.hold_status(), { armed: false, held: false });
});

test('hold: fails loud when neither cc.game.pause nor cc.director.pause resolves', () => {
  const { api, med, calls } = setup({ freeze: false });
  const r = api.hold('PanelMediator.toggle', { pmMode: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-freeze-api');
  assert.equal(api.hold_status().armed, false); // not armed → the trigger was never wrapped
  med.toggle('X');
  assert.equal(calls.pause, 0);
});

test('hold: release before the trigger fires clears the armed patch (no dangling freeze)', () => {
  const { api, med, calls } = setup();
  api.hold('PanelMediator.toggle', { pmMode: true });
  const rel = api.release();
  assert.equal(rel.wasHeld, false);
  assert.equal(rel.resumed, false);
  med.toggle('Z'); // trigger was restored → no freeze
  assert.equal(calls.pause, 0);
  assert.equal(calls.switched, 1);
});
