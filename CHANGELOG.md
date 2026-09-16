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
