// The Pixi 8 layer over a FAKE Pixi tree (no engine, no browser) — the same posture as the Cocos
// tests. What's pinned here is everything that was MEASURED against a real minified build
// (docs/ENGINES.md), because every one of these fails SILENTLY if it regresses: a decoy label read
// as identity, a background sprite reported as a button, an anchor detector that swallows Graphics'
// drawing methods, a field walk that loops on Pixi's back-references.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, diff, get, call, resolve as resolveRef } from '../src/core/index.js';
import { pixiType, gameLabel, pixiName, isText } from '../src/pixi/pixitype.js';
import { makePixiSurface, isAnchor, anchorInfo, findAnchors, gameApi, namedRefs } from '../src/pixi/anchors.js';
import { pixiRuntime } from '../src/pixi/runtime.js';
import { refOf } from '../src/core/refpath.js';
import { visibleOf } from '../src/pixi/geom.js';

// ---- fake Pixi tree ------------------------------------------------------------------------
// Mimics the shapes that matter: renderPipeId as an instance field, Pixi's constructor-default
// labels, eventMode/_events, a parent chain, and getBounds returning v8's Bounds-with-.rectangle.
let uid = 0;
function mk(props = {}, children = []) {
  const n = {
    uid: uid++, visible: true, alpha: 1, eventMode: 'passive', children: [], parent: null,
    _events: {}, label: null,
    getBounds() { return { rectangle: { x: this._x ?? 0, y: this._y ?? 0, width: this._w ?? 10, height: this._h ?? 10 } }; },
    ...props,
  };
  for (const c of children) { c.parent = n; n.children.push(c); }
  return n;
}
// Pixi's own display classes set `label` in their constructors — the decoy.
const sprite = (p = {}, c = []) => mk({ renderPipeId: 'sprite', label: 'Sprite', ...p }, c);
const text = (str, p = {}) => mk({ renderPipeId: 'text', text: str, ...p });
const graphics = (p = {}, c = []) => mk({ renderPipeId: 'graphics', label: 'Graphics', ...p }, c);
const container = (p = {}, c = []) => mk(p, c);

// A Pixi built-in's prototype, so makePixiSurface has something to subtract (trap 1).
const GraphicsProto = { fill() {}, arc() {}, drawCircle() {}, updateBounds() {}, containsPoint() {} };
const ContainerProto = { addChild() {}, removeChild() {}, getBounds() {}, getGlobalPosition() {} };

test('pixiType: duck-typed from renderPipeId, never constructor.name', () => {
  assert.equal(pixiType(sprite()), 'Sprite');
  assert.equal(pixiType(text('hi')), 'Text');
  assert.equal(pixiType(graphics()), 'Graphics');
  assert.equal(pixiType(container()), 'Container');
  assert.equal(pixiType(mk({ renderPipeId: 'tilingSprite' })), 'TilingSprite');
  assert.equal(pixiType(mk({ renderPipeId: 'sprite', _leftWidth: 4 })), 'NineSliceSprite');
  assert.equal(pixiType(null), 'Unknown');
  // a MINIFIED build: the class name is gibberish but the pipe id is intact
  class Z { }
  const minified = Object.assign(new Z(), sprite());
  assert.equal(pixiType(minified), 'Sprite');
});

test('gameLabel: Pixi constructor defaults are decoys, not identity', () => {
  assert.equal(gameLabel(sprite()), null);                       // label === "Sprite" → Pixi's
  assert.equal(gameLabel(graphics()), null);                     // label === "Graphics" → Pixi's
  assert.equal(gameLabel(mk({ label: 'TilingSprite' })), null);
  assert.equal(gameLabel(mk({ label: 'seats' })), 'seats');      // the game's own
  assert.equal(gameLabel(mk({ label: '' })), null);
  assert.equal(gameLabel(mk({})), null);
  // name falls back to the TYPE, so a decoy label never leaks into a ref
  assert.equal(pixiName(sprite()), 'Sprite');
  assert.equal(pixiName(mk({ label: 'Seat3' })), 'Seat3');
});

test('isText covers every Text flavour (the Label pseudo-component)', () => {
  assert.equal(isText(text('x')), true);
  assert.equal(isText(mk({ renderPipeId: 'bitmapText' })), true);
  assert.equal(isText(mk({ renderPipeId: 'htmlText' })), true);
  assert.equal(isText(sprite()), false);
});

