// @ts-check
// The ONE node → copse ref helper for the LIVE cc tree — shared by reachable.js and visual.js so the ref
// grammar they emit can't drift apart. This matters: baselines and blockedBy are keyed BY ref, so if the two
// layers ever disambiguated same-name siblings differently for the same node, baseline lookups would silently
// miss. It was duplicated byte-for-byte in both; extracting it keeps the two in lockstep by construction.
//
// It matches the grammar core/index.js resolves, but is a SEPARATE impl on purpose: core addresses over the
// Runtime adapter, this walks raw cc nodes (`.parent`/`.children`/`.name`). Pure over that node shape — no
// `cc.*` classes — so it stays trivially inlinable if reachable.js is ever built as a standalone snippet.

/**
 * Node → ref relative to the scene root, `[i]` disambiguating same-name siblings (e.g. `Canvas/List/Item[2]`).
 * @param {any} node
 * @param {any} root scene root the ref is relative to
 * @returns {string|null} null if `node` isn't under `root`
 */
export function refOf(node, root) {
  const chain = []; let n = node;
  while (n && n !== root) { chain.unshift(n); n = n.parent; }
  if (n !== root) return null;
  let path = '', parent = root;
  for (const ch of chain) {
    const sibs = parent.children || [], name = ch.name;
    if (sibs.filter((s) => s.name === name).length > 1) {
      let i = 0; for (const s of sibs) { if (s === ch) break; if (s.name === name) i++; }
      path = path ? `${path}/${name}[${i}]` : `${name}[${i}]`;
    } else path = path ? `${path}/${name}` : name;
    parent = ch;
  }
  return path;
}
