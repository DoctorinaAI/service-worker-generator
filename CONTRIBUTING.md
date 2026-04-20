# Contributing

## Prerequisites

- **Dart SDK** >= 3.11.0
- **Node.js** >= 18.0.0
- **Flutter** >= 3.41.0 (for building the example app)

## Project Structure

This is a TypeScript + Dart monorepo:

| Directory | Language | Purpose |
|-----------|----------|---------|
| `packages/sw/` | TypeScript | Service Worker and Bootstrap source |
| `lib/`, `bin/` | Dart | CLI tool (published to pub.dev) |
| `scripts/` | Node.js | Build scripts for TS → Dart integration |
| `example/` | Flutter | Example Flutter Web application |
| `docs/` | Markdown | Architecture documentation |

## Setup

```shell
# Clone
git clone https://github.com/AeroFlutter/service-worker-generator.git
cd service-worker-generator

# Install all dependencies
dart pub get
npm install
```

## Development Workflow

### TypeScript (packages/sw/)

```shell
# Type check
npm run check

# Build sw.js + bootstrap.js
npm run build

# Build + copy to Dart string constants
npm run build:all

# Verify committed assets match compiled output
npm run verify

# Run tests
npm test

# Watch mode
npm run dev
```

### Dart (root)

```shell
# Analyze
dart analyze

# Format (80 char line limit)
dart format -l 80 lib/ bin/ test/

# Run tests
dart test

# Run generator on example build
dart run sw:generate --input=example/build/web --no-cleanup --prefix=example
```

### Full Pipeline Test

```shell
# Build the example Flutter app
cd example
flutter build web --release --no-web-resources-cdn --base-href=/ -o build/web
cd ..

# Generate SW + Bootstrap
dart run sw:generate --input=example/build/web --prefix=example

# Serve and test in browser
cd example/build/web
python3 -m http.server 8080
```

## How It Works

1. **TypeScript source** (`packages/sw/src/`) compiles via Vite into two minified IIFE files: `dist/sw.js` and `dist/bootstrap.js`
2. **`scripts/copy-assets.mjs`** embeds the compiled JS into Dart raw string constants in `lib/src/assets/`
3. **Dart CLI** reads these templates, replaces placeholder tokens (`__INJECT_SW_CONFIG__`, `__INJECT_BOOTSTRAP_CONFIG__`) with actual configuration (manifest, version, build config), and writes the final files to the user's build directory

Users install only the Dart package from pub.dev — no Node.js required for end users.

## Code Style

### Dart
- Line length: 80 characters
- Strict analysis enabled (`strict-casts`, `strict-raw-types`, `strict-inference`)
- Public API docs required
- Format with `dart format -l 80`

### TypeScript
- Strict mode enabled
- Target: ES2022
- No runtime dependencies (pure browser code)
- ESLint for linting

## Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make changes and add tests
4. If you modified TypeScript: run `npm run build:all` and commit the generated Dart assets
5. Ensure all checks pass: `dart analyze`, `dart test`, `npm run check`, `npm test`
6. Commit and push
7. Create a Pull Request

## Releasing

Releases are triggered by version tags. The CI workflow publishes to pub.dev via OIDC.

```shell
# Update version in pubspec.yaml and CHANGELOG.md
# Commit and tag
git tag 1.0.0
git push origin 1.0.0
```
