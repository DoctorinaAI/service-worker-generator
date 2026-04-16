# Service Worker Generator

[![Checkout](https://github.com/AeroFlutter/service-worker-generator/actions/workflows/checkout.yml/badge.svg)](https://github.com/AeroFlutter/service-worker-generator/actions/workflows/checkout.yml)
[![Pub Package](https://img.shields.io/pub/v/sw.svg)](https://pub.dev/packages/sw)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Dart](https://img.shields.io/badge/Dart-%230175C2.svg?style=flat&logo=dart&logoColor=white)](https://dart.dev)
[![Flutter](https://img.shields.io/badge/Flutter-%2302569B.svg?style=flat&logo=Flutter&logoColor=white)](https://flutter.dev)

A complete **Flutter Web bootstrap replacement** that generates an optimized Service Worker and Bootstrap pipeline. Replaces Flutter's default `flutter_bootstrap.js` with a professional loading experience featuring progress tracking, intelligent caching, CanvasKit CDN loading, and a customizable loading widget.

## Features

- **Full Bootstrap Replacement** — Replaces Flutter's `flutter_bootstrap.js` with a controlled initialization pipeline
- **Loading Widget** — Responsive circular progress indicator with status text, stall detection, and error handling
- **CanvasKit CDN Loading** — Loads CanvasKit from Google CDN with automatic local fallback
- **Smart Resource Categorization** — Core, Required, Optional, and Ignore categories with configurable caching strategies
- **Automatic File Scanning** — Analyzes build directory and creates resource manifest with MD5 hashes
- **Cache Busting** — Hash-based query params prevent stale cached resources
- **Retry with Backoff** — Exponential backoff retry (3 attempts, 1s/2s/4s delays) with 10s timeout per request
- **Progress Notifications** — Real-time `sw-progress` messages from Service Worker to loading widget
- **Version Management** — Cache versioning with atomic updates for safe deployments
- **Stall Detection** — Shows "Reset Cache" button after 30s without progress
- **Console Logging** — Styled version banner and progress logging in browser console
- **Global API** — `window.Bootstrap` for Dart integration (dispose, progress, subscribe)
- **Flexible Configuration** — CLI args, YAML config file, and environment variables (priority: CLI > YAML > env)
- **Cross-Platform** — Works on Windows, macOS, and Linux

## Requirements

- **Dart SDK**: >= 3.11.0
- **Flutter**: >= 3.41.0

## Installation

```shell
dart pub global activate sw
```

Or add as a dev dependency:

```yaml
dev_dependencies:
  sw: ^1.0.0
```

## Quick Start

```shell
# 1. Build your Flutter web app
flutter build web --release --wasm --base-href=/ -o build/web

# 2. Generate service worker and bootstrap
dart run sw:generate --input=build/web --prefix=my-app
```

The generator produces two files in your build directory:

- **`sw.js`** — Service Worker with resource manifest and caching logic
- **`bootstrap.js`** — Initialization pipeline with loading widget

And automatically:
- Extracts `engineRevision` and build config from Flutter's output
- Categorizes all files (Core/Required/Optional/Ignore)
- Removes Flutter's deprecated files (`flutter_bootstrap.js`, `flutter_service_worker.js`, `version.json`)
- Removes `.js.map` and `.js.symbols` files (unless `--keep-maps`)
- Replaces `{{sw_version}}` placeholders in `index.html`

## index.html Setup

Replace Flutter's default `index.html` content with a single script tag:

```html
<!DOCTYPE html>
<html>
<head>
  <base href="/">
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#25D366">
  <link rel="manifest" href="manifest.json">
  <link rel="icon" type="image/png" href="favicon.png">
  <title>My App</title>
</head>
<body>
  <script defer id="bootstrap" src="bootstrap.js"
    data-config='{
      "logo": "icons/Icon-192.png",
      "title": "My App",
      "theme": "auto",
      "color": "#25D366"
    }'></script>
</body>
</html>
```

The loading widget, progress tracking, service worker registration, and Flutter initialization are all handled by `bootstrap.js` automatically.

### Bootstrap Configuration (data-config)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `logo` | string | — | Path to logo image for the loading widget |
| `title` | string | — | Title text displayed below the logo |
| `theme` | string | `"auto"` | Widget theme: `"light"`, `"dark"`, or `"auto"` |
| `color` | string | `"#25D366"` | Accent color for the progress ring |
| `showPercentage` | boolean | `true` | Show numeric percentage below status text |
| `minProgress` | number | `0` | Minimum progress value for the bootstrap range |
| `maxProgress` | number | `90` | Maximum progress value (Dart manages the rest) |

## Command Line Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--help` | `-h` | Show help information | — |
| `--input` | `-i` | Path to Flutter build directory | `build/web` |
| `--output` | `-o` | Output service worker filename | `sw.js` |
| `--bootstrap-output` | | Output bootstrap filename | `bootstrap.js` |
| `--prefix` | `-p` | Cache name prefix | `app-cache` |
| `--version` | `-v` | Cache version | current timestamp |
| `--glob` | `-g` | Include glob patterns (`;` separated) | `**` |
| `--no-glob` | `-e` | Exclude glob patterns (`;` separated) | — |
| `--core` | | Core category glob overrides | — |
| `--required` | | Required category glob overrides | — |
| `--optional` | | Optional category glob overrides | — |
| `--ignore` | | Ignore category glob overrides | — |
| `--keep-maps` | | Keep `.js.map` files | `false` |
| `--no-cleanup` | | Skip Flutter file cleanup | `false` |
| `--config` | | Path to YAML config file | `sw.yaml` |
| `--theme` | | Loading widget theme | `auto` |
| `--logo` | | Loading widget logo path | — |
| `--title` | | Loading widget title | — |
| `--color` | | Loading widget accent color | `#25D366` |
| `--min-progress` | | Minimum progress value | `0` |
| `--max-progress` | | Maximum progress value | `90` |

### YAML Configuration

Create an `sw.yaml` file in your project root as an alternative to CLI args:

```yaml
input: build/web
output: sw.js
prefix: my-app
theme: dark
logo: icons/Icon-192.png
title: My App
color: "#25D366"
glob: "**.{html,js,wasm,json}; assets/**; canvaskit/**; icons/**"
no-glob: "sw.js; bootstrap.js; **/*.map; assets/NOTICES"
```

Priority: CLI arguments > YAML config > environment variables > defaults.

### Environment Variables

| Variable | Maps to |
|----------|---------|
| `SW_INPUT` | `--input` |
| `SW_OUTPUT` | `--output` |
| `SW_PREFIX` | `--prefix` |
| `SW_VERSION` | `--version` |
| `SW_THEME` | `--theme` |
| `SW_LOGO` | `--logo` |
| `SW_TITLE` | `--title` |
| `SW_COLOR` | `--color` |

## Bootstrap Pipeline

The bootstrap replaces Flutter's initialization with a controlled 6-stage pipeline:

| Stage | Progress | Description |
|-------|----------|-------------|
| Init | 0% → 1% | Environment check, browser capability detection |
| Service Worker | 1% → 2% | Register `sw.js`, unregister old Flutter SW, timeout fallback |
| CanvasKit | 2% → 20% | Load from Google CDN, fall back to local `canvaskit/` |
| Assets | 20% → 80% | Load `main.dart.js`/`.wasm` via Flutter's loader |
| Dart Entry | 80% → 90% | Initialize Flutter engine and run app |
| Dart Init | 90% → 100% | Dart application manages remaining progress |

### Loading Widget

The loading widget provides visual feedback during initialization:

- **Circular SVG progress ring** with configurable accent color
- **Logo image** and **title text** (configurable)
- **Status text** showing current operation
- **Percentage display** (optional)
- **Stall detection** — after 30 seconds without progress, shows a "Reset Cache" button
- **Error display** — shows error message with reset option on failure
- **Responsive design** — adapts to mobile screens
- **Theme support** — light, dark, or auto (follows `prefers-color-scheme`)

### CanvasKit Loading

The bootstrap automatically determines the correct CanvasKit variant:

1. Extracts `engineRevision` from Flutter's build config
2. Detects browser capabilities (ImageDecoder, Intl.Segmenter, WebGL, WasmGC)
3. Selects the appropriate variant (canvaskit, chromium, skwasm, skwasm_heavy, wimp)
4. Tries Google CDN: `https://www.gstatic.com/flutter-canvaskit/{engineRevision}/{variant}.js`
5. Falls back to local `canvaskit/` directory on failure

## Global API (window.Bootstrap)

The bootstrap exposes a global API for Dart integration via JS interop:

```dart
// In your Dart code:
import 'dart:js_interop';

@JS('Bootstrap.dispose')
external void bootstrapDispose();

@JS('Bootstrap.progress')
external JSObject get bootstrapProgress;
```

| Method | Description |
|--------|-------------|
| `Bootstrap.dispose()` | Remove loading widget, clean up listeners |
| `Bootstrap.progress` | Current state: `{ phase, percent, message }` |
| `Bootstrap.subscribe(callback)` | Subscribe to progress changes, returns unsubscribe function |

Alternatively, the loading widget auto-disposes on the `flutter-first-frame` event.

## Resource Categories

Files are automatically categorized based on their path and size:

| Category | Pre-cached | On Fetch | Description |
|----------|-----------|----------|-------------|
| **Core** | Install | Cache-first | Essential: canvaskit variant, `main.dart.js`/`.wasm`/`.mjs`, `*.support.wasm` |
| **Required** | Install | Cache-first | Early-needed: `AssetManifest*.json`, `FontManifest.json` |
| **Optional** | — | Cache on first fetch | Lightweight files: `.json`, `.webp`, `.ttf`, `.png`, `.jpeg` under 64KB |
| **Ignore** | — | Pass-through | Not cached: `*.map`, `*.symbols`, `NOTICES`, large assets |

Override categorization with glob patterns via CLI or YAML config:

```shell
dart run sw:generate \
  --input=build/web \
  --core="assets/critical/**" \
  --ignore="assets/video/**"
```

### Never Cached

These files are always fetched fresh (never stored in the SW cache):
- `bootstrap.js` — must reflect latest build config
- `index.html` — must be fresh for updates
- `sw.js` — browser handles SW updates natively

## Service Worker

### Caching Strategies

| Resource | Strategy | Details |
|----------|----------|---------|
| `index.html` (`/`) | Network-first | Fresh from network, cache fallback for offline |
| Core + Required | Pre-cached | Cached during SW install with cache-busted URLs |
| Optional | Lazy cache | Cached on first fetch for repeat visits |
| Ignore | Pass-through | Not cached, always from network |

### Cache Management

- **Atomic updates** — New resources cached in temp cache, then swapped atomically on activate
- **Manifest diff** — Previous manifest compared to detect changed resources (by MD5 hash)
- **Stale cleanup** — Old versioned caches automatically deleted on activate
- **Error recovery** — On activate error, all caches cleared (clean slate), `clients.claim()` always called

### Resilience

- **Fetch timeout**: 10s per request via AbortController
- **Fetch retry**: 3 attempts with exponential backoff (1s → 2s → 4s + jitter)
- **SW registration timeout**: 4s, continues without SW on timeout
- **Error recovery**: Always calls `self.clients.claim()` even on errors

### Client Notifications

The service worker sends `sw-progress` messages during resource operations:

```javascript
{
  type: 'sw-progress',
  timestamp: 1749123456789,
  resourcesSize: 5242880,
  resourceName: 'main.dart.js',
  resourceUrl: 'https://example.com/main.dart.js',
  resourceKey: 'main.dart.js',
  resourceSize: 1048576,
  loaded: 1048576,
  status: 'completed' // 'loading' | 'completed' | 'updated' | 'cached' | 'error'
}
```

### Message Commands

| Message | Action |
|---------|--------|
| `'skipWaiting'` | Immediately activate a waiting service worker |
| `{ type: 'getVersion' }` | Respond with current SW version |

## Architecture

This is a TypeScript + Dart monorepo:

```
packages/sw/     # TypeScript source (Vite → minified IIFE)
├── src/sw/      # Service Worker modules
├── src/bootstrap/ # Bootstrap pipeline + loading widget
└── src/shared/  # Shared types, constants, utilities

lib/             # Dart CLI
├── src/assets/  # Compiled JS embedded as Dart string constants
├── src/         # Config, manifest, categorizer, injector, cleanup
└── sw.dart      # Barrel export

bin/generate.dart  # CLI entry point
```

Users install only the Dart package — no Node.js required. The TypeScript source is pre-compiled and shipped as Dart string constants.

## Contributing

### Prerequisites

- **Dart SDK** >= 3.11.0
- **Node.js** >= 18 (for TypeScript development only)
- **Flutter** >= 3.41.0 (for example app)

### Setup

```shell
# Clone the repository
git clone https://github.com/AeroFlutter/service-worker-generator.git
cd service-worker-generator

# Install dependencies
dart pub get
npm install

# Build TypeScript
npm run build

# Run tests
dart test
npm test
```

### Development Workflow

```shell
# Watch TypeScript changes
npm run dev

# Build TypeScript + copy to Dart string constants
npm run build:all

# Verify committed assets are up to date
npm run verify

# Run the generator on the example app
dart run sw:generate --input=example/build/web --no-cleanup

# Format Dart code
dart format -l 80 lib/ bin/ test/
```

### Project Structure

| Directory | Purpose |
|-----------|---------|
| `packages/sw/` | TypeScript source for SW and Bootstrap |
| `lib/src/` | Dart CLI modules |
| `bin/` | CLI entry point |
| `scripts/` | Build scripts (copy-assets, verify-assets) |
| `docs/` | Architecture documentation |
| `example/` | Flutter Web example app |
| `test/` | Dart tests |

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
