// MCP server — the hand-rolled JSON-RPC dispatcher tested over a FAKE Driver (no browser,
// no real MCP client). Mirrors the zero-engine posture of the other tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher } from '../src/mcp/server.js';
import { TOOLS, TOOLS_BY_NAME } from '../src/mcp/tools.js';

// A fake copse Driver that records calls and returns plausible shapes.
function fakeCp() {
  return {
    calls: [],
    closed: false,
    reload(o) { this.calls.push(['reload', o]); return { ok: true, reloaded: true, url: 'http://localhost:7456/', relevantNodes: 29, buttons: 14 }; },
    snapshot(o) { this.calls.push(['snapshot', o]); return [{ ref: 'Canvas/Btn', button: true }]; },
    interactive() { this.calls.push(['interactive']); return [{ ref: 'Canvas/Btn', reachable: true }]; },
    clickSurface(o) { this.calls.push(['clickSurface', o]); return [{ ref: 'Canvas/Btn', method: 'onBuy', reachable: true }]; },
    press(ref, o) { this.calls.push(['press', ref, o]); return { ok: true, ref, fired: 1, changed: { appeared: [{ ref: 'Canvas/Panel' }] } }; },
    get(sel) { this.calls.push(['get', sel]); return { ok: true, value: '42' }; },
    call(sel, ...a) { this.calls.push(['call', sel, a]); return { ok: true, value: a[0] }; },
    reachable(ref) { this.calls.push(['reachable', ref]); return { ok: true, reachable: false, blockedBy: 'Canvas/Mask' }; },
    node(ref) { this.calls.push(['node', ref]); return { ok: true, active: true }; },
    diff(a, b) { this.calls.push(['diff', a, b]); return { appeared: [{ ref: 'Canvas/Panel' }], disappeared: [], activated: [], deactivated: [], labelChanged: [] }; },
    listeners(ref) { this.calls.push(['listeners', ref]); return [{ type: 'click', fn: 'onBuy' }]; },
    probe() { this.calls.push(['probe']); return { version: '3.8.6', framework: { kind: 'puremvc' }, ok: true }; },
    logs(arg = 0) {
      this.calls.push(['logs', arg]);
      const o = typeof arg === 'number' ? { since: arg } : (arg || {});
      let out = [{ level: 'error', text: 'boom 500' }, { level: 'log', text: 'ok' }].slice(o.since || 0);
      if (o.level) out = out.filter((l) => l.level === o.level);
      if (o.grep) out = out.filter((l) => new RegExp(o.grep, 'i').test(l.text));
      if (o.tail) out = out.slice(-o.tail);
      return out;
    },
    network(arg = {}) { this.calls.push(['network', arg]); return [{ t: 1, method: 'POST', url: '/action', status: 200, type: 'xhr' }]; },
    watch(o) { this.calls.push(['watch', o]); return { timeline: [{ t: 0, dt: 0, changes: { '{gdp.active}': true } }], stoppedBy: 'until', elapsed: 1000, samples: 1 }; },
    patch(sel, hooks) { this.calls.push(['patch', sel, hooks]); return { ok: true, ref: sel, method: 'setBet', hooks: ['before'] }; },
    patchClear(sel) { this.calls.push(['patchClear', sel]); return { ok: true, cleared: sel ? [sel] : [] }; },
    framework() { this.calls.push(['framework']); return { kind: 'puremvc', proxies: ['GameDataProxy'], mediators: ['PanelMediator'], commands: [], registered: 1 }; },
    registerFramework(a) { this.calls.push(['registerFramework', a]); return { ok: true, kind: a && a.kind || 'framework', registered: 1 }; },
    pmState(sel, hasValue, value) { this.calls.push(['pmState', sel, hasValue, value]); return hasValue ? { ok: true, ref: sel, wrote: value } : { ok: true, ref: sel, value: true }; },
    pmCall(sel, ...args) { this.calls.push(['pmCall', sel, args]); return { ok: true, ref: sel, value: 'switched' }; },
    screenshot(o = {}) { this.calls.push(['screenshot', o]); return o.path ? { ok: true, path: o.path, clipped: false } : { base64: 'AAAA', mimeType: 'image/png', clipped: !!o.selector }; },
    visualCheck(ref, o) { this.calls.push(['visualCheck', ref, o]); const based = !!(o && o.baseline); return { ref, drawn: true, matches: based ? true : 'unknown', clear: based ? true : 'unknown', via: based ? 'pixel-confirmed' : 'geometric', visible: true }; },
    captureBaseline(o) { this.calls.push(['captureBaseline', o]); return { 'Canvas/Btn': [0, 0, 0] }; },
    reachableVisual(ref, o) { this.calls.push(['reachableVisual', ref, o]); return { ref, usable: true, reachable: { reachable: true }, visual: { drawn: true } }; },
    close() { this.closed = true; },
  };
}

