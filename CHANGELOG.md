## Unreleased

### Fixed

- **Bootstrap**: `flutter build web --no-web-resources-cdn` was ignored. Flutter records that choice as `"useLocalCanvasKit": true` in `_flutter.buildConfig`, but the generator dropped it, and the bootstrap probed `gstatic.com` on every load and then loaded the engine from the CDN whenever it answered. The probe is a `cache: "no-store"` request, so it cost a network round trip on every load, returning visitors included, before the engine download could start, and up to two 8 s timeouts where `gstatic.com` is blocked or slow. The bundled `canvaskit/` files the app chose to serve were never used, so the service worker never cached them either. The generator now passes `useLocalCanvasKit` through to the bootstrap config (only when true), and `loadCanvasKit` goes straight to the local directory for such builds; the variant in use is cached lazily on first load like any other `Optional` file. Builds without the flag behave as before. The generator's summary also reports which source the bootstrap will use. (`lib/src/flutter_build.dart`, `lib/src/injector.dart`, `lib/src/generator.dart`, `packages/sw/src/bootstrap/canvaskit-loader.ts`, `packages/sw/src/bootstrap/pipeline.ts`, `packages/sw/src/shared/types.ts`)
- **Generator**: cleanup pruned `canvaskit/chromium/canvaskit.js` while keeping its `.wasm`. `getCanvasKitVariant` loads that pair on Chromium-class browsers with the `canvaskit` renderer; the missing half went unnoticed while the engine came from the CDN, but a `--no-web-resources-cdn` build loads it locally, where hosts with an SPA rewrite answer the missing script with `index.html` and the app never starts. The keep-set now lists both files. (`lib/src/generator.dart`)

- **Service Worker**: files whose names contain a space or a non-ASCII character were never served from the cache. The manifest is keyed by the name on disk (`assets/my photo.png`), but the worker looked requests up by the percent-encoded URL path (`assets/my%20photo.png`). Core and Required files like that were precached and then fetched from the network anyway; Optional ones were never cached. Keys are now decoded with `decodeURI`, which leaves an escaped `/` escaped. (`packages/sw/src/shared/utils.ts`)
- **Service Worker**: an HTML page answering a request for a script, wasm, image or JSON file was cached under that file's name. A host with an SPA rewrite (Firebase, Netlify, `try_files … /index.html`) answers a file the deploy lacks with the app shell and status 200, and cache-first then served it as that file until the next deploy. Precache now fails such an entry (for a Core file that fails the install, which is retried on the next load), and the lazy cache skips it. HTML files themselves are unaffected. (`packages/sw/src/sw/cache-manager.ts`, `packages/sw/src/shared/utils.ts`)
- **Bootstrap**: recovering from a foreign service worker (the transition from Flutter's own) awaited `getRegistrations()` and `unregister()` with no deadline, before the pipeline's own budget applies. Those wait on the per-scope job queue that a stuck install wedges, so the page could hang before the loading widget appeared. The cleanup is now bounded by `RESET_TIMEOUT_MS` (3 s) and the reload is unconditional. (`packages/sw/src/bootstrap/sw-registration.ts`)
- **Bootstrap**: `Bootstrap.applyUpdate()` could hang forever when the waiting worker turned redundant instead of activating, since `controllerchange` then never fires. It now resolves `false` after `SW_BOOTSTRAP_TIMEOUT_MS` (10 s) and leaves the page as it is. (`packages/sw/src/bootstrap/sw-registration.ts`)
- **Bootstrap**: the `flutter-first-frame` listener that dismisses the loading widget was added only after the app loader resolved, so a first frame dispatched earlier left the widget up until Dart removed it. It is now registered before the app loads. (`packages/sw/src/bootstrap/pipeline.ts`)
- **Generator**: `keep-maps`, `no-cleanup` and `comments` in `sw.yaml` were ignored, although `docs/configuration.md` documents them: the flags were read from the command line only. They now follow the same CLI > YAML > env precedence as every other option, with `SW_KEEP_MAPS`, `SW_NO_CLEANUP` and `SW_COMMENTS` as the environment variables. An invalid value exits with status 64, like an invalid number. (`lib/src/config.dart`)
- **Generator**: cleanup deleted `flutter_bootstrap.js` even when `index.html` still loaded it, which happens when the step that swaps in an `index.html` loading `bootstrap.js` is skipped, and the deployed page was blank. The file is now kept in that case, with a warning that the page will not use `bootstrap.js` or the service worker. (`lib/src/cleanup.dart`)
- **Generator**: `bootstrap.js` carried `flutter.js`'s `//# sourceMappingURL=flutter.js.map`, which points at a map that is not deployed. The comment is stripped, and a `;` now separates the loader from the bootstrap IIFE. (`lib/src/generator.dart`)
- **Docs**: `docs/configuration.md` referred to a nonexistent `--exclude` flag (it is `--no-glob`) and gave the version default as a timestamp (it is a hash of the manifest).

- **Bootstrap**: the first load after a deploy ran the previous build's Dart code on the new build's engine. The previous worker still controls that page and serves its cached `main.dart.*`, while `index.html` and `bootstrap.js` come from the new build and the bootstrap loads CanvasKit or skwasm for the new engine revision. On the same engine that mix works, but after a Flutter upgrade it fails in the engine (`WebAssembly.instantiate(): Import #N`). The worker now reports its build's `engineRevision` in its `getVersion` reply, and the bootstrap asks the controller for it. On the same engine the page boots with it at once, without the 4 s activation wait it used to spend for nothing; the new worker takes over on the next load. On a different engine, or an unknown one (workers from earlier releases don't report it, so the first load after upgrading waits once), the bootstrap waits up to `SW_UPDATE_INSTALL_TIMEOUT_MS` (60 s) for the new worker to install, hands control to it before any app file is requested, and reloads once if the handover is lost. A failed install leaves the page on its current controller, as before. (`packages/sw/src/bootstrap/sw-registration.ts`, `packages/sw/src/bootstrap/pipeline.ts`, `packages/sw/src/sw/message-handler.ts`, `packages/sw/src/sw/index.ts`, `lib/src/injector.dart`, `lib/src/generator.dart`)