test('refOf uses the Pixi naming fn and disambiguates with [i]', () => {
  const a = text('one'), b = text('two'), root = container({}, [container({}, [a, b])]);
  assert.equal(refOf(a, root, pixiName), 'Container/Text[0]');
  assert.equal(refOf(b, root, pixiName), 'Container/Text[1]');
  const named = mk({ label: 'hud' }, []); named.parent = root; root.children.push(named);
  assert.equal(refOf(named, root, pixiName), 'hud');
});

test('refOf and snapshot emit the SAME ref (the drift refpath.js exists to prevent)', () => {
  // reachable's `blockedBy`, visual baselines and anchors() all go through refOf, while `diff` and
  // every selector go through core's segOf. They are separate implementations; if only one honours
  // alwaysIndex the two silently stop matching and a blockedBy ref resolves to the wrong node.
  const { stage } = mkTree();
  const rt = pixiRuntime({ stage }, () => stage);
  const snap = snapshot(stage, rt, { includeInactive: true });
  for (const d of snap) {
    const n = resolveRef(stage, rt, d.ref);
    assert.ok(n, `snapshot ref ${d.ref} must resolve`);
    assert.equal(refOf(n, stage, pixiName, rt.alwaysIndex), d.ref, 'refOf must agree with snapshot');
  }
});

test('alwaysIndex keeps a ref STABLE across the 1→2 sibling transition', () => {
  // The failure this guards: with conditional indexing, a lone Text is `Text`, and the instant a
  // second Text spawns it becomes `Text[0]` — so a live watch reports 1 disappearance + 2
  // appearances instead of 1 changed value. Measured-adjacent: the real-game churn test keyed on raw
  // positional paths and did NOT surface this; copse's actual `[i]` grammar does.
  const solo = text('0');
  const parent = container({}, [solo]);
  const stage = container({}, [parent]);
  const rt = pixiRuntime({ stage }, () => stage);
  const before = snapshot(stage, rt, { includeInactive: true });
  const soloRef = before.find((d) => d.label === '0').ref;
  const sib = text('+10'); sib.parent = parent; parent.children.push(sib);
  const after = snapshot(stage, rt, { includeInactive: true });
  assert.equal(after.find((d) => d.label === '0').ref, soloRef, 'the existing ref must not move');
  assert.equal(diff(before, after).disappeared.length, 0);
});

// ---- the Runtime ---------------------------------------------------------------------------
const mkTree = () => {
  const score = text('0', { label: null });
  const btnLabel = text('PLAY');
  const btn = container({ eventMode: 'static', _events: { pointertap: { fn() {} } }, cursor: 'pointer' }, [btnLabel]);
  const bg = mk({ renderPipeId: 'tilingSprite', label: 'TilingSprite', eventMode: 'static', _events: {}, _w: 1480, _h: 925 });
  const hidden = container({ visible: false }, [text('secret')]);
  const screen = container({ label: 'GameScreen', show() { }, hide() { }, resize() { }, pauseButton: btn, _tally: { rounds: 3 } }, [bg, score, btn, hidden]);
  const stage = container({}, [screen]);
  return { stage, screen, btn, bg, score, hidden };
};

test('Runtime: asButton requires listeners — an eventMode-only background is NOT a button', () => {
  const { stage, btn, bg } = mkTree();
  const rt = pixiRuntime({ stage }, () => stage);
  assert.equal(rt.asButton(btn), btn);
  assert.equal(rt.asButton(bg), null, 'full-screen static background with zero listeners must not be a button');
  assert.equal(rt.isInteractable(btn), true);
  assert.equal(rt.isInteractable({ eventMode: 'none' }), false);
});

test('Runtime: no component system — getComponent returns the node itself, Label maps to Text', () => {
  const { stage, score, btn } = mkTree();
  const rt = pixiRuntime({ stage }, () => stage);
  assert.equal(rt.getComponent(score, 'Label'), score);
  assert.equal(rt.getComponent(score, 'Text'), score);
  assert.equal(rt.getComponent(btn, 'Label'), null);
  assert.equal(rt.getComponent(btn, 'Container'), btn);
  assert.equal(rt.readProp(score, 'string'), '0', 'copse\'s Label member `string` maps to Pixi `.text`');
});

