# Architecture

## Overview

The Service Worker Generator produces two JavaScript artifacts that together replace Flutter's default bootstrap pipeline:

1. **sw.js** — Service Worker handling resource caching, versioning, and client notifications
2. **bootstrap.js** — Initialization pipeline with loading widget, CanvasKit loading, and Flutter engine startup

## Two-Artifact Model

### sw.js (Service Worker)

Runs in the ServiceWorkerGlobalScope. Responsibilities:

- **Install**: Pre-cache Core and Required resources into a temp cache
- **Activate**: Atomic swap from temp to content cache, diff against previous manifest, clean stale caches, `clients.claim()`
- **Fetch**: Cache-first for cached resources, network-first for `/` (index.html), pass-through for uncached
- **Messages**: Handle `skipWaiting`, `getVersion` commands
- **Notifications**: Send `sw-progress` messages to clients during resource operations

The SW receives its configuration (manifest, version, cache prefix) via placeholder injection at generation time.

### bootstrap.js (Bootstrap Pipeline)

Runs in the main window context. Loaded via:
```html
<script defer id="bootstrap" src="bootstrap.js"
  data-config='{"logo":"icons/Icon-192.png","title":"My App"}'></script>
```

Pipeline stages:
1. **Init (1%)** — Environment check, browser capability detection
2. **SW Registration (2%)** — Register sw.js, handle updates, timeout with fallback
3. **CanvasKit Download (20%)** — CDN-first with local fallback
4. **Assets Download (80%)** — main.dart.js/wasm + required assets
5. **Dart Entry (90%)** — Flutter engine init + runApp
6. **Dart Init (90-100%)** — Dart manages remaining progress via `window.Bootstrap`

## TS → Dart Integration Pipeline

```
TypeScript Source (packages/sw/src/)
        │
        ▼
   Vite Build (IIFE, minified, single-file)
        │
        ▼
packages/sw/dist/{sw.js, bootstrap.js}
        │
        ▼
scripts/copy-assets.mjs (embeds JS as Dart raw string constants)
        │
        ▼
lib/src/assets/{sw_template.dart, bootstrap_template.dart}
        │
        ▼
Dart CLI (replaces __INJECT_*__ placeholders with actual config)
        │
        ▼
User's build/web/{sw.js, bootstrap.js} (final output)
```

## Resource Categories

| Category | Pre-cached | Cached on Fetch | Description |
|----------|-----------|-----------------|-------------|
| Core | Yes (install) | — | Essential for app startup: main.dart.* |
| Required | Yes (install) | — | Needed early: AssetManifest, FontManifest, PWA manifest |
| Optional | No | Yes (lazy) | CanvasKit variants, small images, JSON, fonts < 64KB |
| Ignore | No | No | Large assets, source maps, debug files |

### Default Categorization Rules

**Core:**
- `main.dart.js`, `main.dart.wasm`, `main.dart.mjs`
- `*.support.wasm`

**Required:**
- `assets/AssetManifest*.json`
- `assets/FontManifest.json`
- `manifest.json`

**Optional:**
- CanvasKit variant files for the selected renderer (lazy — CDN-first)
- `.json`, `.webp`, `.ttf`, `.woff2`, `.png`, `.jpeg` files under 64KB

**Ignore:**
- `*.map`, `*.symbols`, `assets/NOTICES`
- `sw.js`, `bootstrap.js`, `index.html`
- `flutter_bootstrap.js`, `flutter_service_worker.js`, `flutter.js`
- `version.json`
- Files larger than the optional size threshold

Users can override categorization via CLI args or YAML config using glob patterns.

## Caching Strategy

### Cache Naming
- `{prefix}-{version}` — Content cache (versioned)
- `{prefix}-temp-{version}` — Temporary cache during install (atomic swap)
- `{prefix}-manifest` — Previous manifest storage (unversioned)

### Cache Busting
All cached resources use `?v={hash}` query parameters to prevent stale responses.

### Never Cached
- `bootstrap.js` — Must always be fresh to pick up new configs
- `index.html` — Must always be fresh
- `sw.js` — Browser handles SW updates via its own mechanism

> These three files also require `Cache-Control: no-cache` at the HTTP layer. See [Server Configuration](../README.md#server-configuration) for the required headers.

## CanvasKit Loading

### Variant Selection

The renderer and variant are determined from Flutter's `buildConfig`:

| Renderer | Browser Capabilities | Variant |
|----------|---------------------|---------|
| canvaskit | chromium + imageCodecs + breakIterators | `chromium/canvaskit` |
| canvaskit | other browsers | `canvaskit` (full) |
| skwasm | no imageCodecs or no breakIterators | `skwasm_heavy` |
| skwasm | enableWimp or single-threaded | `wimp` |
| skwasm | default | `skwasm` |

### Loading Strategy
1. Try Google CDN: `https://www.gstatic.com/flutter-canvaskit/{engineRevision}/{variant}.js`
2. On failure (timeout, network error): fall back to local `canvaskit/` directory
3. Only download the variant files needed — not the entire canvaskit directory

### Extracting engineRevision
The Dart CLI parses `flutter_bootstrap.js` from the build directory to extract `engineRevision` from the `_flutter.buildConfig` object.

## Configuration Priority

1. CLI arguments (highest priority)
2. YAML config file (`sw.yaml`)
3. Environment variables
4. Built-in defaults (lowest priority)

## Global API

```typescript
interface BootstrapAPI {
  dispose(): void;
  progress: { phase: string; percent: number; message: string };
  subscribe(cb: (state: ProgressState) => void): () => void;
}

// Usage from Dart via JS interop:
// window.Bootstrap.dispose()
```
