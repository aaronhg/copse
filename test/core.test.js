// copse pure core, tested in Node over a fake `cc`-shaped tree (no engine needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, clickSurface, resolve, press, get, call, reachable, node as nodeInfo, diff } from '../src/core/index.js';

// A plain-object node tree + a Runtime adapter over it (mirrors what runtime.js
// does for real `cc.Node`s). Components are `{ type, ...props }`.
const node = (name, children = [], comps = []) => ({ name, children, comps, active: true, clicked: 0 });
const fakeRuntime = () => ({
  name: (n) => n.name,
  children: (n) => n.children || [],
  isActive: (n) => n.active !== false,
  components: (n) => (n.comps || []).map((c) => ({ type: c.type, raw: c })),
  getComponent: (n, type) => (n.comps || []).find((c) => c.type === type || c.type === `cc.${type}`) || null,
  readProp: (c, p) => c[p],
  callMethod: (c, m, args) => c[m](...args),
  asButton: (n) => (n.comps || []).find((c) => c.type === 'Button') || null,
  isInteractable: (b) => b.interactable !== false,
  clickHandlers: (b) => b.clickEvents || [],
  fireClickHandlers: (b) => { (b.clickEvents || []).forEach((h) => h.fire()); return (b.clickEvents || []).length; },
  emitClick: (n) => { n.clicked++; },
});

function fixture() {
  const handler = { fired: 0, fire() { this.fired++; } };
  const buyHandler = { fired: 0, fire() { this.fired++; } };
  const shopBtn = node('ShopBtn', [], [{ type: 'Button', interactable: true, clickEvents: [handler] }]);
  const buyBtn = node('BuyBtn', [], [{ type: 'Button', interactable: false, clickEvents: [buyHandler] }]);
  const score = node('Score', [], [{ type: 'Label', string: '0' }]);
  const ctrl = node('Mgr', [], [{ type: 'ShopController', gold: 100, buy(n) { this.gold -= n; return this.gold; } }]);
  const item0 = node('Item');
  const item1 = node('Item');
  const canvas = node('Canvas', [shopBtn, buyBtn, score, ctrl, item0, item1]);
  const scene = node('Scene', [canvas]);
  return { scene, handler, buyHandler, shopBtn, buyBtn, item1, ctrl };
}

test('snapshot: every node gets a paste-able ref; same-name siblings get [i]', () => {
  const { scene } = fixture();
  const refs = snapshot(scene, fakeRuntime()).map((d) => d.ref);
  assert.ok(refs.includes('Canvas'));
  assert.ok(refs.includes('Canvas/ShopBtn'));
  assert.ok(refs.includes('Canvas/Item[0]'));
  assert.ok(refs.includes('Canvas/Item[1]'));   // disambiguated
});

test('snapshot: buttons carry interactable + click handlers; Labels carry string', () => {
  const { scene } = fixture();
  const map = new Map(snapshot(scene, fakeRuntime()).map((d) => [d.ref, d]));
  assert.equal(map.get('Canvas/ShopBtn').button, true);
  assert.equal(map.get('Canvas/ShopBtn').interactable, true);
  assert.equal(map.get('Canvas/BuyBtn').interactable, false);
  assert.equal(map.get('Canvas/Score').label, '0');
});

test('interactive(): only the buttons', () => {
  const { scene } = fixture();
  const refs = snapshot(scene, fakeRuntime(), { onlyInteractive: true }).map((d) => d.ref).sort();
  assert.deepEqual(refs, ['Canvas/BuyBtn', 'Canvas/ShopBtn']);
});