test('Runtime: readProp/callMethod walk dotted paths (Pixi named refs are multi-hop)', () => {
  const { stage, screen } = mkTree();
  const rt = pixiRuntime({ stage }, () => stage);
  assert.equal(rt.readProp(screen, '_tally.rounds'), 3);
  assert.equal(rt.readProp(screen, 'missing.deep'), undefined);
  const obj = { inner: { n: 1, bump(x) { this.n += x; return this.n; } } };
  assert.equal(rt.callMethod(obj, 'inner.bump', [4]), 5, '`this` must bind to the OWNER, not the root');
  assert.equal(obj.inner.n, 5);
});

test('Runtime: isActive honours the ancestor chain (Pixi has no activeInHierarchy)', () => {
  const { stage, hidden } = mkTree();
  const rt = pixiRuntime({ stage }, () => stage);
  assert.equal(rt.isActive(hidden), false);
  assert.equal(rt.isActive(hidden.children[0]), false, 'a hidden parent hides the subtree');
});

test('Runtime: clickHandlers is empty by construction (no serialized handlers → no coverage join)', () => {
  const { stage, btn } = mkTree();
  const rt = pixiRuntime({ stage }, () => stage);
  assert.deepEqual(rt.clickHandlers(btn), []);
  assert.equal(rt.fireClickHandlers(btn), 0);
});

test('Runtime: codeHandlers reads the eventemitter3 table', () => {
  const { stage, btn } = mkTree();
  const rt = pixiRuntime({ stage }, () => stage);
  const h = rt.codeHandlers(btn);
  assert.equal(h.length, 1);
  assert.equal(h[0].type, 'pointertap');
});

// ---- the §6 payoff: core's snapshot/diff/labelChanged work UNCHANGED over a Pixi tree ----------
test('snapshot + diff produce labelChanged over Pixi Text — no core change', () => {
  const { stage, score } = mkTree();
  const rt = pixiRuntime({ stage }, () => stage);
  const before = snapshot(stage, rt, { includeInactive: true });
  assert.ok(before.some((d) => d.label === '0'), 'a Text node surfaces as a copse label');
  assert.ok(before.some((d) => d.label === 'PLAY'));
  score.text = '760';
  const after = snapshot(stage, rt, { includeInactive: true });
  const d = diff(before, after);
  assert.equal(d.labelChanged.length, 1);
  assert.equal(d.labelChanged[0].from, '0');
  assert.equal(d.labelChanged[0].to, '760');
  assert.deepEqual(d.appeared, []);
  assert.deepEqual(d.disappeared, []);
});

test('diff separates transient spawn/despawn from value changes (the churn bucketing)', () => {
  const { stage, screen, score } = mkTree();
  const rt = pixiRuntime({ stage }, () => stage);
  const before = snapshot(stage, rt, { includeInactive: true });
  const popup = text('+10'); popup.parent = screen; screen.children.push(popup);  // spawns at the TAIL
  score.text = '10';
  const after = snapshot(stage, rt, { includeInactive: true });
  const d = diff(before, after);
  assert.equal(d.appeared.length, 1, 'the transient lands in appeared…');
  assert.equal(d.labelChanged.length, 1, '…not in labelChanged');
  assert.equal(d.labelChanged[0].to, '10');
});

test('get reaches the game\'s own class members through the Node pseudo-component', () => {
  const { stage } = mkTree();
  const rt = pixiRuntime({ stage }, () => stage);
  assert.deepEqual(get(stage, rt, 'GameScreen:Node._tally.rounds'), { ok: true, ref: 'GameScreen:Node._tally.rounds', value: 3 });
});

test('CALL reaches them too — :Node.method() is the headline Pixi capability', () => {
  // Regression for a real gap found by auditing the tools against a live game: core's `get`
  // special-cases the `Node` pseudo-component BEFORE consulting the Runtime, but `call`/`patch`/`hold`
  // go straight through getComponent. So `get(':Node.x')` worked while `call(':Node.f()')` returned
  // 'no-component' — i.e. everything the Pixi lane advertises (drive the game's own class, because the
  // node IS the game object) was read-only. getComponent must return the node for 'Node'.
  const { stage, screen } = mkTree();
  screen.bumpRound = function (n) { this._tally.rounds += n; return this._tally.rounds; };
  const rt = pixiRuntime({ stage }, () => stage);
  assert.equal(rt.getComponent(screen, 'Node'), screen);
  const r = call(stage, rt, 'GameScreen:Node.bumpRound', [2]);
  assert.equal(r.ok, true);
  assert.equal(r.value, 5);
  assert.equal(screen._tally.rounds, 5, 'and it really ran on the live object');
  // a genuinely missing method must still fail loud, not return undefined
  assert.equal(call(stage, rt, 'GameScreen:Node.nope').reason, 'no-method');
});

