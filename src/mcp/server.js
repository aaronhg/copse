// @ts-check
// Hand-rolled MCP server — JSON-RPC 2.0 over stdio (newline-delimited), NO new runtime
// deps, matching coir's no-dependency ethos. Holds ONE live browser session (a copse Driver
// from connect()): the `connect` tool establishes it, the read/act tools use it, `close` /
// stdin-EOF tears it down. The tool surface lives in tools.js — this file is transport +
// the session lifecycle. Launched by `copse mcp` (see cli.js). All non-protocol output goes
// to stderr; stdout is reserved for the JSON-RPC stream.
import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { TOOLS, TOOLS_BY_NAME } from './tools.js';

const VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; } catch { return '?'; } })();
const PROTOCOL_VERSION = '2025-06-18';
const log = (s) => process.stderr.write(`[copse-mcp] ${s}\n`);

/**
 * Build the JSON-RPC message handler over a session `state` ({ cp, connectOpts }).
 * Pure transport logic (no stdio) so it's unit-testable: returns `{ result }` / `{ error }`
 * to wrap in the JSON-RPC envelope, or `null` for notifications (no reply). Exported for tests.
 * @param {{cp:any, connectOpts?:any, debug?:boolean}} state
 */
export function createDispatcher(state) {
  const toolResult = (text, isError) => ({ result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } });
  return async function handle(msg) {
    switch (msg.method) {
      case 'initialize': {
        const pv = (msg.params && msg.params.protocolVersion) || PROTOCOL_VERSION;
        return { result: { protocolVersion: pv, capabilities: { tools: {} }, serverInfo: { name: 'copse', version: VERSION } } };
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null; // notifications get no response
      case 'ping':
        return { result: {} };
      case 'tools/list': {
        // Debug-tagged tools (the CDP Debugger surface) are advertised by default (the CLI passes
        // debug:true unless `copse mcp --no-debug` — hide them against protected/anti-debug games).
        // They stay dispatchable by name in tools/call below regardless.
        const advertised = state.debug ? TOOLS : TOOLS.filter((t) => !t.debug);
        return { result: { tools: advertised.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } };
      }
      case 'tools/call': {
        const { name, arguments: args = {} } = msg.params || {};
        const tool = TOOLS_BY_NAME.get(name);
        if (!tool) return { error: { code: -32602, message: `unknown tool: ${name}` } };
        let res;
        try { res = await tool.run(state, args); }
        catch (e) { res = { error: e instanceof Error ? e.message : String(e) }; }
        if (res && res.error) return toolResult(`✗ ${`${res.error}`.replace(/^\s*✗\s*/, '')}`, true);
        return toolResult(JSON.stringify(res.data));
      }
      default:
        return msg.id !== undefined ? { error: { code: -32601, message: `method not found: ${msg.method}` } } : null;
    }
  };
}

/**
 * Run the MCP server on stdio. Optionally pre-opens a game if `url` is given
 * (else the client's `connect` tool chooses). Resolves only on stdin EOF (then exits).
 * `debug:false` hides the CDP Debugger tools from tools/list (the CLI defaults to true; `--no-debug` flips it).
 * @param {{url?:string, connectOpts?:any, debug?:boolean}} [opts]
 */
export async function startMcpServer({ url, connectOpts, debug } = {}) {
  // stdout is the protocol channel — keep stray output (puppeteer, the inject bundle's
  // readiness logs, a chatty page) off it so it can't corrupt the JSON-RPC stream.
  console.log = console.info = console.debug = (...a) => process.stderr.write(`${a.join(' ')}\n`);

  const state = { cp: null, connectOpts: connectOpts || {}, debug: !!debug };
  const handle = createDispatcher(state);

  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

  // Serialise: one message at a time, so two browser ops never overlap.
  let chain = Promise.resolve();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const s = line.trim(); if (!s) return;
    let msg; try { msg = JSON.parse(s); } catch { return; } // ignore non-JSON noise
    chain = chain
      .then(() => handle(msg))
      .then((out) => { if (out) send({ jsonrpc: '2.0', id: msg.id, ...out }); })
      .catch((e) => { log(`handler error: ${e && e.stack ? e.stack : e}`); });
  });
  // On stdin EOF: drain the queue, close the browser, then exit once stdout has flushed.
  rl.on('close', () => {
    chain.finally(async () => {
      try { if (state.cp) await state.cp.close(); } catch { /* ignore */ }
      process.stdout.write('', () => process.exit(0));
    });
  });
  const shown = state.debug ? TOOLS.length : TOOLS.filter((t) => !t.debug).length;
  log(`ready — ${shown} tools${state.debug ? '' : ` (+${TOOLS.length - shown} debug, hidden by --no-debug)`}${url ? `, pre-opening ${url}` : ', waiting for connect(url)'}`);

  // `copse mcp <url>` convenience: pre-open in the BACKGROUND. Never block here — the
  // `initialize` handshake must respond immediately (launching/attaching a browser can take
  // tens of seconds; blocking it makes the client report "Failed to connect", like coir never
  // does because its startup only scans local files). Tools called before it finishes just
  // see "no open game" until state.cp is set.
  if (url) {
    /** @type {any} */ (TOOLS_BY_NAME.get('connect')).run(state, { url })
      .then(() => log(`pre-opened ${url}`))
      .catch((e) => log(`pre-open failed: ${e instanceof Error ? e.message : e}`));
  }
}
