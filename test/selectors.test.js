// Selector-grammar conformance for copse's parser. Pins copse's `[i]` / member / divergence
// semantics so they can't drift from coir's canonical grammar (coir/docs/EDITING.md §3)
// without a RED test. The interop corpus at the bottom guards the consuming side: selectors
// coir EMITS (locSelector / tree) must resolve in copse. See docs/SELECTORS.md for the matrix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, get, call } from '../src/core/index.js';

const node = (name, children = [], comps = []) => ({ name, children, comps, active: true });
const rt = {
  name: (n) => n.name,
  children: (n) => n.children || [],
  getComponent: (n, type) => (n.comps || []).find((c) => c.type === type || c.type === `cc.${type}`) || null,
  readProp: (c, p) => c[p],
  callMethod: (c, m, args) => c[m](...args),
};

function tree() {
  const score = node('Score', [], [{ type: 'Label', string: 'hi' }]);
  const panel = node('Panel', [], []); panel.active = false;
  const mgr = node('Mgr', [], [{ type: 'ShopController', gold: 100, buy(n) { this.gold -= n; return this.gold; } }]);
  const items = [node('Item'), node('Item'), node('Item')];
  const literal = node('Slot[0]'); // a node whose NAME literally contains [0]
  const canvas = node('Canvas', [score, panel, mgr, ...items, literal]);
  return node('Scene', [canvas]);
}

// ---- path + [i] -------------------------------------------------------------------------
test('grammar: nested path resolves; top-level child resolves; unknown segment → null', () => {
  const s = tree();
  assert.equal(rt.name(resolve(s, rt, 'Canvas/Score')), 'Score');
  assert.equal(rt.name(resolve(s, rt, 'Canvas')), 'Canvas');
  assert.equal(resolve(s, rt, 'Canvas/Nope'), null);
});

test('grammar: bare name = first same-name sibling; [i] is 0-based among same-name siblings; out-of-range → null', () => {
  const s = tree();
  // three Items — bare "Item" picks [0]; [1]/[2] pick the rest; [3] is out of range
  assert.ok(resolve(s, rt, 'Canvas/Item'));
  assert.equal(resolve(s, rt, 'Canvas/Item'), resolve(s, rt, 'Canvas/Item[0]'));
  assert.notEqual(resolve(s, rt, 'Canvas/Item[1]'), resolve(s, rt, 'Canvas/Item[0]'));
  assert.ok(resolve(s, rt, 'Canvas/Item[2]'));
  assert.equal(resolve(s, rt, 'Canvas/Item[3]'), null);
});

test('grammar DIVERGENCE: a trailing [i] is ALWAYS an index — copse cannot address a node literally named "Slot[0]"', () => {
  const s = tree();
  // coir tries a literal full-path match first (so it CAN select a node named "Slot[0]");
  // copse's resolve always parses the trailing [i] as an index → looks for "Slot"[0] → null.
  assert.equal(resolve(s, rt, 'Canvas/Slot[0]'), null);
});

test('grammar DIVERGENCE: #N absolute array index is unsupported (no stable runtime index)', () => {
  const s = tree();
  assert.equal(resolve(s, rt, 'Canvas/#0'), null); // "#0" is treated as a node NAME, which nothing has
  assert.equal(resolve(s, rt, '#1'), null);
});

// ---- member: path:Comp.member + the Node pseudo-component -------------------------------
test('grammar: path:Comp.member reads a component property', () => {
  const s = tree();
  assert.deepEqual(get(s, rt, 'Canvas/Score:Label.string'), { ok: true, ref: 'Canvas/Score:Label.string', value: 'hi' });
});

test('grammar: call drives path:Comp.method(...args)', () => {
  const s = tree();
  const r = call(s, rt, 'Canvas/Mgr:ShopController.buy', [30]);
  assert.equal(r.value, 70);
});

test('grammar ADDITION: the `Node` pseudo-component reads a node intrinsic (copse-only)', () => {
  const s = tree();
  assert.equal(get(s, rt, 'Canvas/Panel:Node.active').value, false); // Panel.active was set false
  assert.equal(get(s, rt, 'Canvas/Score:Node.active').value, true);
});

test('grammar: malformed member selectors throw (missing ":" or ".")', () => {
  const s = tree();
  assert.throws(() => get(s, rt, 'Canvas/Score'), /:Comp\.member/);     // no ':'
  assert.throws(() => get(s, rt, 'Canvas/Score:Label'), /Comp\.member/); // no '.' after ':'
});

// ---- interop corpus: selectors coir emits must resolve in copse -------------------------
// These are node paths in the shape coir's locSelector/tree produce; copse must consume them.
// (Member selectors here use copse-supported forms only — see docs/SELECTORS.md for the matrix.)
const COIR_EMITS = [
  'Canvas/Score',          // unique name
  'Canvas/Item[0]',        // explicit [i]
  'Canvas/Item[2]',        // last same-name sibling
  'Canvas/Mgr',            // component host
];
test('interop corpus: node paths coir emits resolve in copse', () => {
  const s = tree();
  for (const sel of COIR_EMITS) assert.ok(resolve(s, rt, sel), `copse should resolve coir-emitted "${sel}"`);
});