- **Service Worker**: activating one version deleted the temp cache of a version still installing beside it, which happens when the bootstrap hands control to a waiting worker while a newer deploy installs. That version then activated with an empty content cache. Cleanup now keeps the temp caches of the registration's installing and waiting workers; an abandoned install's leftovers still go. (`packages/sw/src/sw/activate-handler.ts`, `packages/sw/src/sw/cache-manager.ts`)
- **Service Worker**: any failure during activate, including `navigationPreload.enable()` after a successful swap, deleted every cache whose name started with the prefix: this version's fresh content cache, a pending install's temp cache, and the caches of another app with a longer prefix. Swap, cleanup and navigation preload are now contained separately; a failed swap drops only this version's own caches, so it starts over from the network. Cache names are matched on a `-` boundary, so prefix `app-cache` no longer claims `app-cache2-…`. It still claims `app-cache-admin-…`: apps sharing an origin need prefixes that are distinct and not one another's start followed by `-`, now stated in the docs. (`packages/sw/src/sw/activate-handler.ts`, `packages/sw/src/sw/cache-manager.ts`)
- **Service Worker**: under a `<base href>` with a space or a non-ASCII character (`/my%20app/`), no key was re-based onto the scope, because request paths are now decoded and the scope was not. Every manifest lookup missed, the `__/` pass-through stopped matching (`/my%20app/__/auth/handler` reached the app-shell branch), and activate deleted the freshly swapped Core and Required files whose hash changed. The scope path is decoded the same way. (`packages/sw/src/shared/utils.ts`)
- **Bootstrap**: the version in `sw.js?v=` was not encoded, so a `--version` such as `1.0.0+3` read back as `1.0.0 3` in the worker, and activate deleted the temp cache of that pending version; `&` or `#` cut the version short. It is now encoded with `encodeURIComponent`; the default hash versions are unchanged. (`packages/sw/src/bootstrap/sw-registration.ts`)
- **Bootstrap**: on an engine change the bootstrap reloaded a page that was already on the new worker, when another tab handed control over meanwhile or the `controllerchange` landed just after the 4 s handover timeout. It now checks the controller before reloading. (`packages/sw/src/bootstrap/sw-registration.ts`)
- **Generator**: the `;` between `flutter.js` and the bootstrap landed inside a trailing line comment of `flutter.js`, should a release end it with one other than the stripped source-map comment; it now goes on a line of its own. (`lib/src/generator.dart`)
- **Generator**: cleanup kept `flutter_bootstrap.js` and warned that the page would not use the service worker for a commented-out script tag, a `data-src` attribute, or a file merely ending in that name (`my_flutter_bootstrap.js`, `flutter_bootstrap.json`). (`lib/src/cleanup.dart`)
- **CI**: the check that nothing secret reaches pub.dev ran on the setup action's sparse checkout, which lacks `.pubignore`, and before the tests create `coverage/` and `reports/`; the dry run itself failed on the missing LICENSE, and `|| true` hid it. It now runs last, on the whole tree, and fails when the dry run fails. (`.github/workflows/checkout.yml`)
- **Docs**: the `--version` default (a hash of the manifest, not a timestamp), CanvasKit listed as Core (it is Optional), `index.html` missing from Required, the full list of environment variables, `engineRevision` in `SWConfig`, and `--comments`, which is accepted but has no effect yet.
- **Docs**: the README promised a "pre-cached shell for offline". The app cannot start offline: the shell loads `bootstrap.js`, which is never cached so that shell, bootstrap and worker always come from one deploy. The docs now say so, and say why it stays that way.

Audit findings from #30:

