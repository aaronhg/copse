# Engines: the second runtime (Pixi 8)

copse's one load-bearing decision is that the **pure core is engine-free over a `Runtime`
adapter** (`src/core/index.js`, the `@typedef` at the top is the whole contract) and the engine
coupling lives in exactly one place (`src/cocos/`). This page is the **research verdict on
whether that seam actually holds for a second engine** — PixiJS 8 — and what it costs.

**Status: IMPLEMENTED** (`src/pixi/`, `dist/copse.inject.pixi.js`) — the research below is what it was
built from, kept as the rationale. Verified end-to-end against the MINIFIED production build of
`pixijs/open-games`' bubbo-bubbo: the shipped bundle injected pre-boot captures the app
(`version: "8.14.1"`), `probe()` reports `ok:true`, `reachable` resolves via `hitTest`, `press`
dispatches and the game actually navigates title → gameplay, and `anchors()` surfaces `_game.stats`
through the game's own field names. Not yet wired into the driver/CLI/MCP (§9.3).

## Provenance (what was actually measured)

Everything marked ✅ below was measured on **`pixijs/open-games`** (the official corpus:
`bubbo-bubbo` and `puzzling-potions`, both **pixi.js 8.14.1**), driven headless over
puppeteer-core, on **both the dev server and the minified production build** — the production
build is the one that matters, and several conclusions flip between the two. Claims that are
reasoned rather than measured are marked ⚠️ inferred. The spike scripts that produced this are
throwaway (kept out of the repo per the zero-dep convention); reproduce with
`git clone --depth 1 https://github.com/pixijs/open-games`, `npm i && npm run assets &&
npx vite build`, then attach as in §1.

The seam holds. The core needs two small changes (§9); `src/cocos/` needs a ~250-line hoist.

## 1. Attach: `__PIXI_APP_INIT__`, not a global convention ✅

Pixi 8 core registers an init hook **unconditionally** (`ApplicationInitHook`, in the shipped
bundle — not gated on the `devtools` init option):

```js
static init() { globalThis.__PIXI_APP_INIT__?.call(globalThis, this, VERSION); }
```

Set `globalThis.__PIXI_APP_INIT__` **before the game's scripts load** (puppeteer
`evaluateOnNewDocument` — the same slot the Cocos driver uses) and you capture the
`Application` **and the exact version string** from any v8 app with **zero game cooperation**.
Verified on both games, dev and minified prod; neither game sets `__PIXI_APP__` or
`__PIXI_DEVTOOLS__` itself.

This is strictly better than the `__PIXI_APP__` convention the PixiJS devtools extension
documents (which requires the game to volunteer it). Keep the devtools chain as **fallback**,
in the extension's own order: `__PIXI_DEVTOOLS__.app` → `__PIXI_APP__` → `__PIXI_STAGE__` →
`app.stage` → `renderer.lastObjectRendered`, each also searched across same-origin iframes
(mirroring `findCC()` in `src/cocos/runtime.js:183`).

- Root is `app.stage` (vs `cc.director.getScene()`).
- `renderer.events.features` (`{move, globalMove, click, wheel}`) is readable at attach —
  worth a preflight, since a game can disable input wholesale.
- `renderer.events.resolution` is needed for coordinate mapping (§4).

## 2. Runtime mapping

