# Configuration

## Overview

The generator accepts configuration from three sources, with the following priority:

1. **CLI arguments** (highest priority)
2. **YAML config file** (`sw.yaml` by default)
3. **Environment variables**
4. **Built-in defaults** (lowest priority)

## CLI Arguments

```shell
dart run sw:generate [options]
```

### Core Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--input` | `-i` | `build/web` | Path to Flutter build directory |
| `--output` | `-o` | `sw.js` | Output service worker filename |
| `--bootstrap-output` | — | `bootstrap.js` | Output bootstrap filename |
| `--prefix` | `-p` | `app-cache` | Cache name prefix |
| `--version` | `-v` | timestamp | Cache version string |

### File Filtering

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--glob` | `-g` | `**` | Include glob patterns (`;` separated) |
| `--no-glob` | `-e` | — | Exclude glob patterns (`;` separated) |

### Category Overrides

| Option | Description |
|--------|-------------|
| `--core` | Additional glob patterns for Core category |
| `--required` | Additional glob patterns for Required category |
| `--optional` | Additional glob patterns for Optional category |
| `--ignore` | Additional glob patterns for Ignore category |

These are additive — they extend the default patterns, not replace them.

### Loading Widget

| Option | Default | Description |
|--------|---------|-------------|
| `--theme` | `auto` | Widget theme: `light`, `dark`, `auto` |
| `--logo` | — | Path to logo image |
| `--title` | — | Title text below logo |
| `--color` | `#25D366` | Accent color for progress ring |
| `--min-progress` | `0` | Minimum progress value |
| `--max-progress` | `90` | Maximum progress value |

### Behavior Flags

| Option | Default | Description |
|--------|---------|-------------|
| `--keep-maps` | `false` | Keep `.js.map` and `.js.symbols` files |
| `--no-cleanup` | `false` | Skip Flutter file cleanup |
| `--comments` | `false` | Include comments in output |
| `--config` | `sw.yaml` | Path to YAML config file |

## YAML Config File

Create `sw.yaml` in your project root:

```yaml
# Core settings
input: build/web
output: sw.js
bootstrap-output: bootstrap.js
prefix: my-app

# File filtering
glob: "**.{html,js,wasm,json}; assets/**; canvaskit/**; icons/**"
no-glob: "sw.js; bootstrap.js; **/*.map; assets/NOTICES"

# Category overrides
core: "assets/critical/**"
ignore: "assets/video/**; assets/large/**"

# Loading widget
theme: auto
logo: icons/Icon-192.png
title: My App
color: "#25D366"
min-progress: 0
max-progress: 90

# Behavior
keep-maps: false
no-cleanup: false
```

Specify a custom config path:

```shell
dart run sw:generate --config=config/sw-production.yaml
```

## Environment Variables

| Variable | Maps to |
|----------|---------|
| `SW_INPUT` | `--input` |
| `SW_OUTPUT` | `--output` |
| `SW_BOOTSTRAP_OUTPUT` | `--bootstrap-output` |
| `SW_PREFIX` | `--prefix` |
| `SW_VERSION` | `--version` |
| `SW_THEME` | `--theme` |
| `SW_LOGO` | `--logo` |
| `SW_TITLE` | `--title` |
| `SW_COLOR` | `--color` |

## Default Categorization Rules

### Core (pre-cached on install)

```
main.dart.js
main.dart.wasm
main.dart.mjs
*.support.wasm
canvaskit/{variant}.js     # Only the variant matching the renderer
canvaskit/{variant}.wasm   # Only the variant matching the renderer
```

### Required (pre-cached on install)

```
assets/AssetManifest*.json
assets/FontManifest.json
```

### Optional (cached on first fetch)

**Fonts — any size** (declared in `FontManifest.json`, required for correct rendering):
`.ttf`, `.otf`, `.woff`, `.woff2`, `.eot`

**Other media — only when file < 512 KB** (larger files fall through to `ignore`
and rely on the browser's HTTP cache):
`.json`, `.webp`, `.png`, `.jpg`, `.jpeg`, `.svg`, `.gif`, `.ico`

### Ignore (never cached)

```
*.map
*.symbols
assets/NOTICES
sw.js
bootstrap.js
index.html
flutter_bootstrap.js
flutter_service_worker.js
flutter.js
```

Plus any file that doesn't match Core, Required, or Optional rules.

## Examples

### Minimal

```shell
dart run sw:generate
```

Uses all defaults: reads `build/web`, generates `sw.js` and `bootstrap.js`.

### Production with Custom Prefix

```shell
dart run sw:generate --input=build/web --prefix=myapp-v2 --version=2024.01.15
```

### CI/CD with Environment Variables

```shell
export SW_PREFIX=myapp
export SW_VERSION=$(git rev-parse --short HEAD)
dart run sw:generate
```

### Custom Categories

```shell
dart run sw:generate \
  --core="assets/fonts/**" \
  --ignore="assets/video/**; assets/audio/**" \
  --optional="assets/images/**"
```
