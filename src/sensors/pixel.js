// @ts-check
// Pure perceptual sensor — the Node-side (dependency-free) half of the node-anchored visual layer.
//
// The split, and why it exists:
//   • The IN-PAGE half (src/cocos/visual.js) answers WHERE to look — a node's screen rect + which
//     dynamic sub-regions to mask — from the live tree. Pure geometry, no framebuffer read: Cocos's
//     WebGL canvas can't be read from page JS (no preserveDrawingBuffer), so pixels are the DRIVER's job.
//   • The DRIVER grabs pixels via a CDP screenshot, then downsamples a region to a tiny SIGNATURE
//     (the browser's 2D canvas is a free decoder for the opaque screenshot raster, even though it
//     can't read the game's GL canvas). Only ~grid²·3 floats cross back to Node.
//   • THIS module is what then runs: it never touches a framebuffer or a DOM — it compares fixed-size
//     signatures. So it is ZERO-DEP, runs in Node, and is unit-tested against synthetic RGBA buffers
//     (no PNG files, no GPU) — exactly the discipline reachable.js/core keep (pure logic, fake inputs).
//
// A "signature" is a GRID×GRID average-pooled RGB thumbnail (values 0..1), à la coir's cross-atlas
// perceptual confirmation. Tolerant by construction: sub-pixel shifts of stable art stay under the
// match threshold, and animation/particle jitter never reaches it because the in-page half MASKS those
// regions before the driver samples. This module also owns the `visualVerdict` three-state assembly,
// whose `true|false|'unknown'` + `via`/`reason` vocabulary is deliberately aligned with reachable.js.

export const DEFAULT_GRID = 16;

/**
 * Average-pool a region of an RGBA raster into a GRID×GRID×3 signature (means in 0..1, alpha ignored —
 * a screenshot composite is opaque). `rect` (integer pixel coords into the buffer) samples a sub-region;
 * omit it for the whole image. Cells with no covered pixels stay 0.
 * @param {ArrayLike<number>} rgba row-major RGBA, length ≥ width*height*4
 * @param {number} width
 * @param {number} height
 * @param {{grid?:number, rect?:{x:number,y:number,w:number,h:number}}} [opts]
 * @returns {Float64Array} length grid*grid*3
 */
export function signature(rgba, width, height, opts = {}) {
  const grid = opts.grid || DEFAULT_GRID;
  const r = opts.rect;
  const x0 = r ? Math.round(r.x) : 0;
  const y0 = r ? Math.round(r.y) : 0;
  const rw = r ? Math.round(r.w) : width;
  const rh = r ? Math.round(r.h) : height;
  const out = new Float64Array(grid * grid * 3);
  for (let gy = 0; gy < grid; gy++) {
    const py0 = y0 + Math.floor((gy * rh) / grid);
    const py1 = y0 + Math.floor(((gy + 1) * rh) / grid);
    for (let gx = 0; gx < grid; gx++) {
      const px0 = x0 + Math.floor((gx * rw) / grid);
      const px1 = x0 + Math.floor(((gx + 1) * rw) / grid);
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let py = py0; py < py1; py++) {
        if (py < 0 || py >= height) continue;
        for (let px = px0; px < px1; px++) {
          if (px < 0 || px >= width) continue;
          const i = (py * width + px) * 4;
          sr += rgba[i]; sg += rgba[i + 1]; sb += rgba[i + 2]; n++;
        }
      }
      const o = (gy * grid + gx) * 3;
      if (n) { out[o] = sr / n / 255; out[o + 1] = sg / n / 255; out[o + 2] = sb / n / 255; }
    }
  }
  return out;
}

/**
 * Normalized-L1 distance between two signatures (0 = identical … ~1 = maximally different). Mean
 * absolute per-channel difference — tolerant, deterministic, cheap.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number}
 */
export function compareSignatures(a, b) {
  if (a.length !== b.length) throw new Error(`signature length mismatch: ${a.length} vs ${b.length}`);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return a.length ? s / a.length : 0;
}

/**
 * Spatial detail: mean per-channel deviation of cells from that channel's own mean. ~0 for a flat/solid
 * region, high for one carrying content. This is the baseline-FREE "is anything drawn?" heuristic — and
 * its honest limit: a legitimately SOLID node reads as low-detail (indistinguishable from blank without a
 * baseline), which is why `matches` (with a baseline) is the authoritative signal. Computed per channel so
 * a solid single colour scores ~0 (not fooled by cross-channel spread).
 * @param {ArrayLike<number>} sig
 * @returns {number}
 */
export function detail(sig) {
  const cells = sig.length / 3;
  if (!cells) return 0;
  let total = 0;
  for (let c = 0; c < 3; c++) {
    let m = 0;
    for (let k = 0; k < cells; k++) m += sig[k * 3 + c];
    m /= cells;
    let d = 0;
    for (let k = 0; k < cells; k++) d += Math.abs(sig[k * 3 + c] - m);
    total += d / cells;
  }
  return total / 3;
}

/**
 * Assemble the three-state VisualVerdict from a region's signature (+ optional golden baseline). Vocabulary
 * mirrors reachable.js on purpose — `true|false|'unknown'`, a `via` provenance tag, a `reason` when unsure —
 * so a caller reads copse's logic + geometric + pixel signals in one grammar.
 *   • drawn   — is there spatial content at the rect (detail > threshold). Best-effort without a baseline.
 *   • matches — does it match the golden signature (≤ matchThreshold). 'unknown' with no baseline.
 *   • clear   — are the visible pixels the node's OWN art (not something drawn over it). At a node-anchored
 *               rect a golden match IS that guarantee, so it derives from `matches`; 'unknown' with no baseline.
 * Degrades LOUD: no signature at all → everything 'unknown', via 'unavailable' — never a silent pass.
 * @param {{ref?:string, sig?:ArrayLike<number>|null, baseline?:ArrayLike<number>|null, rect?:any, masked?:any[], via?:string, matchThreshold?:number, detailThreshold?:number}} opts
 */
export function visualVerdict(opts) {
  const { ref, sig, baseline = null, rect = null, masked = [], via = 'geometric', matchThreshold = 0.1, detailThreshold = 0.01 } = opts;
  const out = /** @type {any} */ ({ ref, rect, masked });
  if (!sig) {
    out.drawn = 'unknown'; out.matches = 'unknown'; out.clear = 'unknown';
    out.via = 'unavailable'; out.reason = 'no-signature';
    return out;
  }
  out.drawn = detail(sig) > detailThreshold;
  if (baseline && baseline.length === sig.length) {
    const score = compareSignatures(sig, baseline);
    out.score = Math.round(score * 1000) / 1000;
    out.matches = score <= matchThreshold;
    out.clear = out.matches;
    out.via = 'pixel-confirmed';
    if (!out.matches) out.reason = 'baseline-mismatch';
  } else {
    out.matches = 'unknown';
    out.clear = 'unknown';
    out.via = via;
    // a present-but-wrong-length baseline (an empty array, or one captured under a different grid) is a shape
    // error, not a real comparison — surface it distinctly and NEVER let compareSignatures throw uncaught.
    out.reason = baseline ? 'baseline-shape' : 'no-baseline';
  }
  return out;
}
