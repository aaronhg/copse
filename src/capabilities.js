// @ts-check
// Engine capability profile — what a copse session over THIS engine can and can't do, so a consumer
// (arbor, or any harness) BRANCHES on facts instead of silently assuming Cocos. Cocos and Pixi differ
// in two testable ways that decide whether a whole class of check is even meaningful:
//   • clickSurface — the (ref, method) join with coir's static wiring. Cocos serializes editor ClickEvent
//     handler names; Pixi has no editor and serializes nothing, so every row would be method:null
//     (docs/ENGINES.md §5). coverage / gate are Cocos-only BY CONSTRUCTION.
//   • stableRefs — Cocos node names are identities, so a ref survives siblings coming and going; Pixi
//     names are TYPES (alwaysIndex — core/index.js segOf), so refs are positional and shift under churn.
//     A frozen F5 tripwire replays BY REF, so it's only trustworthy where refs are stable.
// reachability + visualManifest are implemented on BOTH engines (cocos/ and pixi/ each ship reachable.js
// + visual.js), so they're true whenever an engine actually resolved. engine:null (nothing detected)
// zeroes everything — the honest answer for a page with no engine.
//
// This is engine-KEYED (a static profile per engine), which covers the two facts that differ today. The
// finer-grained truth lives in the runtime adapter (rt.alwaysIndex / rt.reachable / __copse.visualManifest);
// a later in-page __copse.capabilities() can supersede this by reading the live rt. Until then this is the
// single declared source, and the driver's `capabilities` getter returns it for the resolved engine.

/**
 * @param {('cocos'|'pixi'|null|undefined|string)} engine
 * @returns {{engine:('cocos'|'pixi'|null), clickSurface:boolean, stableRefs:boolean, reachability:boolean, visualManifest:boolean}}
 */
export function engineCapabilities(engine) {
  const known = engine === 'cocos' || engine === 'pixi';
  return {
    engine: known ? /** @type {'cocos'|'pixi'} */ (engine) : null,
    clickSurface: engine === 'cocos',   // Pixi serializes no click handlers → no (ref,method) join
    stableRefs: engine === 'cocos',     // Pixi refs are positional (alwaysIndex) → shift under sibling churn
    reachability: known,                // both engines implement rt.reachable
    visualManifest: known,              // both engines implement visualManifest (node-anchored pixel checks)
  };
}