- **Service Worker**: a body cut short in transit (a chunked response closed early, a truncating proxy) was cached and then served cache-first until the next deploy, breaking the app for that user only. Pre-cached and lazily cached bodies are now counted against the manifest's `size` while they stream into the cache (nothing is buffered), and a mismatch stores nothing; the log names the key and both sizes. `index.html` is exempt. Hosts that change files are allowed for: an uncompressed response that declares a different `Content-Length` and delivers all of it is a re-encoded file (image optimisation, an injected snippet) and is checked against that length, with a warning; without the header, precache fetches the entry once more and stores it when the length repeats or the body is longer than the build's, and fails it when the length changes or falls short of its own `Content-Length`. (`packages/sw/src/shared/utils.ts`, `packages/sw/src/sw/cache-manager.ts`)
- **Service Worker**: a `Range` request (media seeking) was answered from the cache with the whole file, and a `206` slice could be cached as the whole file. Range requests now go to the network, and only a plain `200` is cached lazily. (`packages/sw/src/sw/fetch-handler.ts`, `packages/sw/src/sw/cache-manager.ts`)
- **Service Worker**: a transient `503` or `429` for a Core file failed the install. Precache and the refill of a missing Core or Required entry retry `5xx` and `429`, honouring a numeric `Retry-After` capped at 5 s; a `4xx` is final, and navigations are unchanged. The refill now fetches the hash-busted URL with `cache: 'reload'`, so it cannot be answered by a stale HTTP cache entry, and falls back once to the page's own request. (`packages/sw/src/shared/utils.ts`, `packages/sw/src/sw/fetch-handler.ts`)
- **Service Worker**: an abandoned install (tab closed mid-precache, a waiting worker superseded by a newer deploy) left its full temp cache behind until some later activate. Each install now removes temp caches of its prefix that no installing, waiting or active worker of the registration owns, and keeps all of them when the waiting worker's version cannot be read. A `QuotaExceededError` is logged with the storage estimate. (`packages/sw/src/sw/install-handler.ts`, `packages/sw/src/sw/cache-manager.ts`, `packages/sw/src/sw/quota.ts`)
- **Bootstrap**: an engine loaded from the CDN passed a one-byte probe of its `.js`, which says nothing about the `.wasm`; a proxy that blocks the `.wasm` left the app on an error. A failure of the app on a CDN engine now pins the tab session to the local engine and reloads once (only when `sessionStorage` can record that, so it cannot loop); a missing `_flutter.loader`, which no engine fixes, is shown at once. A failed CDN probe is remembered for the session, so later loads skip up to two 8 s timeouts. (`packages/sw/src/bootstrap/canvaskit-loader.ts`, `packages/sw/src/bootstrap/pipeline.ts`, `packages/sw/src/bootstrap/flutter-loader.ts`)
- **Bootstrap**: a failure in `initializeEngine()` never reached the pipeline, because flutter.js does not await `onEntrypointLoaded`, so the splash stayed up with no error; and a loading widget that failed to mount threw out of the pipeline, so the app never started. Both are handled now. (`packages/sw/src/bootstrap/flutter-loader.ts`, `packages/sw/src/bootstrap/pipeline.ts`, `packages/sw/src/bootstrap/api.ts`)
- **Bootstrap**: the reset button deleted every cache on the origin, including other apps'. It now deletes only caches named `{prefix}-…` for this build's prefix (passed in the bootstrap config as `cachePrefix`); without one it deletes all, as before. (`packages/sw/src/bootstrap/loading-widget.ts`, `lib/src/injector.dart`)
- **Bootstrap**: loading widget fixes: the icon is built without `innerHTML` (Trusted Types), the `<style>` carries the page's CSP nonce, a bubbling child `transitionend` no longer removes the widget early, `pointer-events` is restored to its original value, the progress ring is an ARIA `progressbar`, the status is a polite live region (an alert on error) that is not rewritten with the same text, long status lines wrap, and reduced motion turns off every animation. (`packages/sw/src/bootstrap/loading-widget.ts`, `packages/sw/src/bootstrap/config.ts`)
- **Generator**: running it twice over the same output failed with `flutter_bootstrap.js not found`; it now says the build was already processed and to re-run `flutter build web`. Unknown keys in `sw.yaml` (with a suggestion), keys with no value, a missing explicit `--config`, an unknown `theme`, a non-hex `color`, a progress value outside 0..100, `min-progress` above `max-progress`, an unknown renderer, symlinks in the build, and `*.part.js` files left in Ignore now print a warning; none of them changes the output. (`lib/src/config.dart`, `lib/src/generator.dart`, `lib/src/files.dart`)
- **Generator**: ignored files were hashed for nothing, and every hash read the whole file into memory; MD5 is now streamed and computed for manifest entries only. Hashes and the default version are unchanged. An output name with a directory (`--output=js/sw.js`) creates it, and canvaskit pruning no longer follows symlinks. (`lib/src/manifest.dart`, `lib/src/files.dart`, `lib/src/generator.dart`, `lib/src/cleanup.dart`)
- **Docs**: the README advised long-lived caching for files other than `sw.js`, `bootstrap.js` and `index.html`. Flutter's file names carry no hash, so `main.dart.js` cached for a year outlives a deploy; the examples now send `no-cache` for everything (the worker still serves Core and Required files from its own cache). A section on `application/wasm` and cross-origin isolation was added.
- **CI**: the publish workflow only checked the embedded assets before publishing; it now also type-checks and tests the TypeScript and analyzes and tests the Dart package, with read-only permissions for that job. (`.github/workflows/deploy.yml`)

