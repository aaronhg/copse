// @ts-check
// Pure core. Walk / address / drive a live node tree through a minimal
// `Runtime` adapter, so the logic is testable in Node against a fake tree (the
// Cocos `cc.*` glue lives in src/cocos/ — the only engine-coupled layer).
//
// Addressing matches coir's selector grammar so the two tools share a vocabulary:
//   • node path  `Canvas/Panel/ShopBtn`   (segments are node names, '/'-joined)
//   • `[i]`      `Canvas/Item[1]`          (i-th among same-name siblings)
//   • member     `Canvas/Score:Label.string`  (`path:Comp.member` for get/call)
// Paths are RELATIVE to the scene root (the root node itself is not a segment),
// so the top level reads `Canvas`, not `Scene/Canvas`. `#N` absolute indices are
// intentionally unsupported (no stable absolute index in a live tree).

/**
 * The only surface copse needs from the engine. runtime.js implements it over
 * `cc.*`; tests implement it over plain objects.
 * @typedef {object} Runtime
 * @property {(n:any)=>string} name
 * @property {(n:any)=>any[]} children
 * @property {(n:any)=>boolean} isActive                 // active in hierarchy
 * @property {(n:any)=>{type:string,raw:any}[]} components
 * @property {(n:any,type:string)=>any} getComponent     // by class name; null if none
 * @property {(c:any,prop:string)=>any} readProp
 * @property {(c:any,method:string,args:any[])=>any} callMethod
 * @property {(n:any)=>any} asButton                     // the Button comp, or null
 * @property {(b:any)=>boolean} isInteractable
 * @property {(b:any)=>{target?:string,component?:string,handler?:string,data?:any}[]} clickHandlers
 * @property {(b:any)=>number} fireClickHandlers         // run serialized clickEvents; returns count
 * @property {(n:any,b:any)=>void} emitClick             // emit CLICK for code-registered listeners
 * @property {(n:any)=>{type:string,fn?:string,target?:string}[]} [codeHandlers]  // OPTIONAL: user node.on() listeners (engine-internal + Button's own filtered out)
 * @property {(n:any)=>{reachable:boolean,blockedBy?:string|null}} [reachable]     // OPTIONAL: can a player reach it, or is it covered (z-order / BlockInputEvents)?
 * @property {(n:any)=>object} [nodeInfo]  // OPTIONAL: node intrinsics (active/activeInHierarchy/opacity/scale/worldPos/size/onScreen)
 */

const joinSeg = (path, seg) => (path ? `${path}/${seg}` : seg);

// Index of `child` among its same-name siblings (0-based).
function sameNameIndex(siblings, child, rt) {
  let i = 0;
  for (const c of siblings) {
    if (c === child) return i;
    if (rt.name(c) === rt.name(child)) i++;
  }
  return i;
}

// A child's path segment: bare name, or `name[i]` when a sibling shares the name.
function segOf(child, siblings, rt) {
  const name = rt.name(child);
  const dup = siblings.filter((c) => rt.name(c) === name).length > 1;
  return dup ? `${name}[${sameNameIndex(siblings, child, rt)}]` : name;
}

// Drop empty fields from a click handler descriptor (target/data are usually "").
const slimClick = (h) => {
  const o = {};
  if (h.component) o.component = h.component;
  if (h.handler) o.handler = h.handler;
  if (h.target) o.target = h.target;
  if (h.data) o.data = h.data;
  return o;
};

/**
 * Structured view of the live tree: one slim descriptor per node, keyed by a paste-able
 * `ref` (the node's bare name is just the ref's last segment, so it's not repeated).
 * Only non-default fields are emitted: `active` only when false; `button`/`interactable`/
 * `click` on buttons; `label` when a Label is present; `reachable`(+`blockedBy` when
 * covered); `codeHandlers` when any. Raw `components` are OFF by default (`{components:true}`
 * to include — they're minified noise on release builds).
 * @param {any} root @param {Runtime} rt
 * @param {{onlyInteractive?:boolean, includeInactive?:boolean, reachability?:boolean, relevant?:boolean, components?:boolean}} [opts]
 *        relevant: keep only nodes with a testable surface (button | label | codeHandlers) —
 *          cuts structural/visual noise (bones, backgrounds). reachability: O(buttons×nodes), opt-in.
 */
