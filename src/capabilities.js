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
 * The version of the surface a CONSUMER binds to — `execute`'s step/facts shape, the driver's method set,
 * and the fields of this capability object. Bump it when a consumer written against the old shape would
 * now be WRONG (a field removed or repurposed, a fact renamed, a step result restructured); NOT for
 * additions, which an old consumer ignores harmlessly.
 *
 * It exists because the package version cannot do this job here: arbor resolves copse DYNAMICALLY (a path
 * from its config or env, deliberately — see arbor/src/driver.mjs), so npm's resolution never runs and a
 * semver bump would be a number nobody checks. And during 0.x the interface moves without the version
 * moving at all — one recent pass renamed an error code, changed what `./harness` exports, and reshaped a
 * fact, none of which touched package.json. A number that tracks the INTERFACE is the only honest signal,
 * and hanging it on `capabilities` means a consumer already reading capabilities to branch on engine facts
 * gets the compatibility check for free.
 */
export const CONTRACT_VERSION = 1;

/**
 * @param {('cocos'|'pixi'|null|undefined|string)} engine
 * @returns {{contractVersion:number, engine:('cocos'|'pixi'|null), clickSurface:boolean, stableRefs:boolean, reachability:boolean, visualManifest:boolean}}
 */
export function engineCapabilities(engine) {
  const known = engine === 'cocos' || engine === 'pixi';
  return {
    contractVersion: CONTRACT_VERSION,
    engine: known ? /** @type {'cocos'|'pixi'} */ (engine) : null,
    clickSurface: engine === 'cocos',   // Pixi serializes no click handlers → no (ref,method) join
    stableRefs: engine === 'cocos',     // Pixi refs are positional (alwaysIndex) → shift under sibling churn
    reachability: known,                // both engines implement rt.reachable
    visualManifest: known,              // both engines implement visualManifest (node-anchored pixel checks)
  };
}
