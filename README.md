# Service Worker Generator

[![Checkout](https://github.com/DoctorinaAI/service-worker-generator/actions/workflows/checkout.yml/badge.svg)](https://github.com/DoctorinaAI/service-worker-generator/actions/workflows/checkout.yml)
[![Pub Package](https://img.shields.io/pub/v/sw.svg)](https://pub.dev/packages/sw)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Dart](https://img.shields.io/badge/Dart-%230175C2.svg?style=flat&logo=dart&logoColor=white)](https://dart.dev)
[![Flutter](https://img.shields.io/badge/Flutter-%2302569B.svg?style=flat&logo=Flutter&logoColor=white)](https://flutter.dev)

A command-line tool for generating **Service Worker** files for web applications. Designed for **Dart** and **Flutter Web** applications, it creates service workers with intelligent resource caching, retry logic, and automatic version injection.

## Features

- **Automatic File Scanning** — Analyzes build directory and creates resource map with MD5 hashes
- **Smart Caching Strategy** — Cache-first for assets, online-first for index.html
- **Version Management** — Cache versioning for safe deployments and updates
- **Version Injection** — Replaces `{{sw_version}}` placeholder in `index.html` with the cache version
- **Fetch Retry & Timeout** — Retries failed fetches (2 retries, 500ms delay) with 10s timeout per request
- **Install/Activate Timeouts** — 30s timeout protection prevents stuck service worker updates
- **Navigation Preload** — Enables navigation preload for faster online-first responses (Chromium)
- **Stale Cache Cleanup** — Automatically removes all old caches with matching prefix on activation
- **Flexible File Filtering** — Include/exclude files using glob patterns
- **Flutter Web Optimized** — Pre-caches WASM, JS, and asset manifests as CORE resources
- **Cross-Platform** — Works on Windows, macOS, and Linux
- **Progress Notifications** — Sends `sw-progress` messages to clients during install, activate, and fetch
- **Offline Support** — Full offline capability with `downloadOffline` command
- **PWA Ready** — Progressive Web Application compatible

## Installation

```shell
dart pub global activate sw
```

## Usage

```shell
dart run sw:generate --help
```

### Full Example (Flutter Web)

```shell
# 1. Build Flutter web
flutter build web --release --wasm --no-web-resources-cdn --base-href=/ -o build/web

# 2. Remove Flutter's deprecated service worker files
rm -rf build/web/flutter_service_worker.js build/web/flutter_bootstrap.js build/web/flutter.js

# 3. Generate service worker (also replaces {{sw_version}} in index.html)
dart run sw:generate \
    --input=build/web \
    --output=sw.js \
    --prefix=my-app \
    --glob="**.{html,js,wasm,json}; assets/**; canvaskit/**; icons/**" \
    --no-glob="sw.js; flutter_service_worker.js; **/*.map; assets/NOTICES" \
    --comments
```

After step 3, the generator:

1. Creates `sw.js` with the resource manifest and caching logic
2. Finds `index.html` and replaces `{{sw_version}}` with the cache version timestamp

## Command Line Options

| Option       | Short | Description                                    | Default           |
| ------------ | ----- | ---------------------------------------------- | ----------------- |
| `--help`     | `-h`  | Show help information                          | -                 |
| `--input`    | `-i`  | Path to build directory containing index.html  | `build/web`       |
| `--output`   | `-o`  | Output service worker filename                 | `sw.js`           |
| `--prefix`   | `-p`  | Cache name prefix                              | `app-cache`       |
| `--version`  | `-v`  | Cache version                                  | current timestamp |
| `--glob`     | `-g`  | Glob patterns to include files (`;` separated) | `**`              |
| `--no-glob`  | `-e`  | Glob patterns to exclude files (`;` separated) | -                 |
| `--comments` | `-c`  | Include comments in generated file             | `false`           |

## Generated Service Worker

### Caching Strategies

| Resource           | Strategy     | Description                                     |
| ------------------ | ------------ | ----------------------------------------------- |
| `index.html` (`/`) | Online-first | Network with navigation preload, cache fallback |
| CORE assets        | Pre-cached   | Cached during install (WASM, JS, manifests)     |
| Other assets       | Cache-first  | Serve from cache, fetch on miss                 |

### CORE Resources (Pre-cached on Install)

These files are pre-cached during the service worker install event:

- `main.dart.wasm` — Flutter WASM binary
- `main.dart.js` — Compiled Dart JavaScript
- `main.dart.mjs` — ES modules variant
- `index.html` — Application shell
- `assets/AssetManifest.bin.json` — Flutter asset registry
- `assets/FontManifest.json` — Font definitions

### Resilience Features

- **Fetch timeout**: 10s per request (prevents hanging connections)
- **Fetch retry**: 2 retries with 500ms delay between attempts
- **Install timeout**: 30s (fails fast if pre-caching hangs)
- **Activate timeout**: 30s (cleans slate and claims clients on timeout)
- **Navigation preload**: Enabled on supporting browsers for faster navigation
- **Error recovery**: Always calls `self.clients.claim()` even on errors, preventing stuck pages

### Client Notifications

The service worker sends `sw-progress` messages to all clients during resource operations:

```javascript
{
  type: 'sw-progress',
  timestamp: 1749123456789,
  resourcesSize: 5242880,     // Total size of all resources
  resourceName: 'main.dart.js',
  resourceUrl: 'https://example.com/main.dart.js',
  resourceKey: 'main.dart.js',
  resourceSize: 1048576,      // Size of this resource
  loaded: 1048576,            // Bytes loaded so far
  status: 'completed'         // 'loading' | 'completed' | 'updated' | 'cached' | 'error'
}
```

### Message Commands

Send messages to the service worker to trigger actions:

| Message             | Action                                        |
| ------------------- | --------------------------------------------- |
| `'skipWaiting'`     | Immediately activate a waiting service worker |
| `'downloadOffline'` | Pre-cache all resources for offline usage     |

## index.html Integration

Use `{{sw_version}}` as a placeholder in your `index.html`. The generator replaces it automatically:

```html
<script>
  const swVersion = "{{sw_version}}";
  if (swVersion && !swVersion.includes("{{")) {
    navigator.serviceWorker.register(`sw.js?v=${swVersion}`);
  }
</script>
```

This replaces Flutter's deprecated `{{flutter_service_worker_version}}` placeholder, which is no longer reliable in Flutter 3.22+.

## Contributing

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Make** your changes and add tests
4. **Ensure** all tests pass (`dart test`)
5. **Commit** your changes (`git commit -m 'Add amazing feature'`)
6. **Push** to the branch (`git push origin feature/amazing-feature`)
7. **Create** a Pull Request

To use from local path:

```shell
dart pub global activate --source path .
```

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