// A fake debug controller (what attachDebugger returns) — pre-seed it as state.dbg so the debug
// tools dispatch to it without attaching a real CDP session.
function fakeDbg() {
  return {
    calls: [],
    detached: false,
    breakAt(u, l, c, cond) { this.calls.push(['breakAt', u, l, c, cond]); return { breakpointId: 'b1', resolved: 1 }; },
    breakIn(sel, cond) { this.calls.push(['breakIn', sel, cond]); return { breakpointId: 'b2', sel }; },
    breakOnExceptions(s) { this.calls.push(['breakOnExceptions', s]); return { state: s }; },
    waitPause(t) { this.calls.push(['waitPause', t]); return { reason: 'other', frames: [{ i: 0, fn: 'buy', url: 'game.js', line: 10, col: 2, scopes: ['local'] }] }; },
    evalFrame(i, e) { this.calls.push(['evalFrame', i, e]); return { value: 300 }; },
    step(k) { this.calls.push(['step', k]); return { ok: true, step: k }; },
    resume() { this.calls.push(['resume']); return { ok: true }; },
    clear() { this.calls.push(['clear']); return { ok: true }; },
    detach() { this.detached = true; },
  };
}

test('tools registry: each tool has name/description/object inputSchema; core tools present', () => {
  for (const t of TOOLS) {
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.description, 'string');
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(typeof t.run, 'function');
  }
  const names = TOOLS.map((t) => t.name);
  for (const n of ['connect', 'reload', 'snapshot', 'interactive', 'click_surface', 'resolve', 'coverage', 'press', 'get', 'call', 'reachable', 'node', 'probe', 'logs', 'close',
    'run_script', 'dump_script',
    'watch', 'patch', 'patch_clear', 'framework', 'register_framework', 'pm_state', 'pm_call', 'network', 'screenshot',
    'visual_check', 'visual_baseline', 'reachable_visual',
    'break_at', 'break_in', 'break_exceptions', 'wait_pause', 'eval_frame', 'debug_step', 'clear_breakpoints']) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }
  assert.equal(TOOLS_BY_NAME.get('press').name, 'press');
});

test('initialize → serverInfo copse + tools capability; ping → {}', async () => {
  const handle = createDispatcher({ cp: null });
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'copse');
  assert.ok(init.result.capabilities.tools);
  assert.equal(typeof init.result.protocolVersion, 'string');

  const ping = await handle({ id: 2, method: 'ping' });
  assert.deepEqual(ping.result, {});
});

test('tools/list returns the registry shape', async () => {
  const handle = createDispatcher({ cp: null });
  const list = await handle({ id: 3, method: 'tools/list' });
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes('press') && names.includes('snapshot') && names.includes('connect'));
  list.result.tools.forEach((t) => { assert.equal(typeof t.description, 'string'); assert.equal(t.inputSchema.type, 'object'); });
});