// ---- anchors: the three silent-failure traps ---------------------------------------------------
test('anchor detection is STRUCTURAL — a game class with no lifecycle methods still counts', () => {
  // The original detector gated on show/hide/resize, so a game that names its lifecycle differently
  // (or has none) produced ZERO anchors. Detection is now "owns methods the engine doesn't define,
  // and/or holds children by name"; a lifecycle cluster only raises the confidence tier.
  const stage = mk({});
  const surface = makePixiSurface(stage);
  const proto = { deal() { }, shuffle() { } };                      // no show/hide/resize anywhere
  const board = Object.assign(Object.create(proto), mk({}));
  const info = anchorInfo(board, surface);
  assert.equal(info.anchor, true, 'a game class without a lifecycle must still be found');
  assert.equal(info.tier, 'api');
  assert.deepEqual(info.methods.sort(), ['deal', 'shuffle']);

  // holds children by name only -> still addressable, lowest tier
  const holder = mk({ panel: container(), btn: container() });
  const h = anchorInfo(holder, surface);
  assert.equal(h.tier, 'refs');
  assert.equal(h.namedChildren, 2);

  // a lifecycle cluster raises the tier and names which one matched
  const screen = Object.assign(Object.create({ show() { }, hide() { }, resize() { } }), mk({}));
  assert.equal(anchorInfo(screen, surface).tier, 'lifecycle');
  assert.equal(anchorInfo(screen, surface).lifecycle, 'AppScreen');
  const alt = Object.assign(Object.create({ open() { }, close() { } }), mk({}));
  assert.equal(anchorInfo(alt, surface).lifecycle, 'open/close');

  // a bare engine primitive is never an anchor
  assert.equal(anchorInfo(sprite(), surface).anchor, false);
  assert.equal(anchorInfo(null, surface).anchor, false);
});

test('findAnchors returns TREE ORDER — a screen before the buttons it contains', () => {
  // Measured failure this guards: ranking by score alone buried puzzling-potions' GameScreen under
  // four @pixi/ui buttons, because a FancyButton exposes ~11 methods and the screen exposes 4.
  const btnProto = { press() { }, setState() { }, show() { }, hide() { }, playAnimations() { }, updateView() { } };
  const btn = Object.assign(Object.create(btnProto), mk({}));
  const scrProto = { show() { }, hide() { }, resize() { } };
  const screen = Object.assign(Object.create(scrProto), mk({}, [btn]));
  const stage = container({}, [screen]);
  const found = findAnchors(stage, (n) => refOf(n, stage, pixiName, true));
  assert.ok(found.length >= 2);
  assert.equal(found[0].depth, 1, 'the screen (shallower) must come first');
  assert.ok(found[0].methods.includes('resize'));
  assert.ok(found[1].depth > found[0].depth, 'its button follows, despite scoring higher');
  assert.ok(found[1].score > found[0].score, 'and it really does score higher — depth is what saves us');
});

test('findAnchors locates the game screen, skipping the stage itself', () => {
  const { stage, screen } = mkTree();
  const found = findAnchors(stage, (n) => refOf(n, stage, pixiName));
  assert.equal(found.length, 1);
  assert.equal(found[0].node, screen);
  assert.equal(found[0].ref, 'GameScreen');
});

test('TRAP 1: makePixiSurface subtracts EVERY Pixi prototype, not just Container\'s', () => {
  const g = Object.create(GraphicsProto);
  Object.assign(g, { renderPipeId: 'graphics', children: [], _bounds: 1 });
  const stage = Object.create(ContainerProto);
  Object.assign(stage, { children: [g], _events: {} });
  g.parent = stage;
  const surface = makePixiSurface(stage);
  assert.ok(surface.protoNames.has('fill'), 'Graphics drawing methods must be recognised as PIXI\'s');
  assert.ok(surface.protoNames.has('drawCircle'));
  assert.ok(surface.protoNames.has('addChild'), 'and Container\'s too');
  // a game class extending Container is therefore NOT swallowed
  const screen = Object.create({ ...ContainerProto, show() { }, hide() { }, resize() { } });
  Object.assign(screen, { children: [] });
  const api = gameApi(screen, surface);
  assert.ok(api.methods.includes('show') && api.methods.includes('resize'));
  assert.ok(!api.methods.includes('addChild'), 'Pixi\'s own methods must not be reported as game API');
  assert.ok(!api.methods.includes('fill'));
});

