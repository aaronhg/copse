# pm_trace — the runtime half of a command flow

`coir flow <Class>` reads a PureMVC method's **static** structure: the order of sends / awaits / delays /
callbacks. Its `--time` flag annotates estimated offsets, and its own design note is explicit about the
ceiling — awaited sends are treated as instant so the offset is a **lower bound**, and animation durations
"stay a runtime question". `pm_trace` is that runtime question answered: arm the framework's dispatch choke
points, drive the game, read back what **actually** fired, in what order, how far apart.

```
pm_trace()                  # arm every role the adapter declares
… drive the game …
patch_calls()               # the merged timeline
patch_clear()               # disarm (restores the prototypes)
```

## The output

One row per dispatch event, merged across every armed role and ordered by `i`:

| field | meaning |
|---|---|
| `sel` | `@send` / `@observe` / `@macro` — which choke point |
| `i` | **shared sequence — this is the order.** Not `t` |
| `d` | nesting depth (dispatch is depth-first; indent by this) |
| `t` | ms since the first patch (one epoch shared by all patches) |
| `dt` | gap from the previous row — **where the time actually went** |
| `label` | the adapter's extractor output, e.g. `{n:'appEvAction', to:'MainViewMediator'}` |

Indenting by `d` reconstructs the tree — the same shape coir's static flow prints, but measured:

```
    1ms     +1  @send     {"n":"onActionDown"}
    1ms         │ @observe  {"n":"onActionDown","to":"Controller"}
    1ms         │ @observe  {"n":"onActionDown","to":"MainViewMediator"}
    1ms         │ │ @send     {"n":"StateMachineCommand"}
    1ms         │ │ │ @observe  {"n":"StateMachineCommand","to":"Controller"}
    2ms     +1  │ │ │ │ @send     {"n":"appEvAction"}
    2ms         │ │ │ │ │ @observe  {"n":"appEvAction","to":"Controller"}
    2ms         │ │ │ │ │ │ @send     {"n":"changeButtonState"}
```

## Why the choke points, and not the registries

The obvious design — enumerate `framework().mediators`/`commands` and `pm_patch` each one — **does not work on
PureMVC**, and fails silently. Measured on a live build:

```js
// View.registerMediator
var observer = new puremvc.Observer(mediator.handleNotification, mediator);
// Controller.registerCommand
this.view.registerObserver(notificationName, new puremvc.Observer(this.executeCommand, this));
```

Both capture the function **value** at registration. Wrapping the mediator instance (or
`Controller.prototype.executeCommand`) afterwards is never called — the Observer still holds the original.
Measured: a wrapped `Controller.prototype.executeCommand` fired **0 times across 60 command executions**, while
the observer path recorded all 60. So `at` points at the class prototypes dispatch actually runs *through*:

| role | `at` | what it catches |
|---|---|---|
| `send` | `puremvc.Facade.prototype.sendNotification` | every notification sent (`Notifier.sendNotification` delegates here) |
| `observe` | `puremvc.Observer.prototype.notifyObserver` | every delivery — `notifyContext` **is** the mediator/controller |
| `macro` | `puremvc.MacroCommand.prototype.execute` | macro expansion + its subcommand count |

An `@observe` row with `label.to === 'Controller'` **is** that notification's command running — `commandMap` is
keyed by notification name, so the name you see is the command that ran. That's why enumerating and patching 90
command classes is redundant: the observer path already names them, and it names them *better* (see minification
below).

## Configuring it

Per-game knowledge lives in `copse.frameworks.mjs` (git-ignored); core ships none. See
`copse.frameworks.example.mjs` for the full block:

```js
trace: {
  send: { at: ['puremvc.Facade.prototype.sendNotification'], label: '(a) => ({ n: a[0] })' },
  observe: {
    at: ['puremvc.Observer.prototype.notifyObserver'],
    label: '(a, self) => { const c = self.getNotifyContext(); return { n: a[0].getName(), to: (c.getMediatorName && c.getMediatorName()) || c.constructor.name }; }',
  },
}
```

`at` is a candidate LIST (absorbs per-build naming, like every other adapter field); the first path resolving to
a callable member wins. A role whose paths all miss is reported in `unresolved` rather than silently thinning the
timeline. A code adapter can supply its own `traceTargets(win, roles)` instead.

**`label` runs on ENTRY**, before the original. This is not a detail: `MacroCommand.execute` ends with
`this.subCommands.splice(0)`, so a label reading `self.subCommands` at exit reports `subs: 0` on every macro,
every time. Entry-stamping is also what keeps `i` and `d` correct — a callee returns before its caller, so
exit-stamping would sort a MacroCommand *after* its own subcommands. A label REPLACES `args` in the row (these
methods' raw args are a Notification object that truncates into noise); a throwing label degrades to recording
args and reports itself in `patch_clear().hookErrors`.

## Measured characteristics (why the defaults are what they are)

From one real user action on a production-shaped PureMVC build (Cocos 3.5.2, minified):

- **833 rows over 4.6s** — 306 `@send`, 523 `@observe`, 4 `@macro`.
- **Depth reaches 15.** A `sendNotification`'s observer list is interrupted by the entire subtree each observer
  kicks off, so a flat list of this is unreadable. Hence `d`.
- **Order is not in `t`.** On a second build, `t=238ms` alone carried **20 sends**; `Date.now()` is
  ms-granular and a synchronous chain runs well inside one. Always sort by `i`.
- **The information is in `dt`.** The interesting numbers were `+1129ms setRoundConfig`, `+610ms
  subPanel_HideAll`, `+583ms onShowResultLine` — the silences, not the bursts. Exactly what coir's
  `--time` cannot estimate.
- **`traceMax` defaults to 5000**, not `patch`'s 200: one action's `@observe` alone is 523 rows and autoplay
  sustains ~190 rows/sec, so 200 would drop the *start* of every chain — the part you were tracing for.

## Limits

- **Notification names can be minified too.** Real rows come back as `{"n":"n"}` — some notification names are
  mangled constants (the same reason `framework().commands` contains an `"undefined"` key). The name is usually
  readable, not always.
- **MacroCommand subcommands are unnameable at runtime.** `subCommands` holds minified class refs that even
  *collide* (a real macro reports `['r','n','r']` — the two `r`s are different classes), which is why `macro`
  only counts them. Naming them is coir's `⊕ addSubCommand` job — the intended join, keyed on notification name
  the way `docs/COVERAGE.md` joins on `(nodePath, method)`.
- **Re-injection** (a page navigation) wipes `__copse` and re-registers adapters, but the armed wrappers and
  their recorded calls live on `window.__copsePatches` and survive — `patch_clear()` still restores them.
- Only what the adapter declares is armed. A game dispatching through a path the config doesn't name is invisible;
  `unresolved` tells you which roles didn't resolve on this build.
