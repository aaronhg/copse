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
    hijack() { this.calls.push(['hijack']); return { ok: true }; },
    captured(ref) { this.calls.push(['captured', ref]); return []; },
    logs(since = 0) { this.calls.push(['logs', since]); return [{ level: 'error', text: 'boom' }, { level: 'log', text: 'ok' }].slice(since); },
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
  for (const n of ['connect', 'reload', 'snapshot', 'interactive', 'click_surface', 'resolve', 'press', 'get', 'call', 'reachable', 'node', 'logs', 'close',
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

  // logs: since index passes through; result is the captured console/errors (field is `level`)
  const lg = await handle({ id: 8, method: 'tools/call', params: { name: 'logs', arguments: { since: 1 } } });
  assert.deepEqual(cp.calls.at(-1), ['logs', 1]);
  assert.deepEqual(JSON.parse(lg.result.content[0].text), [{ level: 'log', text: 'ok' }]);
});

test('inspection tools dispatch to the Driver (diff/listeners/hijack/captured)', async () => {
  const cp = fakeCp();
  const handle = createDispatcher({ cp });

  const d = await handle({ id: 1, method: 'tools/call', params: { name: 'diff', arguments: { before: [], after: [] } } });
  assert.deepEqual(cp.calls.at(-1), ['diff', [], []]);
  assert.equal(JSON.parse(d.result.content[0].text).appeared[0].ref, 'Canvas/Panel');

  await handle({ id: 2, method: 'tools/call', params: { name: 'listeners', arguments: { ref: 'Canvas/Btn' } } });
  assert.deepEqual(cp.calls.at(-1), ['listeners', 'Canvas/Btn']);
  await handle({ id: 3, method: 'tools/call', params: { name: 'hijack', arguments: {} } });
  assert.deepEqual(cp.calls.at(-1), ['hijack']);
  await handle({ id: 4, method: 'tools/call', params: { name: 'captured', arguments: { ref: 'Canvas/Btn' } } });
  assert.deepEqual(cp.calls.at(-1), ['captured', 'Canvas/Btn']);
});

test('tools/list hides debug tools by default; --debug (state.debug) surfaces them; hidden ≠ disabled', async () => {
  const core = await createDispatcher({ cp: null })({ id: 1, method: 'tools/list' });
  const coreNames = core.result.tools.map((t) => t.name);
  assert.ok(coreNames.includes('press') && coreNames.includes('diff') && coreNames.includes('listeners'), 'core tools advertised');
  assert.ok(!coreNames.includes('break_in') && !coreNames.includes('wait_pause'), 'debug tools hidden by default');

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
