// L2 test support: bundle a REAL Cocos engine source module (from a local checkout at
// reference/cocos/<version>) into an importable ESM file, so copse's engine-coupled reads can be
// exercised against REAL engine object shapes — not a hand-authored fake that only encodes copse's
// own assumptions. This is the "import the engine + copse together" harness.
//
// Why esbuild (already a devDep) and not the engine's jest: the engine boots headless only under its
// own jest virtual-module mocks (internal:constants, pal/*). We don't need the whole engine — only the
// event subsystem that owns the internals copse parses. So we bundle a narrow entry (callbacks-invoker)
// and STUB the deep-leaf modules it drags in (platform/debug, data/object, core/settings, pal/*) that
// aren't exercised by constructing an invoker + registering a listener. The REAL code that stays: the
// CallbacksInvoker / CallbackList / CallbackInfo classes + memop(Pool) + utils/js — i.e. the exact
// _callbackTable → callbackInfos → {callback,target} shape copse's codeHandlers/consumerTier walk.
//
// reference/cocos/<ver> is gitignored (hundreds of MB, third-party). When it's absent the L2 test
// skips — `npm test` stays green everywhere; the real-engine assertions run only where the source is.
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const enginesDir = join(ROOT, 'reference', 'cocos');

/** Cloned engine versions under reference/cocos/<ver> (those that actually have a cocos/ tree), or []. */
export function availableEngines() {
  if (!existsSync(enginesDir)) return [];
  return readdirSync(enginesDir).filter((v) => existsSync(join(enginesDir, v, 'cocos'))).sort();
}

// The virtual/build-generated/deep-leaf specifiers to stub. Verified against 3.8.6: this exact set lets
// callbacks-invoker.ts construct in plain Node. A NEW version that needs a different set will fail the
// bundle LOUDLY (a real drift signal, surfaced at the harness layer, not silently mis-parsed).
const CONSTS = "module.exports=new Proxy({TEST:false,DEBUG:true,DEV:true,HTML5:true,EDITOR:false,BUILD:false,PREVIEW:false,NATIVE:false,JSB:false,MINIGAME:false,RUNTIME_BASED:false,SUPPORT_JIT:true},{get:(o,k)=>k==='default'?o:(k in o?o[k]:false)});";
// global-exports needs a REAL settable legacyCC (a module does `legacyCC.js = js` at init).
const GLOB = "export const legacyCC={}; export const cclegacy=legacyCC; export const ccwindow=(typeof globalThis!=='undefined'?globalThis:{}); export const VERSION='0.0.0'; export default legacyCC;";
// universal permissive CJS proxy for lazily-called leaves (debug/object/settings/pal) — never hit at init.
const UNIV = "function mk(){const s=new Proxy(function(){},{get:(_,k)=>k==='__esModule'?undefined:s,set:()=>true,apply:()=>s,construct:()=>({})});return s;} module.exports=mk();";
const LEAF = /platform\/debug$|data\/object$|core\/settings$|^pal\//;

const cache = new Map();

/**
 * Bundle `entryRel` (relative to reference/cocos/<version>) from real engine source and import it.
 * Returns the module namespace, or null if that version/entry isn't checked out. Cached per (ver,entry).
 * @param {string} version @param {string} entryRel @returns {Promise<any|null>}
 */
export async function bundleReal(version, entryRel) {
  const key = `${version}:${entryRel}`;
  if (cache.has(key)) return cache.get(key);
  const entry = join(enginesDir, version, entryRel);
  if (!existsSync(entry)) { cache.set(key, null); return null; }
  const esbuild = (await import('esbuild')).default;
  const virt = {
    name: 'cocos-stub',
    setup(b) {
      b.onResolve({ filter: /^internal:constants$/ }, () => ({ path: 'c', namespace: 'stub' }));
      b.onResolve({ filter: /global-exports$/ }, () => ({ path: 'g', namespace: 'stub' }));
      b.onResolve({ filter: /^internal:|DebugInfos$/ }, () => ({ path: 'u', namespace: 'stub' }));
      b.onResolve({ filter: LEAF }, () => ({ path: 'u', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: a.path === 'c' ? CONSTS : a.path === 'g' ? GLOB : UNIV, loader: 'js' }));
    },
  };
  const out = join(tmpdir(), `copse-real-${version}-${entryRel.replace(/[^a-z0-9]/gi, '_')}.mjs`);
  await esbuild.build({
    entryPoints: [entry], bundle: true, format: 'esm', write: true, outfile: out,
    plugins: [virt], logLevel: 'silent',
    tsconfigRaw: '{"compilerOptions":{"experimentalDecorators":true,"useDefineForClassFields":false}}',
  });
  const mod = await import(pathToFileURL(out).href);
  cache.set(key, mod);
  return mod;
}