test('TRAP 2: instance fields are subtracted too, so real game fields survive the noise', () => {
  const stage = mk({});
  const surface = makePixiSurface(stage);
  assert.ok(surface.fieldNames.has('_events'), 'Pixi instance fields must be learned');
  assert.ok(surface.fieldNames.has('visible'));
  const screen = mk({ _game: { score: 5 }, match3: { board: [] } });
  const api = gameApi(screen, surface);
  assert.ok(api.fields.includes('_game'), 'the game\'s own field must not be drowned out');
  assert.ok(api.fields.includes('match3'));
  assert.ok(!api.fields.includes('_events'));
  assert.ok(!api.fields.includes('visible'));
});

test('TRAP 3: namedRefs is cycle-safe against Pixi back-references', () => {
  const stage = mk({});
  const surface = makePixiSurface(stage);
  // ObservablePoint._observer points BACK at the owning node — a naive walk loops and emits garbage
  const screen = mk({ label: 'S' });
  const point = { _x: 0, _y: 0 };
  point._observer = screen;
  screen._position = point;
  screen.logic = { rounds: 3, self: null };
  screen.logic.self = screen.logic;              // a direct self-cycle too
  const refs = namedRefs(screen, surface);
  assert.ok(Array.isArray(refs), 'must terminate');
  assert.ok(refs.length < 50, 'a cycle must not blow the result up');
  assert.ok(refs.some((r) => r.path === 'logic'), 'real logic objects still surface');
  assert.ok(refs.some((r) => r.path === 'logic.rounds' || r.path === 'logic'), 'and it descends one hop');
});

test('namedRefs surfaces the addressing backbone: named children and their text', () => {
  const stage = mk({});
  const surface = makePixiSurface(stage);
  const balance = text('1,250');
  const screen = mk({ txtBalance: balance, pauseButton: container(), rounds: { n: 2 } });
  const refs = namedRefs(screen, surface);
  const byPath = Object.fromEntries(refs.map((r) => [r.path, r]));
  assert.equal(byPath.txtBalance.kind, 'text');
  assert.equal(byPath.txtBalance.text, '1,250');
  assert.equal(byPath.pauseButton.kind, 'display');
  assert.equal(byPath.rounds.kind, 'value');
});

// ---- the Cocos binding of the same machinery ---------------------------------------------------
test('cocos anchors: COMPONENTS are the candidates, built-ins subtracted', async () => {
  // The concept transfers, the shape doesn't: Cocos keeps game logic in Components, so a node's
  // candidates are its components rather than the node. Its value is the RELEASE build, where a
  // script's class name is mangled to `e`/`t` while its methods survive — so this reports what is
  // actually callable when `snapshot({components:true})` can only show you gibberish.
  const { makeCocosSurface, findAnchors: findCocos } = await import('../src/cocos/anchors.js');
  // Model reality: built-ins AND game scripts both extend cc.Component, which is precisely why
  // comparison alone can't separate them and tier 1 (the cc namespace) has to exist.
  class Component { onLoad() { } start() { } update() { } schedule() { } }
  class Sprite extends Component { constructor() { super(); this.spriteFrame = null; } setFrame() { } }
  class Label extends Component { constructor() { super(); this.string = ''; } updateRenderData() { } }
  class ShopCtrl extends Component { constructor() { super(); this.gold = 0; } buy() { } refresh() { } }
  const cc = { Component, Sprite, Label };
  const node = (name, comps, kids = []) => { const n = { name, components: comps, children: kids, parent: null }; for (const k of kids) k.parent = n; return n; };
  const mgr = node('Mgr', [new ShopCtrl()]);
  const art = node('Art', [new Sprite(), new Label()]);          // built-ins only → not an anchor
  const scene = node('Scene', [], [node('Canvas', [], [art, mgr])]);

  const surface = makeCocosSurface(cc, scene);
  assert.equal(surface.degraded, false, 'tier 1 resolved: the cc namespace is intact here');
  assert.ok(surface.protoNames.has('setFrame'), "a built-in's own methods must be learned (tier 1)");
  assert.ok(surface.protoNames.has('updateRenderData'));
  assert.ok(surface.protoNames.has('onLoad'), "cc.Component's lifecycle must be learned (the floor)");

  const found = findCocos(cc, scene, (n) => n.name);
  assert.equal(found.length, 1, 'only the game-authored component is an anchor');
  assert.equal(found[0].ref, 'Mgr');
  assert.deepEqual(found[0].methods.sort(), ['buy', 'refresh']);
  assert.ok(!found[0].methods.includes('setFrame'), "a built-in's methods must never be reported as game API");
  assert.ok(!found[0].methods.includes('update'), "nor cc.Component's lifecycle");
});