test('clickSurface: flattens a snapshot into join-ready (ref, method) rows', () => {
  const snap = [
    { ref: 'Canvas/ShopBtn', button: true, interactable: true, reachable: 'unsure', occludedBy: 'Canvas/Banner', click: [{ component: 't', handler: 'openShop', target: 'Mgr' }] },
    { ref: 'Canvas/BuyBtn', button: true, interactable: false, reachable: false, blockedBy: 'Canvas/Popup/mask', click: [{ handler: 'buy' }, { handler: 'log' }] },
    { ref: 'Canvas/TouchBtn', button: true, interactable: true, click: [], codeHandlers: [{ type: 'touch-start', fn: 'onTouchDown', target: 'BtnScaler' }] }, // touch-/code-wired
    { ref: 'Canvas/Score', label: '0' },                                     // non-button → ignored
  ];
  const rows = clickSurface(snap);
  // one row per clickEvent; (ref, method) is the join key; non-buttons dropped
  assert.deepEqual(rows.map((r) => `${r.ref}:${r.method}`),
    ['Canvas/ShopBtn:openShop', 'Canvas/BuyBtn:buy', 'Canvas/BuyBtn:log', 'Canvas/TouchBtn:null']);
  assert.equal(rows[0].component, 't');          // minified at runtime — coir supplies the real class name
  assert.equal(rows[0].interactable, true);
  assert.equal(rows[0].reachable, 'unsure');     // tri-state rides along the join surface
  assert.equal(rows[0].occludedBy, 'Canvas/Banner'); // visual occlusion surfaced on the join row
  const touch = rows.find((r) => r.ref === 'Canvas/TouchBtn');
  assert.equal(touch.method, null);              // no editor clickEvent
  assert.equal(touch.codeHandlers[0].fn, 'onTouchDown'); // but its live node.on() listeners ride along → the join can call it code-registered
  assert.equal(rows[1].reachable, false);        // wired + live but blocked → dead/blocked wiring
  assert.equal(rows[1].blockedBy, 'Canvas/Popup/mask');
});

test('clickSurface: composes with a real snapshot (handler survives, ride-along flags kept)', () => {
  const scene = node('Scene', [node('Canvas', [
    node('ShopBtn', [], [{ type: 'Button', interactable: true, clickEvents: [{ handler: 'openShop', component: 'ShopController' }] }]),
  ])]);
  const rows = clickSurface(snapshot(scene, fakeRuntime(), { onlyInteractive: true }));
  assert.deepEqual(rows, [{ ref: 'Canvas/ShopBtn', method: 'openShop', component: 'ShopController', interactable: true }]);
});

test('snapshot: slim shape — no name, active omitted when true, components opt-in; relevant filters noise', () => {
  const { scene } = fixture();
  const rt = fakeRuntime();
  const shop = snapshot(scene, rt).find((d) => d.ref === 'Canvas/ShopBtn');
  assert.equal('name' in shop, false);
  assert.equal('active' in shop, false);        // true → omitted
  assert.equal('components' in shop, false);    // opt-in only
  assert.ok(Array.isArray(snapshot(scene, rt, { components: true }).find((d) => d.ref === 'Canvas/ShopBtn').components));

  const rel = snapshot(scene, rt, { relevant: true }).map((d) => d.ref);
  assert.ok(rel.includes('Canvas/ShopBtn'));    // button kept
  assert.ok(rel.includes('Canvas/Score'));      // label kept
  assert.ok(!rel.includes('Canvas'));           // bare container dropped
  assert.ok(!rel.includes('Canvas/Item[0]'));   // bare node dropped
});

test('resolve: bare name → first sibling; [i] picks the i-th; miss → null', () => {
  const { scene, item1 } = fixture();
  const rt = fakeRuntime();
  assert.equal(resolve(scene, rt, 'Canvas/Item'), resolve(scene, rt, 'Canvas/Item[0]'));
  assert.equal(resolve(scene, rt, 'Canvas/Item[1]'), item1);
  assert.equal(resolve(scene, rt, 'Canvas/Nope'), null);
  assert.equal(resolve(scene, rt, ''), null);
});

test('press: fires serialized handlers AND emits click; respects disabled unless force', () => {
  const { scene, handler, buyHandler, shopBtn, buyBtn } = fixture();
  const rt = fakeRuntime();
  const r = press(scene, rt, 'Canvas/ShopBtn');
  assert.deepEqual(r, { ok: true, ref: 'Canvas/ShopBtn', fired: 1, drove: ['clickEvent'] });
  assert.equal(handler.fired, 1);
  assert.equal(shopBtn.clicked, 1);                          // emitClick ran

  const d = press(scene, rt, 'Canvas/BuyBtn');               // interactable:false
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'disabled');
  assert.equal(buyHandler.fired, 0);                          // not fired
  assert.equal(buyBtn.clicked, 0);

  assert.equal(press(scene, rt, 'Canvas/BuyBtn', { force: true }).ok, true);
  assert.equal(buyHandler.fired, 1);                          // forced
});