test('tools/call dispatches to the Driver and wraps the result as MCP text content', async () => {
  const cp = fakeCp();
  const handle = createDispatcher({ cp });

  const press = await handle({ id: 4, method: 'tools/call', params: { name: 'press', arguments: { ref: 'Canvas/Btn' } } });
  assert.deepEqual(cp.calls.at(-1), ['press', 'Canvas/Btn', {}]);
  const payload = JSON.parse(press.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.changed.appeared[0].ref, 'Canvas/Panel'); // auto-delta survives the round-trip

  // force:true → { force:true }; call spreads args; get passes the selector through
  await handle({ id: 5, method: 'tools/call', params: { name: 'press', arguments: { ref: 'X', force: true } } });
  assert.deepEqual(cp.calls.at(-1), ['press', 'X', { force: true }]);
  // reachableGate:true → { reachableGate:true } reaches the driver (the harness's gate, now on the primitive)
  await handle({ id: 5.5, method: 'tools/call', params: { name: 'press', arguments: { ref: 'X', reachableGate: true } } });
  assert.deepEqual(cp.calls.at(-1), ['press', 'X', { reachableGate: true }]);
  // coverage: runs clickSurface on the live session + coverageJoin against coir's static rows → buckets
  const cov = await handle({ id: 5.7, method: 'tools/call', params: { name: 'coverage', arguments: { staticRows: [{ nodePath: 'Canvas/Btn', method: 'onBuy' }] } } });
  const buckets = JSON.parse(cov.result.content[0].text);
  assert.deepEqual(Object.keys(buckets).sort(), ['ambiguous', 'blocked', 'codeOnly', 'codeRegistered', 'covered', 'uncertain', 'unreached']);
  assert.equal(buckets.covered.length, 1); // exact (Canvas/Btn,onBuy) match, reachable:true → covered
  assert.equal(buckets.covered[0].nodePath, 'Canvas/Btn');
  await handle({ id: 6, method: 'tools/call', params: { name: 'call', arguments: { sel: 'Canvas/Mgr:Ctrl.buy', args: [30] } } });
  assert.deepEqual(cp.calls.at(-1), ['call', 'Canvas/Mgr:Ctrl.buy', [30]]);

  // snapshot defaults relevant:true
  await handle({ id: 7, method: 'tools/call', params: { name: 'snapshot', arguments: {} } });
  assert.deepEqual(cp.calls.at(-1), ['snapshot', { relevant: true, includeInactive: undefined, components: undefined }]);

  // click_surface: opts pass through; returns join-ready (ref, method) rows
  const cs = await handle({ id: 7.5, method: 'tools/call', params: { name: 'click_surface', arguments: {} } });
  assert.deepEqual(cp.calls.at(-1), ['clickSurface', { reachability: undefined, includeInactive: undefined }]);
  assert.equal(JSON.parse(cs.result.content[0].text)[0].method, 'onBuy');

  // reload: no waitUntil → called with {}; waitUntil passes through
  const rl = await handle({ id: 7.6, method: 'tools/call', params: { name: 'reload', arguments: {} } });
  assert.deepEqual(cp.calls.at(-1), ['reload', {}]);
  assert.equal(JSON.parse(rl.result.content[0].text).buttons, 14);
  await handle({ id: 7.7, method: 'tools/call', params: { name: 'reload', arguments: { waitUntil: 'networkidle0' } } });
  assert.deepEqual(cp.calls.at(-1), ['reload', { waitUntil: 'networkidle0' }]);

  // resolve: snapshots the live tree (includeInactive) → tail-matches a coir path to the runtime ref
  const rv = await handle({ id: 7.8, method: 'tools/call', params: { name: 'resolve', arguments: { path: 'home/Canvas/Btn' } } });
  assert.deepEqual(cp.calls.at(-1), ['snapshot', { includeInactive: true }]);
  assert.deepEqual(JSON.parse(rv.result.content[0].text), { ref: 'Canvas/Btn', mount: '', dropped: 'home' });

  // logs: the whole args object passes through (server-side filter); since slices, field is `level`
  const lg = await handle({ id: 8, method: 'tools/call', params: { name: 'logs', arguments: { since: 1 } } });
  assert.deepEqual(cp.calls.at(-1), ['logs', { since: 1 }]);
  assert.deepEqual(JSON.parse(lg.result.content[0].text), [{ level: 'log', text: 'ok' }]);
  // logs grep/level filter server-side → only the matching line comes back (never the 65KB)
  const lgf = await handle({ id: 8.5, method: 'tools/call', params: { name: 'logs', arguments: { grep: '500', level: 'error' } } });
  assert.deepEqual(JSON.parse(lgf.result.content[0].text), [{ level: 'error', text: 'boom 500' }]);
});

