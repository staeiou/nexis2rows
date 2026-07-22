# Safari + plain-`http://` GitHub Pages: what broke and why

A postmortem of getting nexis2rows' PDF import working in **Safari 17.2** served over
**plain `http://`** (a GitHub Pages custom domain without enforced HTTPS). This was
the actual deployment target, not localhost and not HTTPS, which matters because it
changes which browser APIs are available.

## TL;DR of the real fixes

| Problem | Root cause | Fix |
| --- | --- | --- |
| PDF import throws `undefined is not a function` | Safari < 17.4 has no async iteration of `ReadableStream`; pdf.js `getTextContent` does `for await (const v of stream)` | Polyfill `ReadableStream.prototype[Symbol.asyncIterator]` (`src/polyfills.js`) |
| Worker crashes parsing on Safari 17.2 | pdf.js worker bundle uses `Promise.withResolvers` (Safari < 17.4) and the main-thread polyfill never reaches the worker realm | Dedicated worker entry (`src/pdf-worker.js`) imports `polyfills.js` *before* the pdf.js worker |
| UI hangs ~1 min with no progress | We had moved parsing onto the main thread, which blocks repaint (froze HTTPS too) | Parse in a real Web Worker via `GlobalWorkerOptions.workerPort` |
| CI ("gh worker") can't build | `build` script called `node scripts/strip-pdf-worker-sourcemap.mjs`, but `scripts/` was never committed | Drop the strip step; `build` is plain `vite build` |

## Background: secure contexts

A page is a *secure context* only over **HTTPS** or on **`localhost`/`127.0.0.1`**.
A plain `http://` page on a LAN IP, a hostname, or a custom domain is **not** secure.
In a non-secure context Safari (correctly, per spec) disables:

- `navigator.serviceWorker` -> `undefined`
- `crypto.subtle` -> `undefined`

These are **not bugs you can fix** — they're browser rules. The app must degrade
without them. Chrome is more lenient, which is why "works for me / broken in Safari"
kept happening. Handled in the app:

- `sha256()` falls back to a non-crypto FNV-1a hash when `crypto.subtle` is absent.
- Service-worker registration is guarded by `"serviceWorker" in navigator`.

Note: `crypto.subtle`/`serviceWorker` being gone over `http://` was a **red herring**
for the import failure. The import bug below reproduces on HTTPS too.

## The actual import bug (the one that mattered)

Symptom: app loads fine, but importing a PDF fails. The error was swallowed by a
`catch` that only rendered `error.message`, surfacing as page text:

```
Import error
undefined is not a function (near '...e of t...')
```

`'...e of t...'` is a **minified** `for ... of`, so it could have been anywhere.

### How we found it (the move that ended the guessing)

1. Made the `catch` blocks render the full `name + message + stack` and
   `console.error` the raw error (`describeError` in `src/main.js`).
2. Temporarily built **unminified with sourcemaps** (`vite.config.js`) so the stack
   named real functions instead of `e of t`. (Reverted after.)

That produced:

```
TypeError: undefined is not a function (near '...value of readableStream...')
  getTextContent@.../index-...js
```

### Root cause

pdf.js `PDFPageProxy.getTextContent` does:

```js
const readableStream = this.streamTextContent(params);
for await (const value of readableStream) { ... }
```

**Safari only added async iteration of `ReadableStream` in 17.4.** On 17.2,
`ReadableStream.prototype[Symbol.asyncIterator]` is `undefined`, so the `for await`
calls `undefined` -> throw. This runs on the **main thread** (the page-proxy side),
independent of whether parsing uses a worker — which is why every prior
worker/crypto/service-worker change left it untouched.

### Fix

Polyfill the async iterator in `src/polyfills.js` (a standard default-reader
wrapper), imported first so it's installed before pdf.js runs.

## The worker realm (Safari 17.2 + `Promise.withResolvers`)

pdf.js 5.6 calls `Promise.withResolvers` in **both** the main and worker bundles, but
the worker bundle never polyfills it. Safari shipped `Promise.withResolvers` in 17.4,
so on 17.2 the worker throws.

A polyfill on the main thread **cannot** reach a Web Worker — workers have their own
global realm. So the worker needs its own polyfill import. `src/pdf-worker.js`:

```js
import "./polyfills.js";                          // worker realm gets the polyfills
import "pdfjs-dist/legacy/build/pdf.worker.mjs";  // then pdf.js worker code
```

and `src/pdf.js` points pdf.js at it:

```js
const pdfWorker = new Worker(new URL("./pdf-worker.js", import.meta.url), { type: "module" });
pdfjsLib.GlobalWorkerOptions.workerPort = pdfWorker;
```

## What did NOT work (and why)

- **Adding a crypto fallback / service-worker guards.** Correct and necessary for
  `http://`, but unrelated to the import crash. Time spent here was misdirected
  because the swallowed error hid the real stack.
- **Polyfilling only the main thread.** Doesn't fix the worker — separate realm.
- **Moving pdf.js onto the main thread (drop the worker).** It *did* dodge the
  worker's `Promise.withResolvers` gap, but:
  - it did **not** fix the import crash (the `ReadableStream` bug is main-thread), and
  - it **froze the UI** for up to a minute with no progress, because parsing on the
    main thread blocks repaint — on HTTPS as well.
  Net: a regression. Reverted in favor of worker + injected polyfills.
- **Symptom-chasing commits without the stack.** The decisive step was surfacing the
  real error + an unminified build, not another speculative patch.

## What worked

1. **Parse in a Web Worker** -> UI stays responsive, per-page progress repaints.
2. **Inject `polyfills.js` into the worker realm** -> `Promise.withResolvers` on 17.2.
3. **Polyfill `ReadableStream` async iteration on the main thread** -> fixes the
   actual import crash; needed regardless of worker/secure-context.
4. **Keep `crypto.subtle` / service-worker fallbacks** -> required for plain `http://`.
5. **Plain `vite build`** -> no dependency on an uncommitted `scripts/` dir, so CI builds.

## Build / deploy gotcha (the "gh worker can't build")

`package.json` `build` called `node scripts/strip-pdf-worker-sourcemap.mjs`, but
`scripts/` was untracked (`?? scripts/`). It exists locally so `npm run build` works
on the dev machine; the CI runner checks out a tree without it and dies on a missing
module. With the worker handled by Vite there was no sourcemap to strip anyway, so the
step was dead. Reproduce the CI failure locally by hiding the dir before building:

```sh
mv scripts /tmp/_s && npm run build; mv /tmp/_s scripts
```

## Debugging checklist for "works in Chrome, breaks in Safari over http://"

1. Are `crypto.subtle` / `navigator.serviceWorker` `undefined`? -> non-secure context.
   Add fallbacks; don't try to "enable" them.
2. Is an error being swallowed? Render `error.stack`, `console.error` the raw object.
3. Can't read the minified frame? Build unminified + sourcemaps **temporarily**.
4. Crash in a `for await`? Suspect `ReadableStream` async iteration (Safari < 17.4).
5. Crash mentions `Promise.withResolvers`? Safari < 17.4; polyfill it — and remember
   **workers need their own polyfill import**.
6. UI frozen with no progress? You're doing heavy work on the main thread; move it to
   a worker.

## Safari version reference

- `Promise.withResolvers`: Safari **17.4**
- `ReadableStream` async iteration (`Symbol.asyncIterator`): Safari **17.4**
- `Promise.try`: Safari **18.2**
- Module workers (`new Worker(url, { type: "module" })`): Safari **15**

Target here is **17.2**, which is below the first three — hence the polyfills.