export function snapshot(root, rt, { onlyInteractive = false, includeInactive = false, reachability = false, relevant = false, components = false } = {}) {
  const out = [];
  const visit = (node, path) => {
    const active = rt.isActive(node);
    if (!active && !includeInactive) return;
    const btn = rt.asButton(node);
    const label = rt.getComponent(node, 'Label');
    const labelStr = label ? rt.readProp(label, 'string') : undefined;
    const ch = rt.codeHandlers ? rt.codeHandlers(node) : null;
    const hasCode = !!(ch && ch.length);
    const keep = onlyInteractive ? !!btn : relevant ? (!!btn || labelStr != null || hasCode) : true;
    if (keep) {
      const desc = { ref: path };
      if (!active) desc.active = false;                                 // omit when true (the default)
      if (components) desc.components = rt.components(node).map((c) => c.type);
      if (btn) {
        desc.button = true; desc.interactable = rt.isInteractable(btn); desc.click = rt.clickHandlers(btn).map(slimClick);
        if (reachability && rt.reachable) { const r = rt.reachable(node); desc.reachable = r.reachable; if (!r.reachable && r.blockedBy) desc.blockedBy = r.blockedBy; }
      }
      if (labelStr != null) desc.label = labelStr;
      if (hasCode) desc.codeHandlers = ch;
      out.push(desc);
    }
    const kids = rt.children(node);
    for (const ch of kids) visit(ch, joinSeg(path, segOf(ch, kids, rt)));
  };
  const top = rt.children(root);
  for (const ch of top) visit(ch, segOf(ch, top, rt));
  return out;
}

/**
 * Resolve a node path (with `[i]`) to a live node, or null. Bare name → first
 * same-name sibling. Relative to the scene root.
 * @param {any} root @param {Runtime} rt @param {string} path
 */
export function resolve(root, rt, path) {
  let cur = root;
  for (const seg of String(path).split('/').filter(Boolean)) {
    const m = /^(.*?)(?:\[(\d+)\])?$/.exec(seg);
    if (!m) return null;
    const name = m[1];
    const idx = m[2] != null ? Number(m[2]) : null;
    const same = rt.children(cur).filter((c) => rt.name(c) === name);
    cur = idx != null ? same[idx] : same[0];
    if (!cur) return null;
  }
  return cur === root ? null : cur;
}

/**
 * "Press" a button WITHOUT pixels or input: run its serialized clickEvents (the
 * editor-wired handlers — what coir sees statically) AND emit CLICK (so code-
 * registered `node.on(CLICK, …)` listeners fire too). Honors `interactable`
 * unless `force`. Returns `{ok, ref, fired}` or `{ok:false, ref, reason}`.
 * NOTE this tests the handler LOGIC, not whether a player could reach the button
 * (z-order / overlap / on-screen are not checked — see README "What it can't test").
 * @param {any} root @param {Runtime} rt @param {string} path @param {{force?:boolean}} [opts]
 */
export function press(root, rt, path, { force = false } = {}) {
  const node = resolve(root, rt, path);
  if (!node) return { ok: false, ref: path, reason: 'not-found' };
  const btn = rt.asButton(node);
  if (!btn) return { ok: false, ref: path, reason: 'not-a-button' };
  if (!force && !rt.isInteractable(btn)) return { ok: false, ref: path, reason: 'disabled' };
  const fired = rt.fireClickHandlers(btn);
  rt.emitClick(node, btn);
  return { ok: true, ref: path, fired };
}

/**
 * Best-effort reachability — copse's headline caveat made checkable. Calling a handler
 * (`press`) ≠ a player being able to reach the button; this asks whether the button is
 * actually on top at its own center, or covered by an overlay / BlockInputEvents / a
 * later-drawn panel. Engine-coupled via `rt.reachable`; the pure core just resolves and
 * delegates. Returns `{ok, ref, reachable, blockedBy}` (blockedBy = the covering node's ref).
 * @param {any} root @param {Runtime} rt @param {string} path
 */
export function reachable(root, rt, path) {
  const node = resolve(root, rt, path);
  if (!node) return { ok: false, ref: path, reason: 'not-found' };
  if (!rt.reachable) return { ok: false, ref: path, reason: 'unsupported' };
  const r = rt.reachable(node);
  return { ok: true, ref: path, reachable: r.reachable, blockedBy: r.blockedBy ?? null };
}