test('new tools dispatch to the Driver (watch/patch/patch_clear/framework/pm_state/pm_call/network)', async () => {
  const cp = fakeCp();
  const handle = createDispatcher({ cp });

  // watch: args pass through; returns a diff-only timeline
  const w = await handle({ id: 1, method: 'tools/call', params: { name: 'watch', arguments: { exprs: ['gdp.active'], until: 'gdp.active===false', interval: '1s' } } });
  assert.deepEqual(cp.calls.at(-1), ['watch', { exprs: ['gdp.active'], until: 'gdp.active===false', interval: '1s' }]);
  assert.equal(JSON.parse(w.result.content[0].text).stoppedBy, 'until');

  // patch: hooks assembled from before/after/replace; patch_clear passes the sel
  await handle({ id: 2, method: 'tools/call', params: { name: 'patch', arguments: { sel: 'Canvas/Mgr:Ctrl.setBet', before: '(a,self)=>{}' } } });
  assert.deepEqual(cp.calls.at(-1), ['patch', 'Canvas/Mgr:Ctrl.setBet', { before: '(a,self)=>{}', after: undefined, replace: undefined }]);
  await handle({ id: 3, method: 'tools/call', params: { name: 'patch_clear', arguments: { sel: 'Canvas/Mgr:Ctrl.setBet' } } });
  assert.deepEqual(cp.calls.at(-1), ['patchClear', 'Canvas/Mgr:Ctrl.setBet']);

  // framework detection (no args) + register_framework + pm_state read/write + pm_call
  const fw = await handle({ id: 4, method: 'tools/call', params: { name: 'framework', arguments: {} } });
  assert.deepEqual(cp.calls.at(-1), ['framework']);
  assert.equal(JSON.parse(fw.result.content[0].text).kind, 'puremvc');
  const reg = await handle({ id: 4.5, method: 'tools/call', params: { name: 'register_framework', arguments: { adapter: { kind: 'puremvc', facade: ['x'] } } } });
  assert.deepEqual(cp.calls.at(-1), ['registerFramework', { kind: 'puremvc', facade: ['x'] }]);
  assert.equal(JSON.parse(reg.result.content[0].text).ok, true);
  await handle({ id: 5, method: 'tools/call', params: { name: 'pm_state', arguments: { sel: 'GameDataProxy.active' } } });
  assert.deepEqual(cp.calls.at(-1), ['pmState', 'GameDataProxy.active', false, undefined]); // no value key → read
  await handle({ id: 6, method: 'tools/call', params: { name: 'pm_state', arguments: { sel: 'GameDataProxy.mode', value: 'off' } } });
  assert.deepEqual(cp.calls.at(-1), ['pmState', 'GameDataProxy.mode', true, 'off']); // value key present → write
  await handle({ id: 7, method: 'tools/call', params: { name: 'pm_call', arguments: { sel: 'PanelMediator.toggle', args: [1] } } });
  assert.deepEqual(cp.calls.at(-1), ['pmCall', 'PanelMediator.toggle', [1]]);

  // network: filter args pass through
  const nw = await handle({ id: 8, method: 'tools/call', params: { name: 'network', arguments: { grep: 'action', status: 200 } } });
  assert.deepEqual(cp.calls.at(-1), ['network', { grep: 'action', status: 200 }]);
  assert.equal(JSON.parse(nw.result.content[0].text)[0].url, '/action');
});