test('press: clear errors for non-button / missing', () => {
  const { scene } = fixture();
  const rt = fakeRuntime();
  assert.equal(press(scene, rt, 'Canvas/Score').reason, 'not-a-button');
  assert.equal(press(scene, rt, 'Canvas/Ghost').reason, 'not-found');
});

test('press: synthesizes a tap (emitTouch) only when no serialized clickEvents fired', () => {
  const rt = fakeRuntime();
  let touched = 0;
  rt.emitTouch = () => { touched++; return true; };

  // touch-wired button: empty clickEvents → fired:0 → falls back to emitTouch
  const touchBtn = node('TouchBtn', [], [{ type: 'Button', interactable: true, clickEvents: [] }]);
  const s1 = node('Scene', [node('Canvas', [touchBtn])]);
  assert.deepEqual(press(s1, rt, 'Canvas/TouchBtn'), { ok: true, ref: 'Canvas/TouchBtn', fired: 0, touched: true, drove: ['touch'], wired: false });
  assert.equal(touched, 1);

  // click-wired button: clickEvents present → fired>0 → NO touch fallback
  const clickBtn = node('ClickBtn', [], [{ type: 'Button', interactable: true, clickEvents: [{ fired: 0, fire() { this.fired++; } }] }]);
  const s2 = node('Scene', [node('Canvas', [clickBtn])]);
  const r2 = press(s2, rt, 'Canvas/ClickBtn');
  assert.equal(r2.fired, 1);
  assert.equal('touched' in r2, false);
  assert.equal(touched, 1, 'emitTouch not called again');
});

test('get / call: read state, drive arbitrary methods', () => {
  const { scene, ctrl } = fixture();
  const rt = fakeRuntime();
  assert.deepEqual(get(scene, rt, 'Canvas/Score:Label.string'), { ok: true, ref: 'Canvas/Score:Label.string', value: '0' });
  assert.equal(get(scene, rt, 'Canvas/Score:Label.missing').value, undefined);
  assert.equal(get(scene, rt, 'Canvas/Score:Sprite.x').reason, 'no-component');
  // call any method on any component — not just buttons
  assert.equal(call(scene, rt, 'Canvas/Mgr:ShopController.buy', [30]).value, 70);
  assert.equal(ctrl.comps[0].gold, 70);
});

test('member selector validation', () => {
  const { scene } = fixture();
  assert.throws(() => get(scene, fakeRuntime(), 'Canvas/Score'), /Comp\.member/);
});

test('snapshot: optional codeHandlers + reachability attach only when the runtime supplies them', () => {
  const { scene, shopBtn } = fixture();
  const rt = fakeRuntime();
  rt.codeHandlers = (n) => (n === shopBtn ? [{ type: 'click', fn: 'onTap', target: 'ShopUI' }] : []);
  rt.reachable = (n) => (n === shopBtn ? { reachable: false, blockedBy: 'Canvas/Overlay' } : { reachable: true, blockedBy: null });

  const map = new Map(snapshot(scene, rt, { reachability: true }).map((d) => [d.ref, d]));
  assert.deepEqual(map.get('Canvas/ShopBtn').codeHandlers, [{ type: 'click', fn: 'onTap', target: 'ShopUI' }]);
  assert.equal(map.get('Canvas/ShopBtn').reachable, false);
  assert.equal(map.get('Canvas/ShopBtn').blockedBy, 'Canvas/Overlay');
  // non-button node: no reachable field; node without code handlers: no codeHandlers field
  assert.equal('reachable' in map.get('Canvas/Score'), false);
  assert.equal('codeHandlers' in map.get('Canvas/Score'), false);
});

test('snapshot: reachable is TRI-STATE (unsure, not coerced to true) + occludedBy surfaces a visual occluder', () => {
  const { scene, shopBtn, buyBtn } = fixture();
  const rt = fakeRuntime();
  rt.reachable = (n) => {
    if (n === shopBtn) return { reachable: 'unsure', blockedBy: null };                                  // can't judge → NOT a confident pass
    if (n === buyBtn) return { reachable: true, blockedBy: null, occludedBy: 'Canvas/Overlay/banner' };  // touch reaches but visually hidden
    return { reachable: true, blockedBy: null };
  };
  const map = new Map(snapshot(scene, rt, { reachability: true }).map((d) => [d.ref, d]));
  assert.equal(map.get('Canvas/ShopBtn').reachable, 'unsure');           // fail-loud on uncertainty, not fail-open to true
  assert.equal('blockedBy' in map.get('Canvas/ShopBtn'), false);         // 'unsure' carries no blocker
  assert.equal(map.get('Canvas/BuyBtn').reachable, true);
  assert.equal(map.get('Canvas/BuyBtn').occludedBy, 'Canvas/Overlay/banner'); // visual occlusion, distinct from blockedBy
});