- **Bootstrap**: a load that found a newer worker waiting could stall for 4s before the app started. `activateWaitingAtBootstrap` posts `skipWaiting`, and activation stops the old worker; a request the page makes at that moment (the browser's favicon fetch, a logo, the web manifest) is still dispatched to the old worker, which restarts it, and Chromium then keeps the new worker waiting for as long as the page is open. Re-sending `skipWaiting` does not help. The bootstrap waited the full `SW_REGISTRATION_TIMEOUT_MS` (4s) for a `controllerchange` that could not come, and then booted with the old controller, or on an engine change reloaded once. The handover is now bounded by `SW_HANDOFF_TIMEOUT_MS` (500ms; a handover that works lands in milliseconds), so a lost one costs that instead; the outcome is unchanged. A first visit with a waiting worker and no controller still waits for activation after it. (`packages/sw/src/bootstrap/sw-registration.ts`, `packages/sw/src/shared/constants.ts`)

### Changed

- **Generator**: a command-line usage error (unknown option, missing or disallowed value) exits with status 64 (`EX_USAGE`) and prints `Error:` with a `--help` hint, instead of status 1 with a stack trace. A broken input directory prints `Error:` and exits 1 without a stack trace.

### Tests

- Vitest, 62 more (370): keys under a percent-encoded scope; the version round trip through `sw.js?v=`; no reload when the page is already on the new worker; activate with a failing cleanup, a waiting worker and an unparsable pending URL; fetch with an unusable CacheStorage; settle with blocked storage, foreign replies, a throwing `postMessage` and bounded waits; the `window.Bootstrap` API, `applyUpdate`, engine detection, the bootstrap entry point. Line coverage of `packages/sw/src` is now 99%, except `sw/index.ts`, which only runs once the Dart injector has filled in its config.
- Dart, 34 more (135 without the integration tests): the CLI in a child process (exit codes 0, 1 and 64, env vs CLI vs YAML), every flag from YAML, script tags that do and do not load `flutter_bootstrap.js`, the generator's failure modes, skwasm keep-set, injection round trip of quotes, `</script>`, `$&` and U+2028.
- Vitest: activate keeps the temp cache of a worker installing beside it and drops an abandoned one; keeps the swapped content cache when navigation preload fails; on a failed swap drops only its own caches; `cleanupOldCaches` keeps pending versions' temp caches and does not claim a longer prefix. Each fails without the fix.
- Playwright: `engine-update.spec.ts` deploys the example twice over a local host, with a marker in `main.dart.js`. When the engine changed, the first load after the second deploy runs the new build's code; it ran the old build's without the fix. On the same engine it boots with the old build at once and reaches the new one on a later load.
- Vitest: `settleUpdateAtBootstrap` boots at once on the same engine; waits for the install and hands over on a different engine, on a worker that does not report its engine, and on one that does not answer; stays on the current worker when the install fails or runs out of time; reloads once when the handover is lost and not again; skips a second handover when one already failed. `registerServiceWorker` no longer waits for a worker that cannot activate on a controlled page; the pipeline stops when the page reloads; `getVersion` reports the engine revision.
- Dart: `injectSWConfig` carries the engine revision only when the build has one.
- Vitest: `getResourceKey` decodes percent-escapes, keeps an escaped `/` and a malformed escape as sent; a file with a space in its name is served from the cache; precache fails a Core entry answered with HTML but still precaches `index.html`; the lazy cache skips an HTML fallback; the foreign-controller recovery reloads when `unregister()` never settles; `activateWaitingSW` resolves `false` when the controller never changes; a first frame dispatched while the app loader is still running dismisses the widget. Each fails without its fix.
- Dart: YAML sets `keep-maps`, `no-cleanup` and `comments`, and the CLI wins over YAML in both directions; cleanup keeps `flutter_bootstrap.js` while `index.html` loads it and removes it once it loads `bootstrap.js`; `bootstrap.js` embeds `flutter.js` without its source-map comment.
- Vitest: `loadCanvasKit` returns the local path without any fetch when `useLocalCanvasKit` is set; the pipeline passes `useLocalCanvasKit` to it, and `false` when the config omits it. All three fail without the fix.
- Dart: `extractFlutterBuildInfo` reads `useLocalCanvasKit` and defaults it to `false`; `injectBootstrapConfig` emits it only when true; the integration build checks that `bootstrap.js` carries whatever the example's `flutter_bootstrap.js` recorded, so it holds for builds with and without `--no-web-resources-cdn`.
- Dart: `generate()` over a synthetic canvaskit build keeps both files of the standard and Chromium variants and prunes a file no variant uses; it fails without the keep-set fix.
- Playwright: the suite passes (17) against the example built both with and without `--no-web-resources-cdn`. With the local build and the keep-set unfixed, "page loads without errors" and the wedged-queue test fail on the missing `chromium/canvaskit.js`.
- Vitest (488) and Dart (175 without the integration tests, 14 integration) for #30. Each fix above has a test that fails without it, among them: a body short of the manifest size, of the same length twice, or longer; a re-encoded file declaring its own `Content-Length`; a second copy short of its own `Content-Length`; a mismatch logged when `cache.put` rejects with a generic error; Range pass-through; `5xx`/`429` retry and `Retry-After`; orphaned temp caches kept for installing, waiting and active workers; the CDN fallback reload, and none for a missing Flutter loader; a reset that keeps another prefix's caches; the CLI exit codes and warnings; streamed MD5 equal to the old digest.
- Playwright: the suite (19) passes on the regenerated example.
- Vitest: a lost handover on a controlled page resolves after `SW_HANDOFF_TIMEOUT_MS` and not before; an uncontrolled page still waits for activation after that bound; on an engine change the reload follows the bound, including when the install lands first and when the controller changes just after it. The handover tests that used `SW_REGISTRATION_TIMEOUT_MS` as the handover's timeout now use `SW_HANDOFF_TIMEOUT_MS`; five fail without the fix.

## 0.2.0 — 2026-09-16

### Fixed

- **Bootstrap**: the pipeline could wait on `navigator.serviceWorker.register()` forever, leaving the app stuck at `2% Registering service worker` — through reloads, through restarts, with no error and no way out. Service worker jobs are serialised per scope, so an install that never settles blocks every later `register()`, `unregister()` and `getRegistrations()` on the origin until the browser kills the install minutes later. The whole service-worker step is now bounded by `SW_BOOTSTRAP_TIMEOUT_MS` (10s) and the app boots uncached when it runs out; the abandoned registration is left running, so the worker still installs in the background once the browser frees the queue. The deadline covers the pre-registration cleanup too, which goes through the same queue. (`packages/sw/src/bootstrap/sw-registration.ts`, `packages/sw/src/shared/utils.ts`)
- **Service Worker**: a pre-cached response body that stalled mid-stream hung `install` indefinitely — the mechanism that wedges the queue above. `fetchWithRetry` bounds the headers only: its abort timer is cleared as soon as they arrive, after which `cache.put` reads a multi-megabyte body (`main.dart.js` is routinely ~10 MB) with no deadline at all. Bodies are now wrapped in an idle watchdog (`BODY_STALL_TIMEOUT_MS`, 30s) that cancels a stream which has stopped producing bytes. Measured against idle time, not total duration, so a slow-but-alive connection still finishes however long it takes; a genuinely dead stream fails one entry, and the install is retried on the next page load instead of blocking the origin. (`packages/sw/src/sw/cache-manager.ts`, `packages/sw/src/shared/utils.ts`)
- **Bootstrap**: the loading widget's reset button hung in exactly the situation it exists for. It awaited `unregister()` before reloading, and `unregister()` is one of the calls a wedged job queue never settles — so the button spun forever on the stalled screen the user clicked it to escape. Cleanup is now bounded by `RESET_TIMEOUT_MS` (3s) and the reload is unconditional. (`packages/sw/src/bootstrap/loading-widget.ts`)

### Changed

- **Bootstrap**: the reset button no longer clears `localStorage`/`sessionStorage`. On Flutter web `shared_preferences` is `localStorage`, so clearing it signs the user out and discards local app state — not something a reload button should do, and unrelated to a stuck cache. It still drops every cache, and it now clears only the one-shot foreign-controller guard key rather than all of session storage. (`packages/sw/src/bootstrap/loading-widget.ts`)
- **Bootstrap**: the reset button unregisters only the service worker this bootstrap registered, matched on path. Unregistering everything also took out workers at unrelated scopes — `firebase-messaging-sw.js` and its push subscription, for instance — which `reloadIfForeignController` has always been careful to spare. `LoadingWidget` takes the SW filename for this; constructed without one, it falls back to the previous behaviour. (`packages/sw/src/bootstrap/loading-widget.ts`, `packages/sw/src/bootstrap/pipeline.ts`)

### Tests

- Vitest: `registerServiceWorker` returns `null` and lets the pipeline continue when `register()` never settles, and when the pre-registration cleanup never settles. Both hang without the fix.
- Vitest: a `Core` entry whose body stalls fails the install instead of hanging it — asserted through a cache that actually consumes the body, since the shared mock only clones it.
- Vitest: the reset action reloads despite an `unregister()` that never settles, clears caches, spares unrelated registrations, leaves application storage alone, and re-arms the foreign-controller guard.
- Vitest: `withTimeout` resolution, fallback and rejection propagation; `guardBodyStall` pass-through rules, an intact slow stream, and a stalled one.
- Playwright: with the scope's job queue deliberately wedged by a worker whose install never settles, the app still reaches its first frame.

## 0.1.6-dev — 2026-09-02

### Fixed

- **Progress counter**: the loading overlay could print a count greater than its own total (`Loaded 5 of 4 resources`). The numerator and the denominator were computed from two different sets: `resourcesCount` covered the pre-cached set (`Core` + `Required`), while the client counted every resource the SW reported — including `Optional` files served lazily by the fetch handler, which is unbounded. Progress messages now carry `counted`, marking membership of the set `resourcesCount` describes, and the bootstrap only adds counted resources to the numerator. (`packages/sw/src/sw/progress.ts`, `packages/sw/src/bootstrap/pipeline.ts`)
- **Progress counter**: a page can be talked to by two workers at once — an old controller still serving fetches while a new build pre-caches in the background — and their manifests need not agree on a total. Messages now carry `swVersion`, and the bootstrap ignores any worker other than the one it was built against, so the denominator cannot change mid-load. (`packages/sw/src/sw/progress.ts`, `packages/sw/src/bootstrap/pipeline.ts`)
- **App shell**: `index.html` was categorised `ignore`, so it never reached the manifest. The fetch handler's `manifest['index.html']` lookups were consequently always empty: the shell was neither pre-cached nor reported as progress, and an offline navigation had nothing to fall back to on a cold profile. It is now `required` — pre-cached on install, counted, and stored under one canonical `index.html` cache key that both the precache and the navigation handler use. (`lib/src/categorizer.dart`, `packages/sw/src/sw/fetch-handler.ts`)
- **App shell**: navigations to SPA deep links (`/chat/42`) were dropped by the fetch handler. The manifest lookup ran first and returned early for any route without an entry of its own, so the `request.mode === 'navigate'` branch below it was unreachable for exactly the routes that need it. The navigation check now runs first. (`packages/sw/src/sw/fetch-handler.ts`)
- **App shell**: every same-origin navigation wrote its response into the app-shell cache slot. A page the host serves outside the SPA rewrite — Firebase Hosting's `/__/auth/handler` and `/__/auth/iframe` when `authDomain` is the app's own domain, a static legal page, a download — replaced the shell with its own HTML, after which any navigation that falls back to cache (offline, origin 5xx, a deep link the origin 404s) served that page instead of the app. Only `/` and `/index.html` may refresh the shell now, `__/*` is passed straight to the network (`RESERVED_PATH_PREFIXES`),, and a response that followed a redirect is stored only as a rebuilt copy with the flag dropped — browsers refuse to replay a redirected response for a navigation. (`packages/sw/src/sw/fetch-handler.ts`, `packages/sw/src/shared/constants.ts`)
- **App shell**: a failed cache write discarded a good page. `cache.put` sat inside the same `try` as the fetch, so quota pressure — routine for a wasm-sized app — turned a 200 from the origin into the stale cached copy, or into the literal `503 Offline` page on a profile with nothing cached yet. Cache writes and cache reads are now each contained, and nothing after a successful fetch can reject the response handed to `respondWith`. (`packages/sw/src/sw/fetch-handler.ts`)
- **Service Worker**: `progress.report` is best-effort. Its callers sit on the path that produces a `respondWith` response, so a failure to reach clients could surface as a failed navigation or a failed `main.dart.wasm`. (`packages/sw/src/sw/progress.ts`)
- **Generator**: making the shell a manifest entry exposed an ordering problem that was harmless while it was `ignore` — `cleanup` substitutes `{{sw_version}}` / `{{flutter_service_worker_version}}` into `index.html` *after* the manifest is hashed, so the recorded hash and size would have described a file the origin never serves. The generator now substitutes and re-hashes the entry itself. The version is still derived from the pre-substitution manifest, so it stays deterministic; note that the derived value does change relative to 0.1.5, because the shell is now part of the manifest it is derived from. (`lib/src/generator.dart`, `lib/src/cleanup.dart`)
- **Bootstrap**: a `bootstrap.js` and an `sw.js` from different builds (an HTTP-cached bootstrap without `Cache-Control: no-cache`) froze the counter silently, since no message ever passes the `swVersion` check. The mismatch is now reported — once, at teardown, and only when *every* message was foreign, so an ordinary update load (where the outgoing controller talks alongside the installing worker) stays quiet. (`packages/sw/src/bootstrap/pipeline.ts`)
- **Bootstrap**: `reloadIfForeignController` resolved the SW filename against `location.href` instead of the document base URL that `navigator.serviceWorker.register` actually uses. On any deep link it expected `/chat/sw.js`, judged the perfectly good `/sw.js` controller foreign, unregistered it and reloaded the page — once per tab session, on every deep link. (`packages/sw/src/bootstrap/sw-registration.ts`)

- **Service Worker**: resource keys are now relative to the worker's `registration.scope`. Keyed by absolute pathname, every manifest lookup missed under a non-root `<base href>` — and, worse, `RESERVED_PATH_PREFIXES` stopped matching, so an app served from `/app/` routed Firebase Auth's `/app/__/auth/*` navigations through the app-shell branch. `swapCaches` used the same normalisation and so could evict the shell it had just pre-cached. (`packages/sw/src/shared/utils.ts`, `packages/sw/src/sw/cache-manager.ts`)
- **Service Worker**: a same-origin navigation that the origin redirects is no longer answered with the app shell. A navigation carries redirect mode `manual`, so a 3xx arrives as an opaque redirect (`status` 0, `ok` false); it is now passed back untouched, which is what lets the browser follow it. (`packages/sw/src/sw/fetch-handler.ts`)
- **Service Worker**: the install-time pre-cache stores a replayable copy of the shell. It had no redirect guard at all — and on a cold profile it is the only writer of the shell — so a host that redirects `index.html?v=…` left a copy the browser refuses to serve for any later navigation. (`packages/sw/src/sw/cache-manager.ts`)
- **Service Worker**: `notifyIndex('updated')` is sent only when the shell was actually written, instead of announcing a refresh that quota pressure had just discarded. (`packages/sw/src/sw/fetch-handler.ts`)
- **Service Worker**: the pre-cache progress callback runs outside the block that attributes failures, so a throwing progress report can no longer be recorded as a failed resource — or, for a `Core` entry, fail the whole install over telemetry. (`packages/sw/src/sw/cache-manager.ts`)
- **Generator**: `--no-cleanup` leaves `index.html` alone again, including its version placeholders. Substituting under that flag both broke its contract and made the derived version depend on a file the same run had rewritten, so re-running the documented in-place dev loop shipped a new version for byte-identical content. (`lib/src/generator.dart`)

### Changed

- **Service Worker**: `cacheFirst` degrades to a plain network fetch when `CacheStorage` is unusable (evicted, blocked by a privacy mode) instead of failing the resource outright.
- **Protocol**: `SWProgressMessage` gains `swVersion` and `counted`. `resourcesSize` now describes the counted set rather than every cacheable resource, so it agrees with `resourcesCount`; consumers reading it as "total bytes on disk" should switch to summing the manifest. See [docs/service-worker.md](docs/service-worker.md#the-counted-set) for the two rules a client must follow.
- **Service Worker**: the startup banner reports `counted: N` (was `precache: N`) and its `size` is the total cacheable bytes, matching `resources: N` beside it.
- **Service Worker**: every `sw-progress` message is emitted through one reporter (`createProgressReporter`) instead of each handler assembling its own; the pre-cache and the counted set are now driven by the same `COUNTED_CATEGORIES` list and cannot drift apart.

### Tests

- Playwright: cold, warm and five-consecutive-cold loads assert that the numerator never leaves the counted set, reading the SW messages directly rather than the overlay text (which stops updating when the app takes over). On 0.1.5 the cold load counts 9 resources against a total of 6.
- Playwright: the app shell is pre-cached, answers an offline navigation, and answers a route the origin 404s.
- Playwright: visiting a same-origin page outside the SPA leaves the cached shell intact, and a deep link still gets the app afterwards. Both fail on the first cut of this fix.
- Vitest: host-reserved navigations are passed through; the shell is refreshed only from a request for the shell; a redirected response is not stored; a page the origin served is still returned when the cache write fails; precache and the fetch handler agree on the shell cache key.
- Vitest: `progress.ts` set membership and message shape; pipeline counter behaviour for foreign versions, uncounted resources and a fixed denominator.
- Vitest: an app served from a subpath keeps host-reserved paths reserved, treats its scope root as the shell request, and serves deep routes from the pre-cached shell.
- Vitest: a redirected shell is stored replayably by both writers; an opaque redirect is passed back rather than answered with the shell.
- Vitest: the counter clamp is reached — two builds reporting under one pinned `--version` — and the foreign-version report fires only when every message was foreign.
- Dart: `generate()` over a synthetic build directory pins the shell entry against the bytes on disk, version stability across in-place re-runs, and that the version still moves for any changed resource including the shell.
- Playwright: the counter specs wait for the worker to go quiet instead of sleeping on fixed timers, and the five-load spec installs its recorder once.

## 0.1.5 — 2026-04-22

### Changed

- **Example**: simplified the platform-specific update-check wiring with a conditional-import entrypoint and clarified the example update API contract for the user-approved refresh flow. (`example/lib/src/update/platform/update_check.dart`, `example/lib/src/update/platform/update_check_js.dart`, `example/lib/src/update/platform/update_check_vm.dart`, `example/lib/src/update/update_check_api.dart`)

## 0.1.4 — 2026-04-22

### Fixed

- **Bootstrap**: `WebAssembly.instantiate(): Import #N "X": module is not an object or function` failures on first load after a deploy. When an old SW kept controlling the page while a new SW installed in the background, any file missing from the old SW's manifest fell through to the network (fresh) while cached files stayed stale — so Flutter would load a fresh `main.dart.mjs` against a stale `main.dart.wasm` and the import schemas would disagree. Bootstrap now force-activates a pre-existing waiting worker at registration time via `{type:'skipWaiting'}` + `controllerchange`, so subsequent `fetch(main.dart.wasm)` / `import(main.dart.mjs)` go through the new SW with a coherent cache. Bounded by `SW_REGISTRATION_TIMEOUT_MS`; falls back to the old `waitForActivation` path on timeout. (`packages/sw/src/bootstrap/sw-registration.ts`)
- **Bootstrap**: pages controlled by a foreign SW at a different script path (e.g., an old `flutter_service_worker.js` left from a pre-migration deploy) can serve a similarly incoherent mix of files. Bootstrap now detects this pre-registration and performs a one-shot `location.reload()` after unregistering the offending registration. A `sessionStorage` guard prevents reload loops if the handoff doesn't take. (`packages/sw/src/bootstrap/sw-registration.ts`, `packages/sw/src/bootstrap/pipeline.ts`)

### Changed

- **Bootstrap**: foreign-controller cleanup is surgical — only the registration whose active worker equals the current `navigator.serviceWorker.controller` is unregistered. Unrelated registrations at other scopes (typically `firebase-messaging-sw.js` for push notifications) are left intact so their subscriptions survive the recovery. (`packages/sw/src/bootstrap/sw-registration.ts`)

### Scope note

- The pre-existing-waiting auto-activation is intentionally bootstrap-only: once the app is running, updates continue through the existing `sw-update-available` → `applyUpdate` user-approval flow, so running sessions are never yanked out from under the user.

## 0.1.3 — 2026-04-20

### Fixed

- **Bootstrap**: `Bootstrap.onUpdateAvailable` handlers were silently dropped on `flutter-first-frame` because `BootstrapAPI.dispose()` cleared the `updateHandlers` Set alongside the (correctly load-phase-scoped) progress `subscribers`. Update handlers are now retained for the lifetime of the page, so apps reliably receive the "new SW installed" signal after the loading widget disappears. (`packages/sw/src/bootstrap/api.ts`)
- **Bootstrap**: the `sw-update-available` DOM bridge listener installed by `runPipeline` was registered with `{ once: true }`, so a long-lived tab encountering a second deploy never notified handlers. The listener is now permanent for the page lifetime; `wireUpdateDetection` already dispatches at most once per SW install. (`packages/sw/src/bootstrap/pipeline.ts`)

### Changed

- **Bootstrap**: `BootstrapAPI.notifyUpdateAvailable` now routes async-handler rejections to `console.error` instead of leaving an "Uncaught (in promise)" warning that masks the real error. (`packages/sw/src/bootstrap/api.ts`)

## 0.1.2 — 2026-04-20

### Fixed

- **Bootstrap**: production deploys on hosts with SPA rewrites (Firebase Hosting, Netlify with `index.html` fallback, etc.) crashed at `_flutter.loader not available after loading flutter.js` because the server returned `index.html` for the bare `flutter.js` fetch. The bootstrap now inlines Flutter's `flutter.js` IIFE into `bootstrap.js` at generation time, so no runtime fetch of `flutter.js` is performed and the loader is available before the pipeline starts.

### Changed

- **Cleanup**: `version.json` is no longer deleted — it carries Flutter's app version metadata and may be read by the app or external tooling at runtime.
- **Cleanup**: `flutter.js` is now removed from the deployed output (its loader is inlined into `bootstrap.js`).
- **Docs**: README "CI step" snippet no longer recommends `rm -f build/web/flutter.js` manually — the generator handles it.

## 0.1.1 — 2026-04-20

### Added

- **Docs**: "Local Development" section in README.md covering the monorepo layout, TypeScript ↔ Dart build pipeline, and commands for running the generator against `example/build/web/`.

## 0.1.0 — 2026-04-20

Complete rewrite replacing Flutter's default bootstrap with a professional two-artifact system.

### Fixed (post-audit hardening)

- **Generator**: crash on short or empty `engineRevision` now surfaces a clear error before artifact generation.
- **CLI precedence**: `--flag` with an ArgParser default no longer shadows YAML / env values (`wasParsed` gate). Glob options (`--core`, `--required`, …) now honour `SW_CORE`, `SW_REQUIRED`, `SW_OPTIONAL`, `SW_IGNORE`, `SW_GLOB`, `SW_EXCLUDE_GLOB` environment variables that previously did nothing.
- **CLI**: invalid `--min-progress` / `--max-progress` values now fail with exit code 64 instead of silently defaulting to `0`/`90`.
- **Cleanup**: canvaskit pruning uses consistent URL-style paths, fixing a Windows case where `\`-separated paths never matched the keep-set.
- **SW `notifyClients`**: a single dead client no longer aborts iteration — every other client still receives the progress update.
- **SW `cacheFirst`**: non-OK responses (4xx/5xx) now emit an `error` progress event so the bootstrap UI can surface the failure instead of hanging on `loading`. Fallback 503s carry `Content-Type: text/plain`.
- **SW `swapCaches`**: reordered to copy-then-evict-then-persist-manifest, and eviction now excludes paths that were just re-precached from temp (no more accidental deletion of the fresh bytes).
- **SW `message-handler`**: accepts both `"skipWaiting"` strings and `{type: "skipWaiting"|"getVersion", requestId?}` objects; `getVersion` replies echo `requestId` for correlation.
- **Loading widget**: dispose adds a 600ms safety teardown, so the widget and its stylesheet don't leak when `transitionend` doesn't fire (reduced-motion, background tabs).
- **CanvasKit loader**: `detectWebGLVersion` releases its temporary canvas + GL context via `WEBGL_lose_context` instead of relying on GC.

### Added

- **Deterministic `version`**: when `--version` / `SW_VERSION` / YAML is absent, the generator derives a stable 12-char sha256 over the manifest contents. Re-running against an unchanged build now yields the same SW version.
- **Dart UI defaults → bootstrap**: `--logo`, `--title`, `--theme`, `--color`, `--min-progress`, `--max-progress` flags are baked into `bootstrap.js` as `BuildConfig.uiDefaults`. `data-config` still overrides at runtime.
- **Precache concurrency cap** (`PRECACHE_CONCURRENCY = 6`) so large manifests don't stampede the origin during install.
- **Manifest size warning**: generator emits a stderr warning when `sw.js` exceeds 10 MB.
- **Update prompt API**: `window.Bootstrap.onUpdateAvailable(handler)` and `window.Bootstrap.applyUpdate(reload=true)` let apps prompt for and apply a waiting SW upgrade. `sw-registration.ts` exports `activateWaitingSW(registration)` for lower-level use.
- **CI**: new `e2e` GitHub Actions job runs `flutter build web` + `dart run sw:generate` + Playwright on each PR; `SW_E2E_BROWSERS=all` opts into the Chromium/Firefox/WebKit matrix.
- **Tests**: `test/config_test.dart`, `test/files_test.dart`, and new injector cases covering `uiDefaults`. Removed the empty `test/unit_test.dart` placeholder.

### Original 0.1.0 feature set

### Breaking Changes

- CLI arguments updated: new options added, some defaults changed
- Generated output now produces **two files** (`sw.js` + `bootstrap.js`) instead of one
- Requires `<script defer data-sw-bootstrap src="bootstrap.js">` in `index.html`
- Old inline JS/CSS loading UI replaced by the built-in loading widget

### Added

- **Bootstrap pipeline** — 6-stage initialization replacing `flutter_bootstrap.js`
  - Stages: Init → SW Registration → CanvasKit → Assets → Dart Entry → Dart Init
- **Loading widget** — Responsive circular progress with SVG ring, stall detection, error display, dark/light/auto theme
- **CanvasKit CDN loading** — Automatic `engineRevision` extraction, Google CDN with local fallback
- **Resource categorization** — Core, Required, Optional, Ignore with glob-based overrides
- **Global API** — `window.Bootstrap.dispose()`, `.progress`, `.subscribe(cb)` for Dart integration
- **YAML config** — `sw.yaml` as alternative to CLI args (priority: CLI > YAML > env > defaults)
- **Exponential backoff** — 3 retry attempts with 1s/2s/4s delays and jitter
- **Cache busting** — Hash-based `?v={hash}` query params on all cached resources
- **Atomic cache updates** — Temp cache during install, swapped on activate
- **Console logging** — Styled version banner with engine revision, SW version, renderer info
- **Stall detection** — "Reset Cache" button after 30s without progress
- **Auto-cleanup** — Removes `flutter_bootstrap.js`, `flutter_service_worker.js`, `version.json`, `.js.map`, `.js.symbols`
- **TypeScript source** — SW and Bootstrap written in TypeScript, compiled via Vite to minified IIFE

### Changed

- Monorepo structure: `packages/sw/` (TypeScript) + root (Dart CLI)
- Service Worker rewritten in TypeScript with modular architecture
- Cache naming: `{prefix}-{version}` for content, `{prefix}-manifest` for manifest storage
- `bootstrap.js`, `index.html`, `sw.js` are never cached by the SW

### Removed

- Inline JS/CSS string templates in Dart (replaced by compiled TypeScript)
- `downloadOffline` command (simplified caching model)
- Navigation preload (replaced by simpler network-first for index.html)
- Comment stripping (Vite handles minification)

## 0.0.7

- Simplify service worker by removing retry logic and navigation preload.
- Replace `Promise.race` timeout wrappers with modern `AbortController`-based `fetchWithTimeout`.
- Remove unused constants (`MEDIA_EXT`, `NETWORK_ONLY`, `RETRY_DELAY`).
- Remove `INSTALL_TIMEOUT`, `ACTIVATE_TIMEOUT` wrappers from install/activate events.
- Streamline activate event handler by removing redundant `Promise.race` nesting.

## 0.0.6

- Add timeout protection for install (30s) and activate (30s) events.
- Add fetch timeout (10s) and retry logic (2 retries with 500ms delay).
- Add navigation preload support for online-first strategy.
- Clean up all stale caches with matching prefix on activation.
- Ensure `self.clients.claim()` is always called, even on error/timeout.
- Emit `sw-version.txt` alongside `sw.js` for CI version injection.

## 0.0.5

- Update index.html example to include more features.

## 0.0.4

- Improved service worker generation.

## 0.0.3

- Service worker generation now based on the flutter's `flutter_service_worker.js`.

## 0.0.2

- Proof of concept for service worker generation

## 0.0.1

- Initial release with basic functionality