test('screenshot returns an MCP image block inline, or a path when written to disk', async () => {
  const cp = fakeCp();
  const handle = createDispatcher({ cp });

  // no path → inline image content block (the model sees the pixels)
  const img = await handle({ id: 1, method: 'tools/call', params: { name: 'screenshot', arguments: {} } });
  assert.equal(img.result.content[0].type, 'image');
  assert.equal(img.result.content[0].data, 'AAAA');
  assert.equal(img.result.content[0].mimeType, 'image/png');

  // path → the tool returns text (the file path), not an image block
  const toDisk = await handle({ id: 2, method: 'tools/call', params: { name: 'screenshot', arguments: { path: '/tmp/shot.png' } } });
  assert.equal(toDisk.result.content[0].type, 'text');
  assert.equal(JSON.parse(toDisk.result.content[0].text).path, '/tmp/shot.png');
});

test('inspection tools dispatch to the Driver (diff/listeners/probe)', async () => {
  const cp = fakeCp();
  const handle = createDispatcher({ cp });

  const d = await handle({ id: 1, method: 'tools/call', params: { name: 'diff', arguments: { before: [], after: [] } } });
  assert.deepEqual(cp.calls.at(-1), ['diff', [], []]);
  assert.equal(JSON.parse(d.result.content[0].text).appeared[0].ref, 'Canvas/Panel');

  await handle({ id: 2, method: 'tools/call', params: { name: 'listeners', arguments: { ref: 'Canvas/Btn' } } });
  assert.deepEqual(cp.calls.at(-1), ['listeners', 'Canvas/Btn']);
  const p = await handle({ id: 3, method: 'tools/call', params: { name: 'probe', arguments: {} } });
  assert.deepEqual(cp.calls.at(-1), ['probe']);
  assert.equal(JSON.parse(p.result.content[0].text).version, '3.8.6');
});

test('visual tools dispatch to the Driver (visual_check/visual_baseline/reachable_visual)', async () => {
  const cp = fakeCp();
  const handle = createDispatcher({ cp });

  // visual_check: no baseline → via geometric, matches unknown
  const vc = await handle({ id: 1, method: 'tools/call', params: { name: 'visual_check', arguments: { ref: 'Canvas/Btn' } } });
  assert.deepEqual(cp.calls.at(-1), ['visualCheck', 'Canvas/Btn', {}]);
  const v = JSON.parse(vc.result.content[0].text);
  assert.equal(v.drawn, true);
  assert.equal(v.matches, 'unknown');
  assert.equal(v.via, 'geometric');

  // baseline passes through → via pixel-confirmed, matches true
  const vc2 = await handle({ id: 2, method: 'tools/call', params: { name: 'visual_check', arguments: { ref: 'Canvas/Btn', baseline: [0, 0, 0] } } });
  assert.deepEqual(cp.calls.at(-1), ['visualCheck', 'Canvas/Btn', { baseline: [0, 0, 0] }]);
  assert.equal(JSON.parse(vc2.result.content[0].text).via, 'pixel-confirmed');

  // visual_baseline: default (no refs) → {}; refs pass through
  const vb = await handle({ id: 3, method: 'tools/call', params: { name: 'visual_baseline', arguments: {} } });
  assert.deepEqual(cp.calls.at(-1), ['captureBaseline', {}]);
  assert.ok(JSON.parse(vb.result.content[0].text)['Canvas/Btn'], 'returns a per-ref signature map');
  await handle({ id: 4, method: 'tools/call', params: { name: 'visual_baseline', arguments: { refs: ['A'] } } });
  assert.deepEqual(cp.calls.at(-1), ['captureBaseline', { refs: ['A'] }]);

  // reachable_visual: the combine → usable
  const rv = await handle({ id: 5, method: 'tools/call', params: { name: 'reachable_visual', arguments: { ref: 'Canvas/Btn' } } });
  assert.deepEqual(cp.calls.at(-1), ['reachableVisual', 'Canvas/Btn', {}]);
  assert.equal(JSON.parse(rv.result.content[0].text).usable, true);
});

