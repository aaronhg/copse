// The coir × copse coverage join — pure, no engine. Pins the two-tier match (exact +
// prefab-internal prefix) and the four-plus-one buckets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageJoin, resolveCoirPath, resolveCopseRef } from '../src/coverage.js';

// A coir static map (per editor-wired button) and a copse clickSurface() runtime view.
const STATIC = [
  { nodePath: 'Canvas/ShopBtn', method: 'openShop', handlerClass: 'ShopController' },     // → covered (exact)
  { nodePath: 'Canvas/CoveredBtn', method: 'claim', handlerClass: 'RewardController' },   // → blocked (reachable:false)
  { nodePath: 'SettingsPanel/CloseBtn', method: 'close', handlerClass: 'SettingsPanel' }, // → covered (prefix, mounted under Canvas)
  { nodePath: 'Canvas/Shop/BuyTab', method: 'openBuy', handlerClass: 'ShopController' },  // → unreached (not live)
];
const RUNTIME = [
  { ref: 'Canvas/ShopBtn', method: 'openShop', component: 't', interactable: true, reachable: true },
  { ref: 'Canvas/CoveredBtn', method: 'claim', component: 'n', interactable: true, reachable: false, blockedBy: 'Canvas/Popup/mask' },
  { ref: 'Canvas/SettingsPanel/CloseBtn', method: 'close', component: 'e', interactable: true, reachable: true }, // prefab instantiated under Canvas
  { ref: 'Canvas/TouchBtn', method: null, interactable: true },                                                   // code-/touch-wired
];

test('coverageJoin: scene-level exact match → covered', () => {
  const { covered } = coverageJoin(STATIC, RUNTIME);
  const shop = covered.find((c) => c.nodePath === 'Canvas/ShopBtn');
  assert.ok(shop);
  assert.equal(shop.via, 'exact');
  assert.equal(shop.handlerClass, 'ShopController'); // coir's real class name carried through
  assert.equal(shop.runtime.component, 't');         // copse's minified runtime name
});

test('coverageJoin: prefab-internal button joins by prefix (runtime longer), carrying the mount', () => {
  const { covered } = coverageJoin(STATIC, RUNTIME);
  const close = covered.find((c) => c.nodePath === 'SettingsPanel/CloseBtn');
  assert.ok(close, 'prefab-internal CloseBtn should be covered via prefix');
  assert.equal(close.via, 'prefix');
  assert.equal(close.mount, 'Canvas');               // the instantiation prefix coir couldn't know
  assert.equal(close.dropped, '');                   // nothing dropped — runtime is the longer path
  assert.equal(close.runtime.ref, 'Canvas/SettingsPanel/CloseBtn');
});

test('coverageJoin: scene-root prefix — coir path LONGER (includes the scene file) still joins (the live-game case)', () => {
  // Real Cocos: coir reports `home/Canvas/Home/btn` (scene root included); copse's runtime ref
  // is `Canvas/Home/btn` (scene root excluded). The shorter is a tail of the longer → covered.
  const stat = [{ nodePath: 'home/Canvas/Home/lower/btn_shop', method: 'gotoShop', handlerClass: 'HomeUI' }];
  const run = [{ ref: 'Canvas/Home/lower/btn_shop', method: 'gotoShop', component: 'e', interactable: true, reachable: true }];
  const { covered } = coverageJoin(stat, run);
  assert.equal(covered.length, 1);
  assert.equal(covered[0].via, 'prefix');
  assert.equal(covered[0].mount, '');                // runtime adds no prefix…
  assert.equal(covered[0].dropped, 'home');          // …coir's path had the scene-root segment copse omits
});

test('coverageJoin: live-but-unreachable → blocked, not covered', () => {
  const { blocked, covered } = coverageJoin(STATIC, RUNTIME);
  assert.ok(!covered.some((c) => c.nodePath === 'Canvas/CoveredBtn'));
  const cov = blocked.find((b) => b.nodePath === 'Canvas/CoveredBtn');
  assert.ok(cov);
  assert.equal(cov.runtime.blockedBy, 'Canvas/Popup/mask');
});

test('coverageJoin: wired but not instantiated → unreached; code-/touch-wired → codeOnly', () => {
  const { unreached, codeOnly } = coverageJoin(STATIC, RUNTIME);
  assert.deepEqual(unreached.map((u) => u.nodePath), ['Canvas/Shop/BuyTab']);
  assert.deepEqual(codeOnly.map((r) => r.ref), ['Canvas/TouchBtn']); // method:null, never matched
});

