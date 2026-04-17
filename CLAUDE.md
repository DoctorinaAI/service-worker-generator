# Service Worker Generator

## Project Overview

A CLI tool (`sw`) for generating optimized Service Worker and Bootstrap scripts for Flutter Web applications. Replaces Flutter's default bootstrap pipeline with a professional loading experience featuring progress tracking, intelligent caching, and CanvasKit CDN loading with local fallback.

## Monorepo Structure

```
Root (= Dart package published to pub.dev as `sw`)
├── packages/sw/          # TypeScript source (Vite + Rolldown)
│   ├── src/shared/       # Types, constants shared between sw and bootstrap
│   ├── src/sw/           # Service Worker source
│   ├── src/bootstrap/    # Bootstrap + Loading Widget source
│   └── dist/             # Compiled JS output (gitignored)
├── lib/                  # Dart library
│   └── src/
│       ├── assets/       # Auto-generated JS templates as Dart string constants
│       ├── config.dart   # Configuration (CLI args > YAML > env)
│       ├── flutter_build.dart  # Parse engineRevision, buildConfig from Flutter output
│       ├── categorizer.dart    # File categorization (Core/Required/Optional/Ignore)
│       ├── manifest.dart       # Resource manifest generation with MD5 hashes
│       ├── injector.dart       # Placeholder replacement in JS templates
│       ├── cleanup.dart        # Remove Flutter files, update index.html
│       └── generator.dart      # Main orchestrator
├── bin/generate.dart     # CLI entry point
├── scripts/              # Build scripts (copy-assets.mjs, verify-assets.mjs)
├── docs/                 # Architecture documentation
├── example/              # Flutter Web example app
└── test/                 # Dart tests
```

## Build Commands

### TypeScript (packages/sw/)
```bash
npm install                    # Install TS dependencies
npm run build                  # Build sw.js + bootstrap.js via Vite
npm run build:all              # Build TS + copy to Dart string constants
npm -w packages/sw run test    # Run Vitest tests
npm -w packages/sw run check   # TypeScript type check
```

### Dart (root)
```bash
dart pub get                   # Install Dart dependencies
dart analyze                   # Run Dart analyzer
dart test                      # Run Dart tests
dart run sw:generate --help    # Show CLI help
dart run sw:generate --input=build/web  # Generate sw.js + bootstrap.js
```

### Full Pipeline
```bash
flutter build web --release --wasm -o build/web
dart run sw:generate --input=build/web
# Serve build/web/ with any HTTP server
```

## Architecture

### Two Artifacts
1. **sw.js** — Service Worker with resource manifest, cache strategies per category
2. **bootstrap.js** — Full initialization pipeline replacing flutter_bootstrap.js

### TS → Dart Integration
- Vite compiles TypeScript → `packages/sw/dist/{sw,bootstrap}.js`
- `scripts/copy-assets.mjs` embeds compiled JS into `lib/src/assets/*_template.dart` as raw string constants
- Dart CLI replaces `"__INJECT_SW_CONFIG__"` and `"__INJECT_BOOTSTRAP_CONFIG__"` placeholders with actual config/manifest
- Users don't need Node.js — prebuilt templates ship with the pub package

### Resource Categories
- **Core**: main.dart.js/wasm/mjs, *.support.wasm
- **Required**: AssetManifest*.json, FontManifest.json, manifest.json
- **Optional**: canvaskit variant files (CDN-first, lazy local fallback), lightweight files (.json, .webp, .ttf, .png, .jpeg < 64KB)
- **Ignore**: *.map, *.symbols, NOTICES, sw.js, bootstrap.js, index.html

### Caching Strategy
- Core + Required: pre-cached on SW install
- Optional: cached lazily on first fetch
- Ignore: not cached
- bootstrap.js, index.html, sw.js: never cached by SW (always fresh)

## Coding Conventions

### Dart
- SDK: >=3.11.0
- Line length: 80 characters
- Strict analysis: strict-casts, strict-raw-types, strict-inference
- Public API docs required
- Format on save

### TypeScript
- Target: ES2022
- Strict mode enabled
- No runtime dependencies (pure browser code)
- IIFE output format via Vite

## Documentation

- `docs/architecture.md` — Two-artifact model, TS→Dart pipeline, categories, caching, CanvasKit loading
- `docs/bootstrap-pipeline.md` — Pipeline stages, loading widget, global API, data-config options
- `docs/service-worker.md` — Manifest format, cache strategies, events, retry logic, client notifications
- `docs/configuration.md` — CLI args, YAML config, env vars, default categorization rules

## Key Files Reference
- `packages/sw/src/shared/types.ts` — Shared type definitions (ResourceCategory, ResourceManifest, etc.)
- `packages/sw/src/sw/index.ts` — Service Worker entry point
- `packages/sw/src/bootstrap/index.ts` — Bootstrap entry point
- `packages/sw/src/bootstrap/loading-widget.ts` — Loading widget (SVG progress, stall detection, themes)
- `packages/sw/src/bootstrap/pipeline.ts` — Pipeline orchestrator (6 stages)
- `packages/sw/src/bootstrap/canvaskit-loader.ts` — CanvasKit CDN/local loading, variant detection
- `lib/src/generator.dart` — Dart CLI main orchestrator
- `lib/src/config.dart` — Configuration parsing (CLI > YAML > env)
- `lib/src/flutter_build.dart` — Extract engineRevision from Flutter build output
- `lib/src/categorizer.dart` — File categorization (Core/Required/Optional/Ignore)
- `lib/src/injector.dart` — Placeholder replacement in JS templates
- `lib/src/files.dart` — File scanning utilities (filesInDirectory, md5, pathToUrl)
- `scripts/copy-assets.mjs` — Copy compiled JS into Dart string constants
- `example/build/web/flutter_bootstrap.js` — Reference Flutter build output with buildConfig and engineRevision
