# Injecting copse into a running Cocos game

copse runs **inside the game's page**, where `cc` is live. You need to (1) get
`install(cc)` to run there, then (2) drive `window.__copse` from outside (or the
console). Three ways, lowest-friction first.

> Reaching `cc`: in a **dev / preview** Cocos 3.x WebGL build, `cc` is reachable
> (often `window.cc`, otherwise via the module system). A released build tree-shakes
> it away — keep copse to dev/preview. If `window.cc` is missing, find the engine's
> module export and pass it to `install(...)`.

> Build the bundle once: `npm run build` → `dist/copse.inject.js`. It's a single
> self-contained IIFE (no ESM) that exposes `globalThis.copse` and **auto-installs**
> `window.__copse` as soon as `cc` is live (it polls ~10s, so it's safe to inject
> before the engine boots). All three methods below just get that one file to run in
> the page.

## 1. DevTools console (manual, fastest to try)

Paste the contents of `dist/copse.inject.js`, then poke it — no `install` call needed,
it self-installs once `cc` is up:

```js
// paste dist/copse.inject.js first, then:
__copse.interactive();                    // see the pressable buttons
__copse.press('Canvas/ShopBtn');
__copse.get('Canvas/Score:Label.string'); // assert the result
// (need a non-window cc? call it yourself: copse.install(myCc))
```

## 2. Playwright (the real driver — no copse dep on Playwright)

`addInitScript` injects the bridge before the game boots; `page.evaluate` drives it.

```js
import { test, expect } from '@playwright/test';
import fs from 'node:fs';

// One self-contained bundle (npm run build) that auto-installs window.__copse
// once `cc` exists. addInitScript runs it before the game boots; it polls for cc.
const bridge = fs.readFileSync('./dist/copse.inject.js', 'utf8');

test('buy flow', async ({ page }) => {
  await page.addInitScript(bridge);
  await page.goto('http://localhost:7456/');            // Cocos preview URL
  await page.waitForFunction(() => !!window.__copse);

  const gold = () => page.evaluate(() => __copse.get('Canvas/Score:Label.string').value);
  expect(await gold()).toBe('100');

  await page.evaluate(() => __copse.press('Canvas/ShopBtn'));
  await page.evaluate(() => __copse.press('Canvas/BuyBtn'));
  expect(await gold()).toBe('70');                      // logical assertion, no pixels
});
```

## 3. Dev-build hook (always-on in dev)

Call `install(cc)` from a debug-only script the game loads in dev:

```ts
import { install } from 'copse';
import { director } from 'cc';
if (DEV) install(cc);   // exposes window.__copse for any external driver
```

---

## AI-driven loop (the point)

```
read git diff → "you changed ShopController.buy()"
__copse.interactive()                 → discover what's pressable now
__copse.press('Canvas/ShopBtn')       → drive the flow the diff touched
__copse.press('Canvas/BuyBtn')
__copse.get('Canvas/Score:Label.string')  → assert; LLM judges pass/fail
```

The Ai decides *what* to test from the diff + the live snapshot; copse gives it the
structured tree and the press/get/call primitives. No coordinates, no screenshots.