| `Runtime` member | Pixi 8 | |
|---|---|---|
| root | `app.stage` | ✅ |
| `name(n)` | see §3 — **not** `label`, **not** `constructor.name` | ⚠️ |
| `children` / `isActive` | `n.children` / `n.visible` + ancestor chain | ✅ |
| `components(n)` | `[{type: pixiType(n), raw: n}]` — the node **is** the object | — |
| `getComponent(n, T)` | `pixiType(n) === T ? n : null` | — |
| `getComponent(n,'Label')` | `n.renderPipeId === 'text' ? n : null` | ✅ §6 |
| `readProp(c,'string')` | `c.text` | ✅ §6 |
| `asButton(n)` | interactive **and carrying listeners** — see §4 | ✅ |
| `isInteractable(b)` | `b.eventMode !== 'none'`; also check ancestor `interactiveChildren` | ⚠️ |
| `clickHandlers(b)` | **always `[]`** — Pixi has no serialized handlers (§5) | ✅ |
| `codeHandlers(n)` | `Object.keys(n._events)` (eventemitter3) — simpler than Cocos's `_eventProcessor` ladder | ✅ |
| `fireClickHandlers` | `0` | — |
| `emitClick` / `press` | synthetic DOM PointerEvents (§4) | ✅ |
| `reachable(n)` | `renderer.events.rootBoundary.hitTest(x, y)` (§4) | ✅ |
| `nodeInfo(n)` | `visible` / `alpha` / `getBounds()` / `getGlobalPosition()` | ⚠️ |
| freeze / unfreeze (`hold`) | `app.ticker.stop()` / `.start()` | ⚠️ |
| `assetsPending` | no public pending count on `Assets` → `{known:false}` | ⚠️ |

**One field, one meaning — across both layers AND both engines.** `visible` is reported by *two* layers
(`reachable` and `visualManifest`) and must mean the same thing in both, or a caller gating on
`visible && drawn` is silently reading two different questions. It is the PERCEPTUAL signal: hidden,
`alpha`/`opacity === 0`, or `scale === 0` **anywhere up the ancestor chain** — exact-zero only, no
thresholds. It is deliberately kept OUT of the `reachable` boolean, because input ignores alpha: a fully
transparent button is still clickable. Each engine has ONE definition (`cocos/geom.js` / `pixi/geom.js`
`visibleOf`) that both of its layers call. Pixi's `isActive`/`activeInHierarchy` is a *narrower*
question — the ancestor `visible` chain only, the analogue of Cocos's `activeInHierarchy` — and uses
`visibleChain`, which ignores alpha by design. (This was a real divergence: `visualManifest` reported
`visible` from the node ALONE, so a node under a hidden parent came back `true` from one layer and
`false` from the other, and Cocos agreed with neither. Pinned in `test/pixi.test.js`.)

`pixiType(n)` must be **duck-typed**, never `instanceof` and never `constructor.name` (§3).
Copy the approach in the official devtools' `getPixiType.ts`: `renderPipeId === 'sprite'`,
`_leftWidth`/`_rightWidth` → NineSliceSprite, `particleChildren` → ParticleContainer, etc.
Measured: `renderPipeId` survives minification intact (`sprite` / `text` / `graphics` /
`tilingSprite`, `undefined` for plain Containers).

Also honor the devtools' three opt-out properties on any container: `__devtoolIgnore`,
`__devtoolIgnoreChildren`, `__devtoolLocked`.

## 3. Addressing: the real divergence ✅

**This is the one place Pixi genuinely breaks copse's model, and it is not the part you'd
expect.** `path:Comp.member` splits into two halves with opposite fates.

### The `:Comp.member` half SURVIVES — and is stronger than on Cocos

Minifiers mangle **identifiers in scope** (class names, locals) but **not property/method
names** (that needs opt-in property mangling, which is rare because it breaks reflection).
Measured on the minified production build of both games:

```
bubbo TitleScreen   ctor="or"   methods: prepare, show, hide, resize, _calculateAngle, _buildDetails
                                fields:  _playBtn, _audioBtn, _forkBtn, _cannon, _aimAngle, _background
bubbo GameScreen    ctor="?"    methods: show, hide, update, resize
                                fields:  _background, _game, _gsap
pp    GameScreen                methods: prepare, pause, resume, reset, resize, show, hide, onMove, onMatch
                                fields:  match3, cauldron, timer, score, pauseButton, settingsButton
pp    Match3                    methods: setup, reset, startPlaying, stopPlaying, isPlaying, pause, resume
                                fields:  config, timer, stats, board, actions, process, special
```

Class names are dead (`or`, `Z`, `I`, `ke`); **every method and field name is intact.** So on a
production build:

