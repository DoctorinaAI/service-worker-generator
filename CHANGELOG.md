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
