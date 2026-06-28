# Selectors: copse's grammar (a subset of coir's)

copse and coir address Cocos nodes/components with the **same selector vocabulary** so an
agent can carry a selector from one to the other. The grammar is **coir's** — its canonical
spec, with the full table and parsing rules, is
[**coir/docs/EDITING.md §3 "Addressing model"**](https://github.com/aaronhg/coir/blob/main/docs/EDITING.md).
This page documents only what's **copse-specific**: the subset copse's runtime parser
implements, where it deliberately diverges, and what it adds. The contract here is pinned by
`test/selectors.test.js` (so it can't silently drift from coir).

## Shared core

```
Parent/Child/Grandchild        node path, relative to the scene root (cc.director.getScene())
Parent/Child[i]                i-th among same-name siblings (0-based, child order)
Parent/Child:Comp.member       a component member (property or method) on that node
```

`Comp` is a component class name (`Label`, `Button`, or a custom script class). A node path
segment with no `[i]` means the **first** same-name sibling. These resolve identically in both
tools — they're the interoperable contract (guarded by the interop corpus in the test).

## What copse does NOT support (coir does)

| Feature | coir | copse | Why |
|---|---|---|---|
| `#N` absolute array index (`#14`, `#4._string`) | ✅ | ❌ | No stable index at runtime (the live tree isn't the serialized `__id__` array). |
| `[i]` on **components** (`Fx:cc.Sprite[1]`) | ✅ | ❌ | copse addresses one component by class name; same-type disambiguation isn't exposed. |
| `[i]` / `.i` on **array elements** (`Btn:cc.Button.clickEvents[0].handler`) | ✅ | ❌ | copse reads a whole member; drill into the returned value yourself. |
| Literal-first node match (a node actually named `Slot[0]`) | ✅ (full-path-first) | ❌ | copse's parser **always** treats a trailing `[i]` as an index, so it can't address a node whose name literally ends in `[0]`. |
| Real component class names (`cc.Label`, `ShopController`) | ✅ (from source/`.meta`) | ⚠️ minified | Release builds mangle `constructor.name` to `t`/`e`/`n`. coir keeps the real name; `getComponent('Label')` and serialized ClickEvent handler names still resolve at runtime. |

**Behavioral divergence — ambiguity:** a bare same-name path (`Canvas/Item` when there are several
`Item` siblings) is **refused** by coir (it asks for an explicit `[i]`), but copse's `resolve` **silently
picks the first** (`[0]`). Prefer an explicit `[i]` for selectors you hand between the tools. (coir's
`test/selectors.test.js` asserts the refusal; copse's asserts the first-pick.)

## What copse ADDS

| Feature | Syntax | Notes |
|---|---|---|
| `Node` pseudo-component | `Canvas/Panel:Node.active` | Read a **node intrinsic** (`active`, `opacity`, `scale`, …) through the member grammar, as if `Node` were a component. copse-only — coir addresses node fields differently. |

## Interop / round-trip

The reliable bridge is the **node-path segment**: a selector coir emits (`locSelector` /
`tree`) resolves in copse as long as it stays within the shared core above. In practice:

- **Node paths transfer** (unique names and `[i]` siblings). `test/selectors.test.js` keeps an
  interop corpus of coir-shaped paths asserted to resolve in copse.
- **Component names do NOT transfer on release builds** — join on the **method name** instead
  (it's serialized, minify-proof). That's exactly what [`docs/COVERAGE.md`](COVERAGE.md) does:
  cross-reference on `(nodePath, method)`, let coir supply the real class name.
- **`[i]` can drift** — both tools compute the index independently (copse: child order at
  runtime; coir: from the prefab/scene JSON). For unique names it's a non-issue; for `[i]`
  paths, treat a near-miss as *ambiguous*, not *absent* (the coverage join does this — it
  fuzzy-matches by name and flags >1 candidate rather than guessing).

## Keep in sync

If you change copse's selector parsing (`resolve` / `splitMember` in `src/core/index.js`),
update `test/selectors.test.js` and this table, and check it against coir's canonical
[EDITING.md §3](https://github.com/aaronhg/coir/blob/main/docs/EDITING.md). The two parsers
live in separate repos (copse over the live tree, coir over the prefab `__id__` array); the
shared subset above is the contract, not a shared implementation.