```
…:Node.startPlaying()      drive the game's own logic
…:Node.stats               assert on it
…:Node.board               read the model
…:Node.pauseButton         reach a child by the game's own name for it
```

In Cocos, `:Comp` reaches a Component attached to a node. In Pixi **the node is the game's own
class** — there's no component indirection, and `_game` / `match3` reach logic objects that
aren't display objects at all and live outside the tree. copse's headline capability ("you hold
the live reference, so `call` drives *any* method") transfers intact and arguably improves.

### The `Path` half DEGRADES

Name-based paths do not work. Measured:

- **`label` is a decoy.** 34 of 69 nodes on bubbo's title screen carry a label, and **all 34
  equal their class name** — because Pixi core sets them as constructor defaults
  (`Sprite.js` → `label: "Sprite"`, `Graphics.js` → `label: "Graphics"`). Real buttons have
  `label: null`. Surveys that grep for `.label =` in game source report "zero" and are right;
  the labels you see at runtime are Pixi's, and carry no identity.
- **`constructor.name` is dead in production** (`Z`×26, `I`×25, `_t`, `ke`, `zn`, `ia`, `or`)
  and already polluted in dev — Vite's deps optimizer renames Pixi's own classes to `_Sprite`,
  `_TilingSprite2`. Do not build addressing on it in either mode.
- The two existing Pixi inspectors dodge this entirely: the official devtools mints ephemeral
  ids (`${uid++}_${random}`, rebuilt each poll, dead across reload); pixi-inspector keys on the
  **node object itself**. Neither offers a stable string address.

### The addressing scheme

Anchor on the **semantic skeleton**, not on the root. Measured: a scene of 69 (title) to 400+
(gameplay) nodes contains only a **handful of game-class nodes**; everything else is bare Pixi
primitives. Detect an anchor by its **API fingerprint** — the stable intersection of the
official `AppScreen` convention (`create-pixi` templates and both open-games share it):

```
show, hide, resize          ← present on all three screens measured
prepare, update, pause, …   ← bonus signal only; NOT common to all
```

Then address **within** an anchor using the game's own field names, and fall back to a
structural type path only for unnamed interior nodes:

| Priority | Key | Minify-proof | Notes |
|---|---|---|---|
| 1 | game-set `label` | ✅ | **must exclude Pixi's constructor defaults** (`Sprite`/`Graphics`/`TilingSprite`) |
| 2 | anchor + game field name (`GameScreen:Node.pauseButton`) | ✅ | the game's own vocabulary; needs §9 nested members |
| 3 | descendant `Text` content (`"SHOOT BUBBLES!"`) | ✅ | it's data, not an identifier |
| 4 | `texture.label` / asset alias (`play-btn-up`, `icon-sound-on`) | ✅ | assetpack alias, survives intact |
| 5 | `pixiType(n)` + `[i]` structural path | ✅ | positional; last resort, and see §6 |

**Consequence for the lane:** Pixi is **`find`-first**, Cocos is **path-first**. Paths are an
*output* (for diffs and human reading), not the primary input. `find` is promoted from a
probe-bundle helper (`src/cocos/runtime.js:563`) to a first-class primitive. This is the first
real fracture in the copse↔coir shared grammar and belongs in `docs/SELECTORS.md` as such —
coir has no Pixi side, so nothing round-trips here anyway.

⚠️ **Boundary:** all of the above assumes the game is written as classes with state on
instances (true for both open-games, the official templates, and the hybrid Vue/Pixi game we
surveyed). A closure-based/functional Pixi app keeps its state unreachable — by any tool, not
just copse. Say so rather than degrading silently.

## 4. `press` and `reachable` FUSE ✅

Cocos `press` calls the handler directly, so `src/core/index.js:186-189` deliberately does
**not** gate on reachability. The correct Pixi implementation dispatches **real DOM
PointerEvents at the canvas** and lets the engine's own pipeline (including hit testing) run —
strictly more faithful than the Cocos path, but inherently reachability-gated. Document the
divergence; route `force:true` to a direct `emit` fallback and mark it (`drove:'emit-unsafe'`),
since `emit` skips propagation, hit testing, and EventBoundary state.

Verified end-to-end on the minified prod build: locate by descendant text → `hitTest` confirms
reachability → three-phase dispatch → **the game actually navigated from title screen into
gameplay**, and 24 synthetic shots moved the score `0 → 760 → 1,330 → 1,430 → 4,680`.

**The sequence, with every step load-bearing:**

```js
// 0. PRIME — hitTest THROWS cold: rootBoundary.rootTarget is null until the EventSystem has
//    processed one real DOM pointer event. Measured: "Cannot read properties of null
//    (reading 'eventMode')". One pointermove fixes it (rootTarget then === app.stage).
canvas.dispatchEvent(new PointerEvent('pointermove', {bubbles:true, clientX, clientY, pointerId:1, isPrimary:true, pointerType:'mouse'}));

// 1. node -> CSS px (inverse of the public mapPositionToPoint; round-trip verified exact at resolution 2)
const r = node.getBounds().rectangle, rect = canvas.getBoundingClientRect(), res = app.renderer.events.resolution;
const clientX = rect.left + ((r.x + r.width/2) * res) * (rect.width / canvas.width);

// 2. reachability oracle — hitTest takes WORLD/global Pixi space, returns the Container that
//    would receive the event. Walk up its parent chain: target or a descendant of it = reachable.
boundary.hitTest(gx, gy)

// 3. dispatch — ALL THREE on app.canvas, same pointerId, pointerType:'mouse'
'pointerover' -> 'pointerdown' -> 'pointerup'
```

**Measured pitfalls, all confirmed except one:**

| Claim | Result |
|---|---|
| `pointerup` on `document`/`window` → no tap | ✅ **confirmed** — only `pointerdown` fires; `_onPointerUp` inspects `composedPath()[0]` and rewrites the event to `pointerupoutside` |
| mismatched `pointerId` (down=1, up=7) → no tap | ✅ **confirmed** — `pointerup` fires but **no `pointertap`/`click`** |
| bare `PointerEvent` defaults break tap synthesis | ❌ **refuted** — `pointertap` fires fine. But **`click` does NOT** without `pointerType:'mouse'`, and the real buttons measured listen for `click`/`mousedown`/`mouseover`, **not** pointer events. So `pointerType:'mouse'` is **mandatory in practice.** |

Two more, measured:

- **`eventMode:'static'` alone is not a button.** bubbo's full-screen background TilingSprite
  (1480×925) is `static` with **zero listeners**. `asButton` must require listeners, or every
  scene reports a screen-sized button.
- **Interactive nodes duplicate.** An `AudioButton` surfaced twice with an identical rect — the
  outer node carrying mouse listeners and a deep inner view carrying pointer ones (the
  `@pixi/ui` `Switcher`/inner-view shape). Collapse by rect+subtree, preferring the outermost.

Other constraints worth honoring: `rootBoundary.rootTarget` comes from
`renderer.lastObjectRendered`, so the scene must have rendered at least once and a
render-to-texture app will resolve the wrong root (the official devtools guards on exactly
this); `Graphics` often needs an explicit `hitArea`; synchronous back-to-back events hit-test
against stale transforms (pixijs#11321) — interleave a frame, as the sequence above does.

## 5. What Pixi loses

**`clickSurface` / `coverage` — the coir×copse join — does not apply.** It keys on
`(nodePath, method)` where `method` is Cocos's **editor-serialized** ClickEvent handler name
(`docs/COVERAGE.md`). Pixi has no serialized handlers, so every row would be `method:null` and
the four-bucket verdict collapses. This is missing information, not a missing implementation:
don't ship a degraded join, omit the tools for the Pixi engine.

Also note a positioning caveat that showed up in a real hybrid game: a Vue/DOM + Pixi app can
keep most of its interactive surface in the DOM, where `chrome-devtools-mcp` already reaches it.
copse's value there is the canvas remainder plus state access — not the whole app. Measure the
split before promising coverage.

## 6. `watch` / `diff` survive — and are the strongest part ✅

`snapshot` emits `label` for any node with a Label (`src/core/index.js:84`) and `diff` buckets
`labelChanged` separately from `appeared`/`disappeared` (`:325`). Map
`getComponent(n,'Label') → renderPipeId==='text' ? n : null` and `readProp → n.text`, and
**`snapshot` / `diff` / `labelChanged` / `watch` work with no core change at all.**

The risk was that a dynamic scene churns sibling indices until the diff is noise. Measured over
6 samples of live gameplay (transient `+10`/`+20` score popups spawning and dying):

| interval | keys | added | removed | changed |
|---|---|---|---|---|
| 1 | 21 | **16** | 0 | 1 |
| 2 | 19 | 0 | 2 | 9 |
| 3 | 5 | 0 | **14** | 1 |
| 4–6 | 5 | 0 | 0 | 0–1 |

Churn is real, but the watched node's key `stage/0/0/1/2/0/1/1` **stayed stable throughout** —
because spawn/despawn `addChild`s at the **tail** of a sibling list and doesn't shift earlier
indices. Structural keying is therefore usable in dynamic scenes. It breaks only when something
is **inserted before** a watched sibling. The transient nodes land in `appeared`/`disappeared`,
not `labelChanged`, so copse's existing bucketing already separates signal from churn; pair it
with the existing `relevant:true` filter (`:88`).

Two keying strategies were tried and **rejected**: nearest-anchor + relative depth (collapses to
2–3 ambiguous keys) and naive recursive field-name scanning (see §8).

Because this path needs neither button detection nor synthetic input, it is the **first thing to
land** — walk the tree, read `.text`, diff.

## 7. Ecosystem: detect, don't special-case

No Pixi UI/scene library has enough share to be a primary code path (weekly npm, 2026-07):
`pixi-viewport` 12.3% of `pixi.js`, `@pixi/react` 8.7%, `@pixi/ui` **2.1%**, `@pixi/layout`
0.8%. Detect via core properties; treat libraries as **optional enrichment only**:

- `node.__pixireact?.type` — pixi-react tags every instance; the most reliable framework
  fingerprint in the ecosystem. ⚠️ note pixi-react does **not** set `eventMode`, so detect its
  interactive nodes by the mapped handler prop, not `eventMode`.
- `node.onPress?.connect` + fields `button`/`onDown`/`onUp`/`onHover` — `@pixi/ui`
  `FancyButton`/`ButtonContainer`. ✅ **Measured present in both official games** and intact
  after minification, so its 2.1% understates game-segment usage. `FancyButton` also exposes a
  **`press()` method** — a free direct-invoke path for `force:true`.
- `node.layout !== null` — `@pixi/layout` (patches `Container.prototype` globally on import).

⚠️ **Trap:** `@pixi/ui`'s plain `Button` is **not a Container and is not in the scene graph**.
It only leaves `eventMode` + `cursor` on its view, indistinguishable from a hand-rolled button.
`instanceof` misses it by construction. Never make it the detection path.

## 8. Implementation traps (each one cost a spike)

**"Subtract Pixi's own surface" is the hard part of anchor detection**, and it was gotten wrong
three times in three different ways:

1. Subtracting only `Container.prototype` → `Graphics`' ~50 drawing methods (`fill`, `arc`,
   `drawCircle`, …) get reported as game API. Subtract **every** Pixi built-in's prototype chain.
2. Subtracting prototype chains but not **instance fields** → `_events`, `uid`, `_updateFlags`,
   `localTransform` drown out the real fields, and `_game` disappears. Subtract both.
3. Walking fields to find logic objects **without cycle detection** → Pixi's
   `ObservablePoint._observer` is a back-reference to the owning node, so the walk loops back
   and emits garbage (`_position._observer: "SPACE MACHINE" → 100`). Bound the depth and track
   visited objects.

These need unit tests in `src/pixi/`, because all three fail *silently* — they return plausible
data, not an error.

## 9. Required changes outside `src/pixi/`

1. ✅ **DONE — `src/core/bridge.js`.** The engine-neutral half of `install()` (`watch`,
   `wrapTarget`/`patch`, `hold`, `pm*`, `orient`, `traceVal`, and the whole api assembly) now lives
   in `makeBridge({rt, root, target, engine})`; `src/cocos/runtime.js` shrank 642 → 452 lines and
   its `install()` is a thin wrapper supplying the four-member `EnginePort`
   (`freeze`/`unfreeze`/`canFreeze`, `visualManifest`, `probe`, `version`). `framework.js` and
   `eval-cond.js` moved `src/cocos/` → `src/core/` (both were already engine-free; core must not
   import from an engine dir). Guard: 174/174 `node:test` green, typecheck unchanged (5
   pre-existing errors, none new), and the lite/probe bundles still tree-shake `bridge.js` out
   (verified: no `no-freeze-api`/`stoppedBy` markers in either).
2. ✅ **DONE — nested member paths**, solved in the ADAPTER rather than in core: `splitMember` still
   hands everything after the first `.` to `readProp`, and the Pixi `readProp`/`callMethod` walk the
   dotted segments themselves (`callMethod` binds `this` to the owner, not the root). So
   `GameScreen:Node._game.stats` works with core untouched, and the equivalent Cocos change stays
   optional rather than becoming a prerequisite.
3. ✅ **DONE — driver + CLI + MCP.** `connect(url, {engine:'pixi'})`, `copse … --engine pixi`, and the
   MCP `connect` tool's `engine` enum. The bundle is injected via `evaluateOnNewDocument` BEFORE
   `goto` (a post-load evaluate misses Pixi's one-shot init hook entirely) — which also means the hook
   re-arms itself across navigations, so `reload()` and the auto-reconnect path work for free. Attach
   mode can't pre-inject, so `bootInPage` still evaluates the bundle directly and falls back to
   `findPixi`'s ladder. `press` being async needed no change: `page.evaluate` already awaits a
   returned promise. `clickSurface`/`coverage` REFUSE with an explanation instead of returning `[]`
   (an empty join reads as "nothing is wired" — a false finding, not a degraded one), `anchors()` is
   exposed as its Pixi counterpart, `doctor` reports a `pixi` env field instead of `cc`, and
   `cp.engine` is surfaced so a caller branches without sniffing the page.

   **`connect({engine:'auto'})`** resolves the engine by probing the live page, and `doctor` defaults
   to it — you run doctor precisely when you don't know what's wrong, so demanding `--engine` up front
   defeats its purpose. Auto pre-injects the Pixi bundle unconditionally (detection can only happen
   after load, but the hook must be armed before it); on a Cocos page that bundle finds no Application,
   its bounded poll expires, and the Cocos bundle installs over it. That ~57kb of dead weight is why
   auto is opt-in for `connect()` rather than its default, and free for a one-shot diagnostic.
   `doctor` reports `engine` (null when nothing identified itself), `injected`, and a note naming both
   things it looked for — which is the most useful output it has for a page that won't run at all.

   Two crashes fixed on the way, both pre-existing and both hit by exactly that page: `connect` threw
   when `__copse` never installed, and the driver's explicit `window.copse.install(window.cc)` died
   destructuring `{Button} = undefined` on any page without `cc` — so a tree-shaken release build
   reported an opaque TypeError instead of "no engine here".

   `installed:false` is enforced at `ev()`, the single choke point every in-page read goes through, and
   throws a message naming both things copse looked for. An earlier version of this page claimed reads
   would "degrade, not throw" — they did neither; `window.__copse.snapshot` was simply undefined, so
   MCP `connect` died on `Cannot read properties of undefined` and never reported the diagnosis it had
   just computed. The MCP `connect` summary now returns that finding instead of a read error.

   `bundlePath` and `engine:'auto'` are refused together (one bundle cannot serve a two-engine probe),
   and every bundle a run might need is read BEFORE the browser launches — a throw after `launch()`
   unwinds past the only reference to `browser` and leaks a headless Chrome per failed invocation.

   **Limit worth stating plainly:** doctor probes the PAGE and reports `connectedAs` beside it, so a
   wrong-engine session is visible — but a Pixi app is only positively identifiable if copse was
   injected pre-boot or the game volunteers a global. A cocos-connected session on a Pixi game gets
   `engine:null` plus a note telling you to reconnect, never a false `cocos`.

   Verified against the live minified game: 12/12 driver-level assertions (incl. `reload()` re-capture
   and settle's auto-`changed`) and 10/10 through the real MCP JSON-RPC dispatcher (incl.
   `dump_script` recording a Pixi session). A Cocos regression over a fake-`cc` page covers the other
   side: 17/17, including the bridge-hoisted `patch`/`hold`/`watch` and `clickSurface` still working.

**Two core changes the implementation forced that this page did not predict:**

- **`rt.alwaysIndex`** (`segOf`, `src/core/index.js`). copse's `[i]` disambiguates SAME-NAME siblings,
  and on Pixi every "name" is a type — so a lone `Text` becomes `Text[0]` the instant a second Text
  spawns beside it, and a live `watch` reports one disappearance plus two appearances instead of one
  changed value. §6's churn measurement missed this because that spike keyed on raw positional paths,
  not copse's actual grammar. Emitting the index unconditionally keeps existing refs fixed; `resolve`
  already treats `Name` and `Name[0]` identically. Cocos leaves the flag unset.
- **`refOf` must honour the same flag** (`src/core/refpath.js`, now parameterized by a naming fn too).
  It is a deliberately separate implementation from `segOf`, and `reachable`'s `blockedBy`, visual
  baselines and `anchors()` all go through it — so when only one of the two honoured `alwaysIndex`,
  their refs silently diverged. Pinned by a test that walks a snapshot and asserts both agree.

**Do not** abstract a formal `EngineAdapter` interface yet. Build `src/pixi/` as a sibling of
`src/cocos/` first; abstract only once the seam has been proven by a real second engine,
otherwise the interface gets shaped around Cocos and Pixi won't fit it.

Testing mirrors the existing convention: fake-tree `node:test` for the pure parts, plus a
gitignored `reference/pixi/8.x` checkout for an L2 real-engine test (as `reference/cocos/` and
`test/real-engine.l2.test.js` already do).

## 10. Unverified / open

- **Positioning:** nothing published drives *and* queries a running Pixi app. Prior art is
  pixel-diffing (PixiJS's own visual tests, playwright-canvas), read-only scene sampling
  (`pixi-sampler`, ASE 2022 — explicitly no input), human inspectors (devtools, pixi-inspector),
  and one Cypress pattern that finds nodes but contains no click simulation. The model is proven
  elsewhere — Poco does exactly this for Unity/cocos2dx/Egret — but has **no web/canvas SDK**.
  ⚠️ inferred from search; treat as directional.
- **The AccessibilitySystem hijack.** Pixi 8 ships an `AccessibilitySystem` that renders a
  light-DOM overlay of accessible containers whose divs forward clicks back into Pixi
  (`_dispatchEvent(e, ['click','pointertap','tap'])`). Ecosystem adoption is zero, but it's
  opt-in per container — copse could set `accessible = true` on nodes it identifies and enable
  the system, making the game drivable by stock Playwright selectors and sidestepping §3
  entirely. ⚠️ **unvalidated, no prior art found.** It also mutates the game (a DOM overlay),
  which cuts against copse's non-invasive posture. Worth an hour's prototype; do not design
  around it.
- Pixi 7 is **out of scope** — `label`/`name`, `eventMode`/`interactive` and `getBounds()`'s
  return type all differ. Targeting v8 only is what removes the feature-probe ladder that
  `src/cocos/` needs for Cocos 2.x/3.x.

## Keep in sync

If the `Runtime` contract in `src/core/index.js` changes, update §2. If the Pixi addressing
scheme changes, update `docs/SELECTORS.md` too — §3 is a deliberate divergence from the
copse↔coir shared grammar and must be documented as such in both places.
