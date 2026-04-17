## 0.1.0

Complete rewrite replacing Flutter's default bootstrap with a professional two-artifact system.

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