test('tools/list hides debug tools by default; --debug (state.debug) surfaces them; hidden ≠ disabled', async () => {
  const core = await createDispatcher({ cp: null })({ id: 1, method: 'tools/list' });
  const coreNames = core.result.tools.map((t) => t.name);
  assert.ok(coreNames.includes('press') && coreNames.includes('diff') && coreNames.includes('listeners'), 'core tools advertised');
  assert.ok(!coreNames.includes('break_in') && !coreNames.includes('wait_pause'), 'debug tools hidden when state.debug is falsy (--no-debug)');

  const withDbg = await createDispatcher({ cp: null, debug: true })({ id: 2, method: 'tools/list' });
  const dbgNames = withDbg.result.tools.map((t) => t.name);
  assert.ok(dbgNames.includes('break_in') && dbgNames.includes('wait_pause'), 'debug tools shown with debug:true');

  // hidden ≠ disabled: a debug tool is still dispatchable by name even when not advertised
  const handle = createDispatcher({ cp: fakeCp(), dbg: fakeDbg() });
  const r = await handle({ id: 3, method: 'tools/call', params: { name: 'clear_breakpoints', arguments: {} } });
  assert.equal(JSON.parse(r.result.content[0].text).ok, true);
});

test('debug tools dispatch to the debugger controller (break_in/at/exceptions/wait_pause/eval_frame/step/clear)', async () => {
  const cp = fakeCp(); const dbg = fakeDbg();
  const handle = createDispatcher({ cp, dbg }); // pre-seed dbg → ensureDbg returns it (no real CDP attach)

  const bi = await handle({ id: 1, method: 'tools/call', params: { name: 'break_in', arguments: { sel: 'Canvas/Mgr:Ctrl.buy' } } });
  assert.deepEqual(dbg.calls.at(-1), ['breakIn', 'Canvas/Mgr:Ctrl.buy', undefined]);
  assert.equal(JSON.parse(bi.result.content[0].text).breakpointId, 'b2');

  await handle({ id: 2, method: 'tools/call', params: { name: 'break_at', arguments: { urlRegex: 'game', line: 10 } } });
  assert.deepEqual(dbg.calls.at(-1), ['breakAt', 'game', 10, undefined, undefined]);

  await handle({ id: 3, method: 'tools/call', params: { name: 'break_exceptions', arguments: { state: 'uncaught' } } });
  assert.deepEqual(dbg.calls.at(-1), ['breakOnExceptions', 'uncaught']);

  const wp = await handle({ id: 4, method: 'tools/call', params: { name: 'wait_pause', arguments: {} } });
  assert.deepEqual(dbg.calls.at(-1), ['waitPause', 30000]); // default timeout
  assert.equal(JSON.parse(wp.result.content[0].text).frames[0].fn, 'buy');

  await handle({ id: 5, method: 'tools/call', params: { name: 'eval_frame', arguments: { frame: 0, expr: 'this.balance' } } });
  assert.deepEqual(dbg.calls.at(-1), ['evalFrame', 0, 'this.balance']);

  await handle({ id: 6, method: 'tools/call', params: { name: 'debug_step', arguments: { kind: 'over' } } });
  assert.deepEqual(dbg.calls.at(-1), ['step', 'over']);
  await handle({ id: 7, method: 'tools/call', params: { name: 'debug_step', arguments: { kind: 'resume' } } }); // resume routes to resume()
  assert.deepEqual(dbg.calls.at(-1), ['resume']);

  await handle({ id: 8, method: 'tools/call', params: { name: 'clear_breakpoints', arguments: {} } });
  assert.deepEqual(dbg.calls.at(-1), ['clear']);
});