test('coverageJoin: [i] is ignored in the fuzzy suffix match (instantiation shifts indices)', () => {
  const stat = [{ nodePath: 'Row/Cell[0]/Btn', method: 'tap' }];      // coir's within-prefab [i]
  const run = [{ ref: 'Canvas/List/Row[3]/Cell[1]/Btn', method: 'tap', interactable: true, reachable: true }];
  const { covered } = coverageJoin(stat, run);
  assert.equal(covered.length, 1);                                    // Row≈Row[3], Cell[0]≈Cell[1] by name
  assert.equal(covered[0].via, 'prefix');
  assert.equal(covered[0].mount, 'Canvas/List');                      // the 2 segments above the matched suffix
  assert.equal(covered[0].dropped, '');                               // static fully consumed
});

test('coverageJoin: >1 suffix candidate → ambiguous, never silently guessed', () => {
  const stat = [{ nodePath: 'Item/Btn', method: 'tap' }];
  const run = [
    { ref: 'Canvas/A/Item/Btn', method: 'tap', interactable: true, reachable: true },
    { ref: 'Canvas/B/Item/Btn', method: 'tap', interactable: true, reachable: true },
  ];
  const { ambiguous, covered, codeOnly } = coverageJoin(stat, run);
  assert.equal(covered.length, 0);
  assert.equal(ambiguous.length, 1);
  assert.deepEqual(ambiguous[0].candidates, ['Canvas/A/Item/Btn', 'Canvas/B/Item/Btn']);
  // the candidates are accounted for in `ambiguous` — they must NOT also leak into codeOnly
  assert.equal(codeOnly.length, 0);
});

test("coverageJoin: reachable:'unsure' / occludedBy → uncertain bucket, NOT a confident covered (fail-loud survives the join)", () => {
  const stat = [
    { nodePath: 'Canvas/A', method: 'tap' },
    { nodePath: 'Canvas/B', method: 'tap' },
    { nodePath: 'Canvas/C', method: 'tap' },
  ];
  const run = [
    { ref: 'Canvas/A', method: 'tap', interactable: true, reachable: true },                       // confident → covered
    { ref: 'Canvas/B', method: 'tap', interactable: true, reachable: 'unsure' },                    // can't judge → uncertain
    { ref: 'Canvas/C', method: 'tap', interactable: true, reachable: true, occludedBy: 'Canvas/Banner' }, // visually hidden → uncertain
  ];
  const { covered, uncertain, blocked } = coverageJoin(stat, run);
  assert.deepEqual(covered.map((c) => c.nodePath), ['Canvas/A']);
  assert.deepEqual(uncertain.map((c) => c.nodePath), ['Canvas/B', 'Canvas/C']);
  assert.equal(blocked.length, 0); // 'unsure' is NOT blocked (we don't know it's blocked) and NOT covered (we can't confirm)
});

test('coverageJoin: a method:null runtime row WITH codeHandlers → codeRegistered (downgrade); WITHOUT → bare codeOnly', () => {
  const run = [
    { ref: 'Canvas/BtnCode', method: null, interactable: true, codeHandlers: [{ type: 'touch-start', fn: 'onTouchDown', target: 'BtnScaler' }] },
    { ref: 'Canvas/BtnBare', method: null, interactable: true },
  ];
  const { codeRegistered, codeOnly, covered } = coverageJoin([], run);
  assert.equal(covered.length, 0);                                       // neither is promoted to covered
  assert.deepEqual(codeRegistered.map((r) => r.ref), ['Canvas/BtnCode']); // has a live node.on handler → code-registered (NOT covered)
  assert.deepEqual(codeOnly.map((r) => r.ref), ['Canvas/BtnBare']);       // no detectable handler → bare/unknown
  assert.equal(codeRegistered[0].codeHandlers[0].target, 'BtnScaler');    // handler info rides along — we DON'T claim it's an action
});

test('coverageJoin: static rows with method:null are skipped (no join key)', () => {
  const { covered, unreached, codeOnly } = coverageJoin([{ nodePath: 'X/Y', method: null }], []);
  assert.deepEqual([covered, unreached, codeOnly], [[], [], []]);
});

// ---- bounded matching: fan-in, double-count, min-overlap -------------------------------
test('coverageJoin: fan-in — one live button claimed by >1 static row (same name, diff scenes) → ambiguous, never double-covered', () => {
  // home/Canvas/Btn and shop/Canvas/Btn both tail-match the single live Canvas/Btn. Only one
  // scene is actually loaded, but the dropped root (home/shop) means we can't tell which → both
  // ambiguous (reason:'fan-in'), NOT two `covered` rows, and the unloaded one is NOT lost to codeOnly.
  const stat = [
    { nodePath: 'home/Canvas/Btn', method: 'onClick', handlerClass: 'HomeUI' },
    { nodePath: 'shop/Canvas/Btn', method: 'onClick', handlerClass: 'ShopUI' },
  ];
  const run = [{ ref: 'Canvas/Btn', method: 'onClick', interactable: true, reachable: true }];
  const { covered, ambiguous, codeOnly } = coverageJoin(stat, run);
  assert.equal(covered.length, 0, 'neither static row may be silently covered');
  assert.equal(ambiguous.length, 2);
  assert.deepEqual(ambiguous.map((a) => a.nodePath).sort(), ['home/Canvas/Btn', 'shop/Canvas/Btn']);
  assert.ok(ambiguous.every((a) => a.reason === 'fan-in' && a.candidates[0] === 'Canvas/Btn'));
  assert.equal(codeOnly.length, 0, 'the live row is accounted for — must not leak to codeOnly');
});

