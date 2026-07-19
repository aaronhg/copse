// @ts-check
// Tiny shared in-page condition/eval helpers, so "evaluate an arbitrary in-page condition / parse a
// duration" is ONE implementation used by BOTH temporal primitives:
//   • watch  (install, full bundle)   — a diff-only state TIMELINE of exprs/selectors over time
//   • until  (installProbe, probe bundle) — a --until LOAD gate of held conditions
// They were hand-rolling the same `(0,eval)` + jsonSafe + duration parse; this is the common core.
// Bundled into whichever inject imports it (esbuild), never shipped to lite.

// Make a value JSON-safe. Fast path returns it as-is when directly serialisable; otherwise a CYCLE-SAFE
// clone (cycles → '[cycle]', functions → '[fn]'). Never collapse to a constant like String(v) →
// '[object Object]' — that made watch's JSON.stringify diff see two DIFFERENT states as equal (no change
// ever recorded). The clone preserves distinguishing structure so change-detection works.
export const jsonSafe = (v) => {
  try { JSON.stringify(v); return v; } catch { /* cyclic / unserialisable → structural clone below */ }
  try {
    const seen = new WeakSet();
    return JSON.parse(JSON.stringify(v, (_k, val) => {
      if (typeof val === 'function') return '[fn]';
      if (val && typeof val === 'object') { if (seen.has(val)) return '[cycle]'; seen.add(val); }
      return val;
    }));
  } catch { try { return String(v); } catch { return '[unserializable]'; } }
};

// "1s" / "500ms" / "2m" / "30sec" / "90 seconds" / a number(ms) → ms; falls back to `d` on a truly
// unparseable string (units were `ms|s` ONLY, so '2m' silently truncated to the default — now supported).
export const parseDur = (v, d) => {
  if (v == null) return d;
  if (typeof v === 'number') return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|secs?|seconds?|m|mins?|minutes?)?\s*$/i.exec(String(v));
  if (!m) return d;
  const u = (m[2] || 'ms').toLowerCase();
  const mult = u === 'ms' ? 1 : u.startsWith('s') ? 1000 : 60000; // s*/sec/second → 1000, m*/min/minute → 60000
  return Number(m[1]) * mult;
};

// Evaluate an in-page expression to a JSON-safe VALUE; a throw becomes a '⚠ …' marker (never throws).
export const safeVal = (expr) => { try { return jsonSafe((0, eval)(expr)); } catch (e) { return '⚠ ' + ((e && e.message) || e); } };

// Evaluate an in-page expression to a BOOLEAN; a throw (or empty expr) is false — a condition that
// errors simply isn't "held". This is the shared stop-condition path for watch.until and until's `expr` spec.
export const safeBool = (expr) => { if (!expr) return false; try { return !!(0, eval)(expr); } catch { return false; } };