// "Canvas/Score:Label.string" → { path, comp, member }
function splitMember(sel) {
  const c = String(sel).indexOf(':');
  if (c < 0) throw new Error(`selector needs ":Comp.member" — got "${sel}"`);
  const path = sel.slice(0, c);
  const rest = sel.slice(c + 1);
  const d = rest.indexOf('.');
  if (d < 0) throw new Error(`selector needs "Comp.member" after ':' — got "${rest}"`);
  return { path, comp: rest.slice(0, d), member: rest.slice(d + 1) };
}

/**
 * Read `path:Comp.prop` for assertions. The pseudo-component `Node` reads a NODE
 * intrinsic instead of a component member, e.g. `Canvas/Panel:Node.active` →
 * `node.active` (handy for visibility checks; see also `node()`).
 * @param {any} root @param {Runtime} rt @param {string} sel
 */
export function get(root, rt, sel) {
  const { path, comp, member } = splitMember(sel);
  const node = resolve(root, rt, path);
  if (!node) return { ok: false, ref: sel, reason: 'not-found' };
  if (comp === 'Node') return { ok: true, ref: sel, value: rt.readProp(node, member) };
  const c = rt.getComponent(node, comp);
  if (!c) return { ok: false, ref: sel, reason: 'no-component' };
  return { ok: true, ref: sel, value: rt.readProp(c, member) };
}

/** Call `path:Comp.method(...args)` directly (drive any game logic, not just buttons). */
export function call(root, rt, sel, args = []) {
  const { path, comp, member } = splitMember(sel);
  const node = resolve(root, rt, path);
  if (!node) return { ok: false, ref: sel, reason: 'not-found' };
  const c = rt.getComponent(node, comp);
  if (!c) return { ok: false, ref: sel, reason: 'no-component' };
  return { ok: true, ref: sel, value: rt.callMethod(c, member, args) };
}

/**
 * Node intrinsics — the state `get` (component members) and `snapshot` (label/click)
 * don't expose: `active`/`activeInHierarchy`/`opacity`/`scale`/`worldPos`/`size`/`onScreen`.
 * The basis for "did this panel actually open?": read it before/after an action.
 * Engine-coupled via `rt.nodeInfo`; the pure core resolves + delegates.
 * @param {any} root @param {Runtime} rt @param {string} path
 */
export function node(root, rt, path) {
  const n = resolve(root, rt, path);
  if (!n) return { ok: false, ref: path, reason: 'not-found' };
  if (!rt.nodeInfo) return { ok: false, ref: path, reason: 'unsupported' };
  return { ok: true, ref: path, ...rt.nodeInfo(n) };
}

/**
 * Diff two snapshots → what an action changed. The general way to judge UI
 * state-machine transitions ("press mainfeature → its block opens"): snapshot
 * (ideally `{includeInactive:true}`), act, snapshot, diff.
 *  - appeared/disappeared/activated/deactivated: the node **descriptors** (each carries
 *    `ref` + `label`/`button`/`click`…), NOT bare refs — so opening a panel hands you its
 *    contents directly, no follow-up snapshot to read labels. (appeared/disappeared = the
 *    node existed in only one snapshot; activated/deactivated = present in both, `active` flipped.)
 *  - labelChanged: `{ ref, from, to }` for nodes whose `label` value changed.
 * @param {{ref:string,active?:boolean,label?:any}[]} before
 * @param {{ref:string,active?:boolean,label?:any}[]} after
 */
export function diff(before, after) {
  const b = new Map((before || []).map((d) => [d.ref, d]));
  const a = new Map((after || []).map((d) => [d.ref, d]));
  const appeared = [], disappeared = [], activated = [], deactivated = [], labelChanged = [];
  for (const [ref, da] of a) {
    const db = b.get(ref);
    if (!db) { appeared.push(da); continue; }      // descriptor, not just ref
    // slim snapshots omit `active` when true, so treat "not false" as active.
    const wasActive = db.active !== false, isActive = da.active !== false;
    if (!wasActive && isActive) activated.push(da);
    if (wasActive && !isActive) deactivated.push(da);
    if ((da.label ?? null) !== (db.label ?? null)) labelChanged.push({ ref, from: db.label ?? null, to: da.label ?? null });
  }
  for (const [ref, db] of b) if (!a.has(ref)) disappeared.push(db);
  return { appeared, disappeared, activated, deactivated, labelChanged };
}