test('snapshot: reachability is opt-in (off by default even if rt.reachable exists)', () => {
  const { scene } = fixture();
  const rt = fakeRuntime();
  rt.reachable = () => ({ reachable: false, blockedBy: 'x' });
  const d = snapshot(scene, rt).find((x) => x.ref === 'Canvas/ShopBtn');
  assert.equal('reachable' in d, false);
});

test('get: the `Node` pseudo-component reads node intrinsics, not a component', () => {
  const { scene } = fixture();
  const rt = fakeRuntime();
  assert.equal(get(scene, rt, 'Canvas:Node.active').value, true);   // reads node.active via readProp
  assert.equal(get(scene, rt, 'Canvas:Node.name').value, 'Canvas');
});

test('node(): resolves + delegates to rt.nodeInfo; clear reasons otherwise', () => {
  const { scene, shopBtn } = fixture();
  const rt = fakeRuntime();
  assert.equal(nodeInfo(scene, rt, 'Canvas/ShopBtn').reason, 'unsupported'); // no nodeInfo
  rt.nodeInfo = (n) => ({ active: n.active !== false, activeInHierarchy: n === shopBtn, opacity: 255 });
  assert.deepEqual(nodeInfo(scene, rt, 'Canvas/ShopBtn'),
    { ok: true, ref: 'Canvas/ShopBtn', active: true, activeInHierarchy: true, opacity: 255 });
  assert.equal(nodeInfo(scene, rt, 'Canvas/Ghost').reason, 'not-found');
});

test('diff(): reports appeared / disappeared / activated / deactivated / labelChanged', () => {
  const before = [
    { ref: 'Canvas/Panel', active: false },          // hidden → will open
    { ref: 'Canvas/Score', active: true, label: '0' },
    { ref: 'Canvas/Old', active: true },             // will be removed
  ];
  const after = [
    { ref: 'Canvas/Panel', active: true },           // opened
    { ref: 'Canvas/Score', active: true, label: '70' }, // label changed
    { ref: 'Canvas/New', active: true },             // instantiated
  ];
  const d = diff(before, after);
  // entries are node DESCRIPTORS now (carry ref + fields), not bare refs
  assert.deepEqual(d.appeared.map((x) => x.ref), ['Canvas/New']);
  assert.deepEqual(d.disappeared.map((x) => x.ref), ['Canvas/Old']);
  assert.deepEqual(d.activated, [{ ref: 'Canvas/Panel', active: true }]);   // full after-descriptor
  assert.deepEqual(d.deactivated, []);
  assert.deepEqual(d.labelChanged, [{ ref: 'Canvas/Score', from: '0', to: '70' }]);
});

test('reachable(): resolves + delegates to rt.reachable; clear reasons otherwise', () => {
  const { scene, shopBtn } = fixture();
  const rt = fakeRuntime();
  assert.equal(reachable(scene, rt, 'Canvas/ShopBtn').reason, 'unsupported'); // rt has no reachable
  rt.reachable = (n) => ({ reachable: n !== shopBtn, blockedBy: n === shopBtn ? 'Canvas/Mask' : null, visible: n !== shopBtn });
  assert.deepEqual(reachable(scene, rt, 'Canvas/ShopBtn'), { ok: true, ref: 'Canvas/ShopBtn', reachable: false, blockedBy: 'Canvas/Mask', visible: false }); // visible (opacity/scale!==0) passes through, separate from reachable
  rt.reachable = (n) => ({ reachable: true }); // a runtime that omits visible → defaults true
  assert.deepEqual(reachable(scene, rt, 'Canvas/ShopBtn'), { ok: true, ref: 'Canvas/ShopBtn', reachable: true, blockedBy: null, visible: true });
  assert.equal(reachable(scene, rt, 'Canvas/Ghost').reason, 'not-found');
});