test('tools/call: unknown tool → JSON-RPC error; no open session → isError tool result', async () => {
  const handle = createDispatcher({ cp: fakeCp() });
  const bad = await handle({ id: 8, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.equal(bad.error.code, -32602);

  const noSession = createDispatcher({ cp: null });
  const r = await noSession({ id: 9, method: 'tools/call', params: { name: 'snapshot', arguments: {} } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /no open game/);
});

test('close tool tears down the session; notifications get no reply; unknown method errors', async () => {
  const cp = fakeCp();
  const dbg = fakeDbg();
  const state = { cp, dbg };
  const handle = createDispatcher(state);
  const closed = await handle({ id: 10, method: 'tools/call', params: { name: 'close', arguments: {} } });
  assert.equal(cp.closed, true);
  assert.equal(state.cp, null);
  assert.equal(dbg.detached, true); // close also detaches the debugger
  assert.equal(state.dbg, null);
  assert.equal(JSON.parse(closed.result.content[0].text).ok, true);

  assert.equal(await handle({ method: 'notifications/initialized' }), null); // no id, no reply
  const unknown = await handle({ id: 11, method: 'frobnicate' });
  assert.equal(unknown.error.code, -32601);
});

test('recording: record-tagged calls land in state.history as steps+observed; dump_script exports; reset clears', async () => {
  const state = { cp: fakeCp() };
  const handle = createDispatcher(state);
  await handle({ id: 1, method: 'tools/call', params: { name: 'press', arguments: { ref: 'Canvas/Btn', force: true } } });
  await handle({ id: 2, method: 'tools/call', params: { name: 'get', arguments: { sel: 'Canvas/Score:Label.string' } } });
  await handle({ id: 3, method: 'tools/call', params: { name: 'listeners', arguments: { ref: 'Canvas/Btn' } } }); // transport-ish read: NOT recorded
  const r = await handle({ id: 4, method: 'tools/call', params: { name: 'dump_script', arguments: { name: 'flow', reset: true } } });
  const dump = JSON.parse(r.result.content[0].text);
  assert.equal(dump.name, 'flow');
  assert.equal(dump.steps.length, 2);
  assert.equal(dump.steps[0].op, 'press');
  assert.equal(dump.steps[0].ref, 'Canvas/Btn');
  assert.deepEqual(dump.steps[0].opts, { force: true });          // MCP args → Step shape
  assert.equal(dump.steps[0].observed.ok, true);                  // observed = the actual result
  assert.equal(dump.steps[1].op, 'get');
  assert.equal(dump.steps[1].sel, 'Canvas/Score:Label.string');
  assert.equal(state.history.length, 0);                          // reset:true cleared it
});

test('run_script replays a frozen script over the live session and returns the runner result', async () => {
  const handle = createDispatcher({ cp: fakeCp() });
  const script = { name: 's', steps: [
    { op: 'press', ref: 'Canvas/Btn', expect: { ok: true, changed: { appeared: [{ ref: 'Canvas/Panel' }] } } },
    { op: 'get', sel: 'x', expect: { value: '42' } },
  ] };
  const green = await handle({ id: 1, method: 'tools/call', params: { name: 'run_script', arguments: { script } } });
  const out = JSON.parse(green.result.content[0].text);
  assert.equal(out.pass, true);
  assert.equal(out.steps.length, 2);

  const red = await handle({ id: 2, method: 'tools/call', params: { name: 'run_script', arguments: { script: { steps: [{ op: 'get', sel: 'x', expect: { value: 'nope' } }] } } } });
  const bad = JSON.parse(red.result.content[0].text);
  assert.equal(bad.pass, false);
  assert.equal(bad.failedAt, 0);
  assert.equal(bad.steps[0].mismatch.path, 'value');
});