test('cocos anchors: the FLOOR still subtracts cc.Component when the namespace is tree-shaken', () => {
  // The release build this feature exists for: every cc global is gone. Comparison across all
  // components still yields cc.Component's chain, so the lifecycle is never mistaken for game API —
  // and `degraded` says out loud that built-ins can no longer be told apart.
  class Component { onLoad() { } start() { } update() { } schedule() { } }
  class T extends Component { buy() { } }
  class U extends Component { refresh() { } }
  const node = (name, comps) => ({ name, components: comps, children: [], parent: null });
  const scene = { name: 'S', components: [], children: [node('A', [new T()]), node('B', [new U()])], parent: null };
  return import('../src/cocos/anchors.js').then(({ makeCocosSurface, findAnchors: findCocos }) => {
    const surface = makeCocosSurface({}, scene);            // NO cc globals at all
    assert.equal(surface.degraded, true, 'must report that tier 1 found nothing');
    assert.ok(surface.protoNames.has('onLoad'), 'the floor still learns cc.Component from comparison');
    assert.ok(surface.protoNames.has('schedule'));
    const found = findCocos({}, scene, (n) => n.name, { surface });
    assert.equal(found.length, 2);
    assert.deepEqual(found.map((f) => f.methods).flat().sort(), ['buy', 'refresh']);
  });
});

// --- the `visible` contract, across BOTH layers ------------------------------------------------
// visualManifest used to report `visible: node.visible !== false` (the node alone) while `reachable`
// reported the same FIELD NAME from an ancestor-aware walk — so a node inside a hidden parent came back
// visible:true from one and visible:false from the other, and Cocos (where both layers share one
// visibleOf) agreed with neither. Both now call pixi/geom.js `visibleOf`. Pinned here because it is a
// semantic promise, not an implementation detail: a caller gating on `visible && drawn` depends on it.
const fakeApp = () => ({
  canvas: { width: 100, height: 100, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) },
  renderer: { events: { resolution: 1 } },
});

test('pixi visible: visualManifest and reachable agree when an ANCESTOR is hidden', async () => {
  const { makeVisualManifest } = await import('../src/pixi/visual.js');
  const { makeReachable } = await import('../src/pixi/reachable.js');
  const leaf = mk({ label: 'Buy', _w: 10, _h: 10 });
  const hiddenParent = mk({ label: 'Panel', visible: false }, [leaf]);
  const stage = mk({ label: 'stage' }, [hiddenParent]);

  const manifest = makeVisualManifest(fakeApp(), () => stage)(leaf);
  assert.equal(manifest.visible, false, 'the manifest must see the hidden ANCESTOR, not just the node');

  const reach = makeReachable(fakeApp(), () => stage)(leaf);
  assert.equal(reach.visible, false);
  assert.equal(manifest.visible, reach.visible, 'one field name, one meaning');
});

test('pixi visible: alpha 0 up the chain collapses it, and a plain visible node stays true', () => {
  const leaf = mk({ label: 'Buy', _w: 10, _h: 10 });
  const dim = mk({ label: 'Panel', alpha: 0 }, [leaf]);
  const stage = mk({ label: 'stage' }, [dim]);
  assert.equal(visibleOf(leaf), false, 'alpha 0 on an ancestor');

  const ok = mk({ label: 'Buy2', _w: 10, _h: 10 });
  mk({ label: 'stage2' }, [ok]);
  assert.equal(visibleOf(ok), true);
});
