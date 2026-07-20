// MCP server — the hand-rolled JSON-RPC dispatcher tested over a FAKE Driver (no browser,
// no real MCP client). Mirrors the zero-engine posture of the other tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher } from '../src/mcp/server.js';
import { TOOLS, TOOLS_BY_NAME, FAMILY, HEADLINE } from '../src/mcp/tools.js';
import { runScript } from '../src/script.js';

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
    reachable(ref, o = {}) { this.calls.push(['reachable', ref, o]); const r = { ok: true, reachable: false, blockedBy: 'Canvas/Mask', visible: true }; return o.visual ? { ...r, usable: false, visual: { drawn: true, clear: 'unknown' } } : r; },
    node(ref) { this.calls.push(['node', ref]); return { ok: true, active: true }; },
    diff(a, b) { this.calls.push(['diff', a, b]); return { appeared: [{ ref: 'Canvas/Panel' }], disappeared: [], activated: [], deactivated: [], labelChanged: [] }; },
    listeners(ref) { this.calls.push(['listeners', ref]); return [{ type: 'click', fn: 'onBuy' }]; },
    async probe() { this.calls.push(['probe']); return { version: '3.8.6', framework: { kind: 'puremvc' }, ok: true }; },
    async eval(expr) { this.calls.push(['eval', expr]); return { ok: true, value: { name: 'game', children: 2 } }; },
    orient() { this.calls.push(['orient']); return { url: 'http://x/', scene: 'MainScene', engine: '3.8.6', framework: { kind: 'puremvc', registered: 1, capabilities: { proxy: true } }, buttons: 3, entryPoints: ['Canvas/Btn'], hint: 'press an entryPoint' }; },
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
    patch(sel, hooks) { this.calls.push(['patch', sel, hooks]); return { ok: true, ref: sel, method: 'setBet', hooks: ['before'], ...(hooks && hooks.trace ? { trace: true } : {}) }; },
    patchClear(sel) { this.calls.push(['patchClear', sel]); return { ok: true, cleared: sel ? [sel] : [] }; },
    patchCalls(sel) { this.calls.push(['patchCalls', sel]); return { ok: true, ref: sel, calls: [{ t: 0, args: [1], ret: 2 }] }; },
    framework() { this.calls.push(['framework']); return { kind: 'puremvc', proxies: ['GameDataProxy'], mediators: ['PanelMediator'], commands: ['ActionCommand'], registered: 1, capabilities: { proxy: true, mediator: true, command: 'class', notify: 'sendNotification' } }; },
    registerFramework(a) { this.calls.push(['registerFramework', a]); return { ok: true, kind: a && a.kind || 'framework', registered: 1 }; },
    pmGet(sel) { this.calls.push(['pmGet', sel]); return { ok: true, ref: sel, value: true }; },
    pmSet(sel, value) { this.calls.push(['pmSet', sel, value]); return { ok: true, ref: sel, wrote: value }; },
    pmCall(sel, ...args) { this.calls.push(['pmCall', sel, args]); return { ok: true, ref: sel, value: 'switched' }; },
    pmPatch(sel, hooks) { this.calls.push(['pmPatch', sel, hooks]); return { ok: true, ref: sel, method: sel.split('.').pop(), kind: sel.includes('Command') ? 'command' : 'instance', ...(hooks && hooks.trace ? { trace: true } : {}) }; },
    pmTrace(o) { this.calls.push(['pmTrace', o]); return { ok: true, armed: [{ role: 'send', sel: '@send', at: 'puremvc.Facade.prototype.sendNotification', labelled: true }], traceMax: (o && o.traceMax) || 5000 }; },
    pmNotify(name, body, type) { this.calls.push(['pmNotify', name, body, type]); return { ok: true, via: 'sendNotification', value: 'sent:' + name }; },
    screenshot(o = {}) { this.calls.push(['screenshot', o]); return o.path ? { ok: true, path: o.path, clipped: false } : { base64: 'AAAA', mimeType: 'image/png', clipped: !!o.selector }; },
    visualCheck(ref, o) { this.calls.push(['visualCheck', ref, o]); const based = !!(o && o.baseline); return { ref, drawn: true, matches: based ? true : 'unknown', clear: based ? true : 'unknown', via: based ? 'pixel-confirmed' : 'geometric', visible: true }; },
    captureBaseline(o) { this.calls.push(['captureBaseline', o]); return { 'Canvas/Btn': [0, 0, 0] }; },
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
  for (const n of ['connect', 'reload', 'snapshot', 'interactive', 'click_surface', 'resolve', 'press', 'get', 'call', 'reachable', 'node', 'orient', 'doctor', 'logs', 'close',
    'run_script', 'dump_script',
    'watch', 'patch', 'patch_clear', 'patch_calls', 'framework', 'register_framework', 'pm_get', 'pm_set', 'pm_call', 'pm_patch', 'pm_trace', 'pm_notify', 'network', 'screenshot',
    'visual_check', 'visual_baseline',
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

test('every tool has a family; tools/list is family-tagged, grouped, headline-first', async () => {
  for (const t of TOOLS) assert.ok(FAMILY[t.name], `tool ${t.name} has no family`);
  // exactly one ★ headline per family
  const heads = {};
  for (const t of TOOLS) if (HEADLINE.has(t.name)) heads[FAMILY[t.name]] = (heads[FAMILY[t.name]] || 0) + 1;
  for (const f of Object.keys(heads)) assert.equal(heads[f], 1, `family ${f} must have exactly one headline`);

  const list = await createDispatcher({ cp: null })({ id: 1, method: 'tools/list' });
  const tools = list.result.tools;
  assert.ok(tools.find((t) => t.name === 'snapshot').description.startsWith('[see ★] '), 'snapshot is the see headline');
  assert.ok(tools.find((t) => t.name === 'interactive').description.startsWith('[see] '), 'interactive is a see member (no ★)');
  assert.ok(tools.find((t) => t.name === 'orient').description.startsWith('[orient ★] '), 'orient is the orient headline');
  assert.ok(tools.find((t) => t.name === 'eval').description.startsWith('[escape] '), 'eval is the escape hatch — no ★, its own family');
  // grouped + ordered: all session tools precede all orient tools; press leads its family
  const fams = tools.map((t) => FAMILY[t.name]);
  assert.ok(fams.lastIndexOf('session') < fams.indexOf('orient'), 'families are contiguous & ordered');
  const drive = tools.filter((t) => FAMILY[t.name] === 'drive');
  assert.equal(drive[0].name, 'press', 'the ★ headline leads its family');
});

test('a tool error carries the driver error class into the TEXT an agent reads', async () => {
  // An MCP client only ever sees text. A `recoverable` flag that stays on the Error object is invisible to
  // the one caller it was added for — so the tag has to be in the string, ahead of the prose.
  // `copse: true` is the brand errClass gates on — without it a stray Node errno (ECONNREFUSED) would
  // render as if it were copse's vocabulary. An unbranded error must contribute NO class at all.
  const boom = (props) => ({ get: async () => { throw Object.assign(new Error('still booting'), props); } });

  const rec = await createDispatcher({ cp: boom({ copse: true, recoverable: true, code: 'init-pending' }) })(
    { id: 1, method: 'tools/call', params: { name: 'get', arguments: { sel: 'x' } } });
  assert.equal(rec.result.isError, true);
  assert.match(rec.result.content[0].text, /\[recoverable\]/);
  assert.match(rec.result.content[0].text, /\[init-pending\]/);
  assert.match(rec.result.content[0].text, /still booting/, 'the prose still explains WHY');

  // Not recoverable → no tag. Absence is the signal; tagging everything would make the tag meaningless.
  const hard = await createDispatcher({ cp: boom({ copse: true, recoverable: false, code: 'op-timeout' }) })(
    { id: 2, method: 'tools/call', params: { name: 'get', arguments: { sel: 'x' } } });
  assert.doesNotMatch(hard.result.content[0].text, /\[recoverable\]/);
  assert.match(hard.result.content[0].text, /\[op-timeout\]/);

  const plain = await createDispatcher({ cp: boom({}) })(
    { id: 3, method: 'tools/call', params: { name: 'get', arguments: { sel: 'x' } } });
  assert.equal(plain.result.content[0].text, '✗ still booting');

  // `code` is ALSO Node's errno convention. An unbranded system error must not wear copse's class — an
  // agent cannot act on `[ECONNREFUSED]` as if it were one of copse's documented codes.
  const errno = await createDispatcher({ cp: boom({ code: 'ECONNREFUSED' }) })(
    { id: 4, method: 'tools/call', params: { name: 'get', arguments: { sel: 'x' } } });
  assert.equal(errno.result.content[0].text, '✗ still booting');
  assert.doesNotMatch(errno.result.content[0].text, /ECONNREFUSED/);
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
  // (the coverage JOIN + the `affected` selection moved to arbor — their contracts are tested there,
  //  in join.test.mjs / select.test.mjs / match.test.mjs. copse keeps the runtime `click_surface` tool.)
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

test('new tools dispatch to the Driver (watch/patch/patch_clear/framework/pm_get/pm_set/pm_call/network)', async () => {
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

  // framework detection (no args) + register_framework + pm_get (read) + pm_set (write) + pm_call
  const fw = await handle({ id: 4, method: 'tools/call', params: { name: 'framework', arguments: {} } });
  assert.deepEqual(cp.calls.at(-1), ['framework']);
  assert.equal(JSON.parse(fw.result.content[0].text).kind, 'puremvc');
  const reg = await handle({ id: 4.5, method: 'tools/call', params: { name: 'register_framework', arguments: { adapter: { kind: 'puremvc', facade: ['x'] } } } });
  assert.deepEqual(cp.calls.at(-1), ['registerFramework', { kind: 'puremvc', facade: ['x'] }]);
  assert.equal(JSON.parse(reg.result.content[0].text).ok, true);
  await handle({ id: 5, method: 'tools/call', params: { name: 'pm_get', arguments: { sel: 'GameDataProxy.active' } } });
  assert.deepEqual(cp.calls.at(-1), ['pmGet', 'GameDataProxy.active']);
  await handle({ id: 6, method: 'tools/call', params: { name: 'pm_set', arguments: { sel: 'GameDataProxy.mode', value: 'off' } } });
  assert.deepEqual(cp.calls.at(-1), ['pmSet', 'GameDataProxy.mode', 'off']);
  await handle({ id: 7, method: 'tools/call', params: { name: 'pm_call', arguments: { sel: 'PanelMediator.toggle', args: [1] } } });
  assert.deepEqual(cp.calls.at(-1), ['pmCall', 'PanelMediator.toggle', [1]]);

  // network: filter args pass through
  const nw = await handle({ id: 8, method: 'tools/call', params: { name: 'network', arguments: { grep: 'action', status: 200 } } });
  assert.deepEqual(cp.calls.at(-1), ['network', { grep: 'action', status: 200 }]);
  assert.equal(JSON.parse(nw.result.content[0].text)[0].url, '/action');
});

test('patch trace + patch_calls + watch captureNetwork pass through', async () => {
  const cp = fakeCp();
  const handle = createDispatcher({ cp });

  // patch trace:true → hooks carry trace; result echoes trace:true
  const p = await handle({ id: 1, method: 'tools/call', params: { name: 'patch', arguments: { sel: 'Canvas/Mgr:Ctrl.setBet', trace: true } } });
  assert.deepEqual(cp.calls.at(-1), ['patch', 'Canvas/Mgr:Ctrl.setBet', { before: undefined, after: undefined, replace: undefined, trace: true }]);
  assert.equal(JSON.parse(p.result.content[0].text).trace, true);

  // patch_calls reads the recorded calls
  const pc = await handle({ id: 2, method: 'tools/call', params: { name: 'patch_calls', arguments: { sel: 'Canvas/Mgr:Ctrl.setBet' } } });
  assert.deepEqual(cp.calls.at(-1), ['patchCalls', 'Canvas/Mgr:Ctrl.setBet']);
  assert.equal(JSON.parse(pc.result.content[0].text).calls[0].ret, 2);

  // watch captureNetwork flag reaches the driver
  await handle({ id: 3, method: 'tools/call', params: { name: 'watch', arguments: { exprs: ['x'], captureNetwork: true } } });
  assert.deepEqual(cp.calls.at(-1), ['watch', { exprs: ['x'], captureNetwork: true }]);
});

test('pm_patch (proxy/mediator/command) + pm_notify dispatch to the Driver', async () => {
  const cp = fakeCp();
  const handle = createDispatcher({ cp });

  // pm_patch a command with trace → hooks carry trace; result echoes kind:'command'
  const pp = await handle({ id: 1, method: 'tools/call', params: { name: 'pm_patch', arguments: { sel: 'ActionCommand.execute', trace: true } } });
  assert.deepEqual(cp.calls.at(-1), ['pmPatch', 'ActionCommand.execute', { before: undefined, after: undefined, replace: undefined, trace: true }]);
  assert.equal(JSON.parse(pp.result.content[0].text).kind, 'command');

  // pm_notify fires the notification (name + body + type)
  const pn = await handle({ id: 2, method: 'tools/call', params: { name: 'pm_notify', arguments: { name: 'StartFlow', body: { amount: 5 } } } });
  assert.deepEqual(cp.calls.at(-1), ['pmNotify', 'StartFlow', { amount: 5 }, undefined]);
  assert.equal(JSON.parse(pn.result.content[0].text).value, 'sent:StartFlow');

  // framework surfaces capabilities so a new build shows what resolved
  const fw = await handle({ id: 3, method: 'tools/call', params: { name: 'framework', arguments: {} } });
  assert.equal(JSON.parse(fw.result.content[0].text).capabilities.command, 'class');
});

test('framework-aware + patch ops record into the session + freeze into replayable steps', async () => {
  const state = { cp: fakeCp() };
  const handle = createDispatcher(state);
  await handle({ id: 1, method: 'tools/call', params: { name: 'pm_set', arguments: { sel: 'GameDataProxy.mode', value: 'off' } } });
  await handle({ id: 2, method: 'tools/call', params: { name: 'pm_call', arguments: { sel: 'PanelMediator.toggle', args: [1] } } });
  await handle({ id: 3, method: 'tools/call', params: { name: 'patch', arguments: { sel: 'Canvas/Mgr:Ctrl.setBet', trace: true } } });
  const r = await handle({ id: 4, method: 'tools/call', params: { name: 'dump_script', arguments: { name: 'pm-flow' } } });
  const dump = JSON.parse(r.result.content[0].text);
  assert.deepEqual(dump.steps.map((s) => s.op), ['pmSet', 'pmCall', 'patch']);
  assert.deepEqual(dump.steps[0], { op: 'pmSet', sel: 'GameDataProxy.mode', value: 'off', observed: { ok: true, ref: 'GameDataProxy.mode', wrote: 'off' } });
  assert.deepEqual(dump.steps[2].hooks, { trace: true });
});

test('runScript replays framework-aware + patch ops via the Driver', async () => {
  const cp = fakeCp();
  const out = await runScript(cp, { steps: [
    { op: 'registerFramework', adapter: { kind: 'puremvc' } },
    { op: 'pmSet', sel: 'GameDataProxy.mode', value: 'off', expect: { wrote: 'off' } },
    { op: 'pmCall', sel: 'M.go', args: [1], expect: { value: 'switched' } },
    { op: 'patch', sel: 'Canvas/Mgr:Ctrl.setBet', hooks: { trace: true }, expect: { ok: true } },
  ] });
  assert.equal(out.pass, true);
  assert.deepEqual(cp.calls.map((c) => c[0]), ['registerFramework', 'pmSet', 'pmCall', 'patch']);
});

test('runScript pmGet/pmSet are unambiguous; a legacy pmState step still routes to the split', async () => {
  const cp = fakeCp();
  const out = await runScript(cp, { continueOnFail: true, steps: [
    { op: 'pmSet', sel: 'GameDataProxy.mode', value: 'off', expect: { wrote: 'off' } },
    { op: 'pmGet', sel: 'GameDataProxy.active', expect: { value: true } },
    { op: 'pmState', sel: 'X.y', value: 'Z', expect: { wrote: 'Z' } },   // legacy write (value present) → pmSet
    { op: 'pmState', sel: 'X.z', expect: { value: true } },              // legacy read (no value) → pmGet
  ] });
  assert.equal(out.pass, true);
  assert.deepEqual(cp.calls[0], ['pmSet', 'GameDataProxy.mode', 'off']);
  assert.deepEqual(cp.calls[1], ['pmGet', 'GameDataProxy.active']);
  assert.deepEqual(cp.calls[2], ['pmSet', 'X.y', 'Z']);   // legacy pmState + value → pmSet
  assert.deepEqual(cp.calls[3], ['pmGet', 'X.z']);        // legacy pmState no value → pmGet
});

test('runScript capture: a read op auto-captures its value on green; capture:false opts out', async () => {
  const cp = fakeCp();
  const out = await runScript(cp, { steps: [
    { op: 'get', sel: 'x' },                  // read op → auto-captures (value is the point)
    { op: 'get', sel: 'y', capture: false },  // explicit opt-out → result omitted
  ] });
  assert.equal(out.pass, true);
  assert.deepEqual(out.steps[0].result, { ok: true, value: '42' });
  assert.equal(out.steps[1].result, undefined);
  // script-level capture → every passing step carries it
  const all = await runScript(cp, { capture: true, steps: [{ op: 'get', sel: 'x' }] });
  assert.deepEqual(all.steps[0].result, { ok: true, value: '42' });
});

test('runScript is a BATCH over the full surface — "call + pm_call then watch" in one call', async () => {
  const cp = fakeCp();
  const out = await runScript(cp, { steps: [
    { op: 'call', sel: 'Canvas/Mgr:PanelCtrl.trigger' },
    { op: 'pmCall', sel: 'PanelMediator.toggle', args: [1] },
    { op: 'watch', opts: { exprs: ['gdp.active'], until: 'gdp.active===false' }, expect: { stoppedBy: 'until' } },
    { op: 'network', opts: { grep: 'action' } },
    { op: 'reachable', ref: 'Canvas/Btn', opts: { visual: true }, expect: { usable: false } }, // the folded-in visual combine, as a step
  ] });
  assert.equal(out.pass, true);
  assert.deepEqual(cp.calls.map((c) => c[0]), ['call', 'pmCall', 'watch', 'network', 'reachable']);
  assert.deepEqual(cp.calls.find((c) => c[0] === 'watch')[1], { exprs: ['gdp.active'], until: 'gdp.active===false' }); // opts reach the driver
  assert.deepEqual(cp.calls.find((c) => c[0] === 'reachable'), ['reachable', 'Canvas/Btn', { visual: true }]);
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

test('inspection tools dispatch to the Driver (diff/listeners/doctor)', async () => {
  const cp = fakeCp();
  const handle = createDispatcher({ cp });

  const d = await handle({ id: 1, method: 'tools/call', params: { name: 'diff', arguments: { before: [], after: [] } } });
  assert.deepEqual(cp.calls.at(-1), ['diff', [], []]);
  assert.equal(JSON.parse(d.result.content[0].text).appeared[0].ref, 'Canvas/Panel');

  await handle({ id: 2, method: 'tools/call', params: { name: 'listeners', arguments: { ref: 'Canvas/Btn' } } });
  assert.deepEqual(cp.calls.at(-1), ['listeners', 'Canvas/Btn']);
  const p = await handle({ id: 3, method: 'tools/call', params: { name: 'doctor', arguments: {} } });
  const doc = JSON.parse(p.result.content[0].text);
  assert.equal(doc.ok, true);                          // fake scene reports children:2 > 0
  assert.equal(doc.coupling.version, '3.8.6');         // doctor folds the old probe output under `coupling`
  assert.ok(cp.calls.some((c) => c[0] === 'eval'));    // …after running the boot-diag evals (webgl/scene/cc)
  assert.ok(cp.calls.some((c) => c[0] === 'probe'));
  const o = await handle({ id: 4, method: 'tools/call', params: { name: 'orient', arguments: {} } });
  assert.deepEqual(cp.calls.at(-1), ['orient']);
  const oj = JSON.parse(o.result.content[0].text);
  assert.equal(oj.scene, 'MainScene'); assert.deepEqual(oj.entryPoints, ['Canvas/Btn']); assert.equal(oj.framework.kind, 'puremvc');
});

test('visual tools dispatch to the Driver (visual_check/visual_baseline); reachable(visual) combines', async () => {
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

  // reachable(visual:true) is the folded-in combine → carries `usable` + a `visual` block; plain reachable doesn't
  const rv = await handle({ id: 5, method: 'tools/call', params: { name: 'reachable', arguments: { ref: 'Canvas/Btn', visual: true } } });
  assert.deepEqual(cp.calls.at(-1), ['reachable', 'Canvas/Btn', { visual: true }]);
  const rvj = JSON.parse(rv.result.content[0].text);
  assert.equal(rvj.usable, false); assert.ok(rvj.visual, 'carries the visual block');
  const plain = await handle({ id: 6, method: 'tools/call', params: { name: 'reachable', arguments: { ref: 'Canvas/Btn' } } });
  assert.deepEqual(cp.calls.at(-1), ['reachable', 'Canvas/Btn', {}]);
  assert.equal(JSON.parse(plain.result.content[0].text).usable, undefined); // no visual → no usable
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

test('pm_trace passes roles/traceMax through and patch_calls reads the merged timeline (no sel)', async () => {
  const cp = fakeCp();
  const handle = createDispatcher({ cp });

  // no args → arm everything the adapter declares
  const a = await handle({ id: 1, method: 'tools/call', params: { name: 'pm_trace', arguments: {} } });
  assert.deepEqual(cp.calls.at(-1), ['pmTrace', { roles: undefined, traceMax: undefined }]);
  assert.equal(JSON.parse(a.result.content[0].text).armed[0].sel, '@send');

  const b = await handle({ id: 2, method: 'tools/call', params: { name: 'pm_trace', arguments: { roles: ['send', 'observe'], traceMax: 9000 } } });
  assert.deepEqual(cp.calls.at(-1), ['pmTrace', { roles: ['send', 'observe'], traceMax: 9000 }]);
  assert.equal(JSON.parse(b.result.content[0].text).traceMax, 9000);

  // patch_calls without sel = the merged read (the whole point of pm_trace); sel is no longer required
  await handle({ id: 3, method: 'tools/call', params: { name: 'patch_calls', arguments: {} } });
  assert.deepEqual(cp.calls.at(-1), ['patchCalls', undefined]);
});
