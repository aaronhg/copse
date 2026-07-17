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
 * @property {(n:any)=>boolean} [emitTouch]              // OPTIONAL: synthesize a tap (touch-start→end) for touch-wired buttons
 * @property {(n:any)=>{type:string,fn?:string,target?:string}[]} [codeHandlers]  // OPTIONAL: user node.on() listeners (engine-internal + Button's own filtered out)
 * @property {(n:any)=>{reachable:boolean|'unsure',reachableFraction?:number,partial?:boolean,blockedBy?:string|null,occludedBy?:string|null,visible?:boolean,reason?:string,via?:{consumer:string,camera:string}}} [reachable]     // OPTIONAL: can a TOUCH reach it (z-order / BlockInputEvents)? tri-state true|false|'unsure' (fail loud on can't-judge). `reachableFraction`/`partial` = multi-point coverage; `blockedBy` = top covering consumer; `occludedBy` = an opaque sprite hiding it visually; `visible` (opacity/scale!==0); `via` = which detection tier resolved it (cross-version provenance) — all separate signals
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
  if (!root) return out;   // a not-yet-booted / mid-swap / torn-down scene (getScene()===null) → empty snapshot, never a null-tree crash
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
        if (reachability && rt.reachable) { const r = rt.reachable(node); desc.reachable = r.reachable; if (r.reachable === false && r.blockedBy) desc.blockedBy = r.blockedBy; if (r.occludedBy) desc.occludedBy = r.occludedBy; if (r.visible === false) desc.visible = false; }
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
 * Flatten a snapshot into a join-ready "click surface": one row per editor-wired
 * clickEvent, keyed by `(ref, method)`. This is the bridge to coir (copse's static
 * sibling): coir emits the SAME key statically — its `loc.nodePath` plus the method
 * inside its `click → method()` ClickEvent edge — so an agent can cross-reference
 * what's *wired* (coir, every scene/prefab) against what's *live & pressable now*
 * (copse, this scene). `method` is the serialized handler name, which survives
 * minification (unlike `component`, the handler class — mangled to `t`/`e` on release
 * builds, where coir is the one that still has the real name).
 *
 * Pass an `interactive()` result (or `snapshot({reachability:true})`) so each button's
 * `reachable`/`blockedBy`/`visible` ride along — that's what turns the join into a
 * verdict: wired+live+reachable = covered; wired+live+`reachable:false` = blocked/dead
 * wiring; wired but absent from this surface = a statically-wired button not reachable
 * in the current scene state (navigate to it). A button with NO serialized clickEvent
 * (touch-wired / code-registered — outside coir's static ClickEvent surface) emits one
 * row with `method:null`.
 * @param {Array<any>} snap a snapshot()/interactive() result
 * @returns {Array<{ref:string, method:string|null, component?:string, target?:string, data?:any, interactable?:boolean, reachable?:boolean, blockedBy?:string, visible?:boolean}>}
 */
export function clickSurface(snap) {
  const rows = [];
  for (const d of snap || []) {
    if (!d || !d.button) continue;
    const flags = {};                                       // runtime signals that ride along (omit-default, like snapshot)
    if (d.interactable != null) flags.interactable = d.interactable;
    if (d.reachable != null) flags.reachable = d.reachable;
    if (d.blockedBy != null) flags.blockedBy = d.blockedBy;
    if (d.occludedBy != null) flags.occludedBy = d.occludedBy;
    if (d.visible != null) flags.visible = d.visible;
    if (d.codeHandlers) flags.codeHandlers = d.codeHandlers; // node.on() listeners — lets the join call a method:null button "code-registered" (NOT covered)
    const clicks = Array.isArray(d.click) ? d.click : [];
    if (!clicks.length) { rows.push({ ref: d.ref, method: null, ...flags }); continue; } // touch-/code-wired button
    for (const h of clicks) {
      const row = { ref: d.ref, method: h.handler ?? null };
      if (h.component) row.component = h.component;
      if (h.target) row.target = h.target;
      if (h.data != null && h.data !== '') row.data = h.data;
      rows.push({ ...row, ...flags });
    }
  }
  return rows;
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
 * registered `node.on(CLICK, …)` listeners fire too). If nothing was serialized
 * (`fired===0`) — typical of buttons wired via raw `touch-start/end` rather than
 * `click` (e.g. some games) — synthesize a tap so they actuate too (`rt.emitTouch`,
 * best-effort, engine-only). Honors `interactable` unless `force`. Returns
 * `{ok, ref, fired, touched?}` or `{ok:false, ref, reason}`.
 * NOTE this tests the handler LOGIC, not whether a player could reach the button. By default z-order /
 * overlap / on-screen are NOT checked (see README "What it can't test"); pass `reachableGate:true` to refuse
 * a press to a button that's a confident `reachable:false` (covered) — the same gate runHarness applies.
 * @param {any} root @param {Runtime} rt @param {string} path @param {{force?:boolean, reachableGate?:boolean}} [opts]
 */
export function press(root, rt, path, { force = false, reachableGate = false } = {}) {
  const node = resolve(root, rt, path);
  if (!node) return { ok: false, ref: path, reason: 'not-found' };
  const btn = rt.asButton(node);
  if (!btn) return { ok: false, ref: path, reason: 'not-a-button' };
  if (!force && !rt.isInteractable(btn)) return { ok: false, ref: path, reason: 'disabled' };
  // OPT-IN reachability gate — the same protection runHarness applies, now available on the bare primitive
  // (so MCP/CLI `press` can refuse driving a button a player can't reach: covered / off-screen). OFF by
  // default, because copse's whole point is to drive the handler LOGIC regardless of reachability (`force`
  // also skips it). Gates only on a confident `reachable:false` (names blockedBy); 'unsure' is not a refusal.
  if (reachableGate && !force && rt.reachable) {
    const r = rt.reachable(node);
    if (r.reachable === false) return { ok: false, ref: path, reason: 'unreachable', blockedBy: r.blockedBy ?? null };
  }
  const fired = rt.fireClickHandlers(btn);
  const code = (rt.codeHandlers ? rt.codeHandlers(node) : null) || [];
  const droveClick = code.some((h) => h.type === 'click'); // a real user on('click') that emitClick will reach
  rt.emitClick(node, btn);
  const res = { ok: true, ref: path, fired };
  // Synthesize a tap ONLY when nothing else drove the button (no serialized clickEvent AND no code on('click')).
  let touched = false;
  if (fired === 0 && !droveClick && typeof rt.emitTouch === 'function') touched = !!rt.emitTouch(node);
  if (touched) res.touched = true;
  // `drove` = what the press actually actuated — so a press that drove NOTHING is never misread as a pass.
  const drove = [];
  if (fired > 0) drove.push('clickEvent');   // ran serialized clickEvents (solid)
  if (droveClick) drove.push('click');       // emitClick reached a real on('click') listener
  if (touched) drove.push('touch');          // dispatched a synthetic tap (best-effort — confirm via `changed`)
  res.drove = drove.length ? drove : 'nothing';
  // `wired` (only on the ambiguous cases): did the button have ANY handler at all (serialized clickEvent OR
  // code-registered)? drove:'nothing' + wired:false = a button wired to NOTHING (dead — a real finding);
  // drove:['touch'] + wired:false = a synthetic tap into a button with no visible handler (suspect, verify).
  if (!drove.length || drove.includes('touch')) {
    res.wired = ((rt.clickHandlers ? rt.clickHandlers(btn) : []).length > 0) || code.length > 0;
  }
  return res;
}

/**
 * Best-effort reachability — copse's headline caveat made checkable. Calling a handler
 * (`press`) ≠ a player being able to reach the button; this asks whether the button is
 * actually on top at its own center, or covered by an overlay / BlockInputEvents / a
 * later-drawn panel. Engine-coupled via `rt.reachable`; the pure core just resolves and
 * delegates. Returns `{ok, ref, reachable, reachableFraction?, partial?, blockedBy, occludedBy?,
 * visible, reason?, via?}` — `via:{consumer,camera}` = which detection tier resolved it (cross-
 * version provenance); `reason` names a can't-judge ('unsure'/false) cause.
 * @param {any} root @param {Runtime} rt @param {string} path
 */
export function reachable(root, rt, path) {
  const node = resolve(root, rt, path);
  if (!node) return { ok: false, ref: path, reason: 'not-found' };
  if (!rt.reachable) return { ok: false, ref: path, reason: 'unsupported' };
  const r = rt.reachable(node);
  // reachable is tri-state: true | false | 'unsure' (can't judge → fail loud, not a confident pass).
  // Pass the full signal set through (fraction/partial/reason/via) so provenance is visible to callers.
  return {
    ok: true, ref: path, reachable: r.reachable, blockedBy: r.blockedBy ?? null, visible: r.visible ?? true,
    ...(r.reachableFraction != null ? { reachableFraction: r.reachableFraction } : {}),
    ...(r.partial ? { partial: true } : {}),
    ...(r.occludedBy ? { occludedBy: r.occludedBy } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.via ? { via: r.via } : {}),
  };
}

// "Canvas/Score:Label.string" → { path, comp, member }. Exported so the cocos layer
// (patch) can address a component method with the same grammar get/call use.
export function splitMember(sel) {
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
  // A green {ok:true} must mean the method EXISTED and ran — not "value:undefined because it's missing/typo'd"
  // (the old behaviour made a misspelled method indistinguishable from a real void method).
  if (typeof rt.readProp(c, member) !== 'function') return { ok: false, ref: sel, reason: 'no-method' };
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
 * state-machine transitions ("press a panel button → its block opens"): snapshot
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