test('coverageJoin: an exact AND a fuzzy static row claiming the SAME live row → ambiguous, not double-counted', () => {
  const stat = [
    { nodePath: 'Canvas/Btn', method: 'tap' },       // exact match to the live row
    { nodePath: 'Scene/Canvas/Btn', method: 'tap' }, // fuzzy (n=2) onto the same live row
  ];
  const run = [{ ref: 'Canvas/Btn', method: 'tap', interactable: true, reachable: true }];
  const { covered, ambiguous } = coverageJoin(stat, run);
  assert.equal(covered.length, 0, 'the single live button must not be counted twice');
  assert.equal(ambiguous.length, 2);
  assert.ok(ambiguous.every((a) => a.reason === 'fan-in'));
});

test('coverageJoin: a 1-segment static leaf does NOT fuzzy-match an unrelated deep ref (min-overlap)', () => {
  const stat = [{ nodePath: 'btn', method: 'onClick' }];
  const run = [{ ref: 'Canvas/SomeUnrelatedPanel/btn', method: 'onClick', interactable: true, reachable: true }];
  const { covered, unreached, codeOnly } = coverageJoin(stat, run);
  assert.equal(covered.length, 0, '`btn` alone is too weak to claim `…/SomeUnrelatedPanel/btn`');
  assert.deepEqual(unreached.map((u) => u.nodePath), ['btn']); // the static row is honestly unmatched
  assert.deepEqual(codeOnly.map((r) => r.ref), ['Canvas/SomeUnrelatedPanel/btn']); // live row, no real match
});

test('coverageJoin: an EXACT 1-segment match still joins (min-overlap only blocks weak partials)', () => {
  const { covered } = coverageJoin([{ nodePath: 'Btn', method: 'tap' }], [{ ref: 'Btn', method: 'tap', interactable: true, reachable: true }]);
  assert.equal(covered.length, 1);
  assert.equal(covered[0].via, 'exact');
});

// ---- selector resolvers (coir path ↔ copse ref) ----------------------------------------
test('resolveCoirPath: coir path → live ref, dropping the scene-root prefix (the live-game case)', () => {
  const rows = [{ ref: 'Canvas/Home/lower/main_btns/layout/btn_shop' }, { ref: 'Canvas/Home/upper/btn_message' }];
  assert.deepEqual(resolveCoirPath('home/Canvas/Home/lower/main_btns/layout/btn_shop', rows),
    { ref: 'Canvas/Home/lower/main_btns/layout/btn_shop', mount: '', dropped: 'home' });
});

test('resolveCoirPath: prefab-internal coir path → live ref with the inferred mount', () => {
  const rows = [{ ref: 'Canvas/SettingsPanel/CloseBtn' }];
  assert.deepEqual(resolveCoirPath('SettingsPanel/CloseBtn', rows),
    { ref: 'Canvas/SettingsPanel/CloseBtn', mount: 'Canvas', dropped: '' });
});

test('resolveCoirPath: >1 tail match → ambiguous; no match → null', () => {
  const two = [{ ref: 'Canvas/A/Item/Btn' }, { ref: 'Canvas/B/Item/Btn' }];
  assert.deepEqual(resolveCoirPath('Item/Btn', two), { ambiguous: ['Canvas/A/Item/Btn', 'Canvas/B/Item/Btn'] });
  assert.equal(resolveCoirPath('Nope/Gone', [{ ref: 'Canvas/X' }]), null);
});

test('resolveCoirPath: min-overlap — a 1-segment leaf does NOT resolve to a deep ref, but an identical 1-segment does', () => {
  assert.equal(resolveCoirPath('btn', [{ ref: 'Canvas/Panel/btn' }]), null);     // weak partial → no guess
  assert.deepEqual(resolveCoirPath('Btn', [{ ref: 'Btn' }]), { ref: 'Btn', mount: '', dropped: '' }); // full alignment
});

test('resolveCopseRef: reverse — live ref → coir nodePath (real handler class lives on that row)', () => {
  const staticRows = [{ nodePath: 'home/Canvas/Home/lower/main_btns/layout/btn_shop', handlerClass: 'HomeUI' }];
  assert.deepEqual(resolveCopseRef('Canvas/Home/lower/main_btns/layout/btn_shop', staticRows),
    { nodePath: 'home/Canvas/Home/lower/main_btns/layout/btn_shop', mount: '', dropped: 'home' });
});
