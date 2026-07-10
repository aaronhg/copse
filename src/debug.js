// NOTE: intentionally NOT `// @ts-check` — CDP/puppeteer glue.
// OPTIONAL edge (subpath `copse/debug`). Set breakpoints + read the call stack via the CDP
// **Debugger** domain, over copse's live session (a puppeteer Page from connect()).
//
// iframe-aware: it attaches a Debugger session to the page target AND to every iframe/OOPIF target,
// and resolves break_in's `window.__copse` across ALL their execution contexts — so it works whether
// `cc` lives in the main frame or a (same- or cross-origin) iframe.
//
// Two ways to break:
//   • breakAt(urlRegex, line)        — classic file:line breakpoint (set on every session).
//   • breakIn('path:Comp.method')    — copse-flavoured: resolve the component method through
//                                       `window.__copse` to the actual function, then break when it's
//                                       CALLED (Debugger.setBreakpointOnFunctionCall). Works on minified
//                                       builds. Breaks the METHOD (every instance) — narrow with a condition.
// NB: pausing the runtime is intrusive — use on your OWN dev build, a build you own and control.

/** @param {any} page a puppeteer Page (connect()'s `cp.page`). @returns a debug controller. */
export async function attachDebugger(page) {
  const browser = page.browser ? page.browser() : null;
  let paused = null, pausedSession = null;
  const sessions = [];   // every CDP session: page target + iframe/OOPIF targets
  const contexts = [];   // { session, id } execution contexts seen (for break_in resolution)
  const bps = [];        // { session, id } breakpoints set this session

  const isFrameTarget = (t) => ['page', 'iframe', 'webview'].includes(t.type());
  const wire = async (target) => {
    let s;
    try { s = await target.createCDPSession(); } catch { return; }
    s.on('Runtime.executionContextCreated', (e) => contexts.push({ session: s, id: e.context.id }));
    s.on('Debugger.paused', (e) => { paused = e; pausedSession = s; });
    s.on('Debugger.resumed', () => { if (pausedSession === s) { paused = null; pausedSession = null; } });
    try { await s.send('Runtime.enable'); } catch { /* */ }       // replays existing contexts → fills `contexts`
    try { await s.send('Debugger.enable'); } catch { /* */ }
    sessions.push(s);
  };

  await wire(page.target());
  for (const t of browser ? browser.targets() : []) { if (t !== page.target() && isFrameTarget(t)) await wire(t); }
  const onTarget = (t) => { if (isFrameTarget(t)) wire(t).catch(() => {}); }; // iframes that appear later
  if (browser && browser.on) browser.on('targetcreated', onTarget);
  await new Promise((r) => setTimeout(r, 120)); // let Runtime.enable replay existing contexts

  const frames = (e) => ({
    reason: e.reason,
    frames: (e.callFrames || []).map((f, i) => ({
      i, fn: f.functionName || '(anonymous)', url: f.url || '',
      line: f.location ? f.location.lineNumber : undefined,
      col: f.location ? f.location.columnNumber : undefined,
      scopes: (f.scopeChain || []).map((s) => s.type),
    })),
  });

  // find the (session, contextId) whose window has __copse — main frame OR any iframe
  const findCopseCtx = async () => {
    for (const c of contexts) {
      const r = await c.session.send('Runtime.evaluate', { expression: '!!(window.__copse)', contextId: c.id, returnByValue: true }).catch(() => null);
      if (r && r.result && r.result.value === true) return c;
    }
    const r = await sessions[0].send('Runtime.evaluate', { expression: '!!(window.__copse)', returnByValue: true }).catch(() => null); // default-context fallback
    return r && r.result && r.result.value === true ? { session: sessions[0], id: undefined } : null;
  };

  return {
    sessions,
    isPaused: () => !!paused,
    // file:line (urlRegex matches the script URL) — set across every session so iframe scripts match too
    async breakAt(urlRegex, lineNumber, columnNumber, condition) {
      const ids = [];
      for (const s of sessions) {
        try { const r = await s.send('Debugger.setBreakpointByUrl', { urlRegex, lineNumber, columnNumber, condition: condition || undefined }); bps.push({ session: s, id: r.breakpointId }); ids.push(r.breakpointId); } catch { /* not in this target */ }
      }
      return { breakpointIds: ids, resolved: ids.length };
    },
    // copse selector `path:Comp.method` → the function (in whichever frame __copse lives) → break on call
    async breakIn(sel, condition) {
      // while halted, __copse may not be injected yet and a plain evaluate would block — break_at works.
      if (paused) return { error: 'renderer is paused — break_in needs __copse (installed after you resume). Resume, then break_in. (break_at works while paused.)' };
      const c = await findCopseCtx();
      if (!c) return { error: '__copse not found in any frame (open a game first?)' };
      const { result } = await c.session.send('Runtime.evaluate', { expression: `window.__copse.get(${JSON.stringify(sel)}).value`, contextId: c.id, returnByValue: false });
      if (!result || result.type !== 'function') return { error: `not a function: ${sel} (got ${result ? result.type : 'nothing'})` };
      const r = await c.session.send('Debugger.setBreakpointOnFunctionCall', { objectId: result.objectId, condition: condition || undefined });
      bps.push({ session: c.session, id: r.breakpointId });
      return { breakpointId: r.breakpointId, sel };
    },
    async breakOnExceptions(state) { for (const s of sessions) { try { await s.send('Debugger.setPauseOnExceptions', { state }); } catch { /* */ } } return { state }; },
    // resolve with the call stack when any session's breakpoint hits, or null on timeout
    async waitPause(timeoutMs = 30000) {
      if (paused) return frames(paused);
      return await new Promise((resolve) => {
        const cleanup = () => { clearTimeout(t); sessions.forEach((s) => s.off('Debugger.paused', onPause)); };
        const onPause = (e) => { cleanup(); resolve(frames(e)); };
        const t = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
        sessions.forEach((s) => s.once('Debugger.paused', onPause));
      });
    },
    async evalFrame(i, expression) {
      if (!paused || !pausedSession) return { error: 'not paused' };
      const cf = (paused.callFrames || [])[i];
      if (!cf) return { error: `no frame ${i}` };
      const res = await pausedSession.send('Debugger.evaluateOnCallFrame', { callFrameId: cf.callFrameId, expression, returnByValue: true }).catch((e) => ({ exceptionDetails: { text: String(e) } }));
      if (res.exceptionDetails) return { error: res.exceptionDetails.text || 'eval error' };
      return { value: res.result ? res.result.value : undefined };
    },
    async step(kind) {
      const s = pausedSession || sessions[0];
      const m = { over: 'stepOver', into: 'stepInto', out: 'stepOut' }[kind] || 'resume';
      await s.send('Debugger.' + m); paused = null; pausedSession = null; return { ok: true, step: kind || 'resume' };
    },
    async resume() { const s = pausedSession || sessions[0]; await s.send('Debugger.resume'); paused = null; pausedSession = null; return { ok: true }; },
    async clear() { for (const b of bps.splice(0)) { try { await b.session.send('Debugger.removeBreakpoint', { breakpointId: b.id }); } catch { /* */ } } return { ok: true }; },
    async detach() { if (browser && browser.off) { try { browser.off('targetcreated', onTarget); } catch { /* */ } } for (const s of sessions.splice(0)) { try { await s.detach(); } catch { /* */ } } },
  };
}
