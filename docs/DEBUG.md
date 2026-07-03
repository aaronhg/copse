# copse debug — breakpoints + call stack via CDP

`copse/debug` (MCP tools `break_*` / `wait_pause` / `eval_frame` / `debug_step`) sets breakpoints and
reads the call stack over the CDP **Debugger** domain, on your live session. **For your OWN dev build** —
pausing the runtime is intrusive, so this only makes sense on a build you own and control.

## Why, over plain DevTools

DevTools is richer for hands-on use. copse-debug's niche:
1. **Break by cc selector** — `break_in Canvas/Mgr:ShopController.buy` instead of hunting `file:line` in a
   minified bundle.
2. **Programmatic / CI / AI-driven** stack capture (assert a call stack, dump it on every call, let an
   agent set a breakpoint → trigger → read the stack to locate a bug).

## How it works (end-to-end)

Two legs cooperate:

- **inject (`window.__copse`)** — finds nodes / resolves a selector to the actual function. `connect()`
  injects the bundle into the `cc` frame (even in attach mode).
- **CDP Debugger** — sets the breakpoint, delivers the pause + call stack.

Lifecycle:

1. **Attach** — `open({attach, browserURL, match})` → `connect()` finds the `cc` frame and injects
   `__copse`. The first `break_*` call lazily runs `attachDebugger(cp.page)`, which opens a Debugger
   session on the **page target and every iframe/OOPIF target**, enables Runtime + Debugger, and tracks
   their execution contexts (later iframes are picked up via `targetcreated`).
2. **Break** —
   - `break_in(path:Comp.method)` → find the context where `__copse` lives → `__copse.get(sel).value`
     (the function) → `Debugger.setBreakpointOnFunctionCall` — **both legs**.
   - `break_at(urlRegex, line)` → `setBreakpointByUrl` on every session — **CDP only**.
   - `break_exceptions(state)` → `setPauseOnExceptions` on every session.
3. **Trigger** — you click in the tab, or copse `press`/`call`. When the method runs, V8 pauses the
   isolate and the owning session emits `Debugger.paused`.
4. **Inspect** (game frozen) — `wait_pause` returns the call stack and remembers which session paused;
   `eval_frame(i, expr)` evaluates in that frame (`this` / locals / args).
5. **Resume / clean up** — `debug_step(resume)` unfreezes; `clear_breakpoints()` removes them; `close`
   detaches every session.

```
break_in Canvas/Mgr:ShopController.buy      → breakpointId 7:1
(press the BUY button)                       → PAUSED, callstack:
  #0 buy              @ shop.ts:50           ← your method (dev source line)
  #1 emit             @ cc.js:97367          ← cc EventHandler.emit
  #2 fireClickHandlers / press …             ← copse frames (only if triggered via copse press)
eval_frame 0 "this.constructor.name"        → "ShopController"
resume
```

> Triggering via copse `press` adds copse's own frames (`press → emit → handler`) to the stack;
> triggering **by hand** gives the natural game→engine→input stack. Both pause the same way.

## Joining a pause you're already in (auto-deferred inject)

If you `open({attach, browserURL, match})` while the renderer is **already halted at a breakpoint** (you
paused in DevTools), copse **auto-detects it and defers the inject** — `open` returns right away with
`paused: true` instead of hanging (a normal inject is a `frame.evaluate`, which blocks while the VM is
paused). While halted:

- **work now** (Debugger only): `wait_pause`, `eval_frame`, `break_at`, `break_exceptions`.
- **auto-wait, then run on resume** (need `__copse`): `snapshot`, `press`, `get`, `break_in`.

Mechanism: every in-page call goes through `cp.ready`; the inject promise stalls while paused and settles
the moment you resume (the queued evaluate runs → `__copse` installs). You and copse share one V8 isolate,
so a `resume`/`step` from **either** side continues the same VM — coordinate so you don't both resume.

## Two ways to break

| tool | how |
|---|---|
| `break_at(urlRegex, line[, col, condition])` | classic file:line — `urlRegex` matches the script URL |
| **`break_in(sel[, condition])`** | copse selector `path:Comp.method` → resolved via `window.__copse` to the actual function → break when **called** (`Debugger.setBreakpointOnFunctionCall`). Works on minified builds. |
| `break_exceptions(all\|uncaught\|none)` | pause on thrown exceptions |

`break_in` breaks the **method** (every instance). Narrow to one instance with `condition` (e.g.
`"this === …"`) or just check `this` via `eval_frame` when it pauses.

## Inspect when paused

- `wait_pause(timeoutMs?)` → `{ reason, frames: [{ i, fn, url, line, col, scopes }] }` (null on timeout, default 30s).
- `eval_frame(frame, expr)` → read locals / `this` / arguments in a frame (`frame` 0 = innermost).
- `debug_step(over|into|out|resume)` → step, then `wait_pause` again for the new stack.
- `clear_breakpoints()` → remove all.

## Typical flow (MCP / agent)

```
open → break_in Canvas/.../yourBtn → (press the button / play) → wait_pause   (read the stack)
     → eval_frame 0 "this"   (inspect state) → debug_step over → … → debug_step resume
```

## Library

```js
import { attachDebugger } from 'copse/debug';
const d = await attachDebugger(cp.page);          // cp from connect()
await d.breakIn('Canvas/Mgr:ShopController.buy');
const stack = await d.waitPause();                // { reason, frames:[…] }
console.log(await d.evalFrame(0, 'this.balance'));
await d.resume();
```

## Caveats

- While paused the game is **frozen** — always resume.
- **iframe-aware**: a Debugger session attaches to the page target *and* every iframe/OOPIF target, and
  `break_in` resolves `window.__copse` across all their execution contexts — so it works whether `cc` is
  in the main frame or a (same- or cross-origin) iframe. Iframes that appear *after* attach are picked up
  too (`targetcreated`). `break_at` is set on every session so a script in any frame matches.
- **Source maps**: v1 reports the loaded (possibly minified) location; mapping back to original `.ts` is a
  later step. A dev build with readable source needs no mapping.
- For your **own dev build** — pausing the runtime is intrusive, so keep this to a build you control.
