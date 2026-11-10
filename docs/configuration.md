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
| `--output` | `-o` | `sw.js` | Output service worker file name. A plain file name in the build directory (no `/`, `\`, `..` or absolute path): a worker only controls pages under the directory it is served from, so it must sit next to `index.html` |
| `--bootstrap-output` | — | `bootstrap.js` | Output bootstrap file name. A plain file name, like `--output`, and different from it |
| `--prefix` | `-p` | `app-cache` | Cache name prefix. Give every app on one origin its own: caches are per origin, and the default `app-cache` is shared by every app that keeps it, so their workers delete each other's caches as old versions. A prefix that is another followed by `-` (`app` and `app-admin`) is told apart by its `{prefix}-manifest` cache, but an `app-admin` on an older release is exposed until its first activate, so prefer prefixes that don't extend each other |
| `--version` | `-v` | manifest content hash | Cache version string. `manifest`, `temp-*` and `*-manifest` are rejected: they collide with the worker's own cache names |

### File Filtering

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--glob` | `-g` | `**` | Include glob patterns (`;` separated) |
| `--no-glob` | `-e` | — | Exclude glob patterns (`;` separated) |

In `sw.yaml`, `glob`, `no-glob` and the four category overrides below take
either a `;`-separated string or a YAML list (`glob: ["**.js", "assets/**"]`).
Patterns are compiled while the configuration is read: an invalid one exits
with status 64 and names the option and the pattern.

### Category Overrides

| Option | Description |
|--------|-------------|
| `--core` | Additional glob patterns for Core category |
| `--required` | Additional glob patterns for Required category |
| `--optional` | Additional glob patterns for Optional category |
| `--ignore` | Additional glob patterns for Ignore category |


These are additive — they extend the default patterns, not replace them.

**`*` does not cross `/`.** These are `package:glob` patterns, not
`.gitignore` lines: `--ignore="*.png"` matches `favicon.png` and nothing
under `assets/`. Write `**/*.png` for every directory, or
`"{*.png,**/*.png}"` for both. A pattern of that shape is warned about so
it cannot quietly do nothing.

Patterns are matched in a fixed order: **core → required → ignore →
optional**, and the first match wins. A pattern that already matches a
built-in higher-priority default therefore cannot demote a file:
`--ignore="index.html"` is silently ineffective, because `index.html` is a
built-in Required pattern. Use `--no-glob` to keep a file out of the
manifest entirely.

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
| `--keep-maps` | `false` | Keep `.js.map`, `.js.symbols` and `.wasm.map` files (removed by default) |
| `--no-cleanup` | `false` | Leave the input tree alone: keep Flutter's files and leave `{{sw_version}}` unsubstituted (otherwise it is replaced with the HTML-escaped version) |
| `--comments` | `false` | Deprecated: accepted and warned about, with no effect. `sw.js` and `bootstrap.js` are built and minified before the generator sees them, so there is nothing to comment |
| `--log-level` | `info` | How much the generated `sw.js` and `bootstrap.js` print on the browser console: `silent`, `error`, `warn` or `info` |
| `--config` | `sw.yaml` | Path to YAML config file |

### Console output

`--log-level` is baked into both artifacts, so a production deployment can
be quiet without any change to the page:

| Level | What reaches the console |
|-------|--------------------------|
| `info` | Everything: the version banner, a line per pipeline stage, the progress bar, the worker's manifest summary, plus every warning and error |
| `warn` | Warnings and errors only — a quota that ran out, a file the host serves in another size, a configuration value that had to be corrected |
| `error` | Errors only: what broke |
| `silent` | Nothing at all |

The level is matched case-insensitively; an unknown one exits with status 64
and names where it came from. A page can override the baked-in level per
deployment through the bootstrap's `data-config` (see
[bootstrap-pipeline.md](bootstrap-pipeline.md)):

```html
<script defer data-sw-bootstrap src="bootstrap.js"
  data-config='{"logLevel":"warn"}'></script>
```

It changes nothing but the output: no code path depends on the level.

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
log-level: info
```

Glob options also accept a YAML list, joined with `;` like the CLI form:

```yaml
glob:
  - "**.{html,js,wasm,json}"
  - "assets/**"
```

A mapping, a nested list or an empty item there exits with status 64, as
does a list for an option that takes a single value. Plain scalars are taken
as written, so `version: 1.10` stays `1.10` (not `1.1`) and `title: 0x1F`
stays `0x1F` (not `31`).

Specify a custom config path:

```shell
dart run sw:generate --config=config/sw-production.yaml
```

A file named this way is a requirement: if it does not exist, is not a
mapping, or does not parse, the run exits with status 64 rather than
continuing on defaults. A typo in that path would otherwise deploy with the
prefix, categories and branding of an app nobody configured. The default
`sw.yaml` stays optional — absent, it is simply not used; unparseable, it
warns and the run continues on CLI args, environment and defaults.

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
| `SW_GLOB` | `--glob` |
| `SW_EXCLUDE_GLOB` | `--no-glob` |
| `SW_CORE` | `--core` |
| `SW_REQUIRED` | `--required` |
| `SW_OPTIONAL` | `--optional` |
| `SW_IGNORE` | `--ignore` |
| `SW_MIN_PROGRESS` | `--min-progress` |
| `SW_MAX_PROGRESS` | `--max-progress` |
| `SW_KEEP_MAPS` | `--keep-maps` (`true`/`false`) |
| `SW_NO_CLEANUP` | `--no-cleanup` (`true`/`false`) |
| `SW_COMMENTS` | `--comments` (`true`/`false`) |
| `SW_LOG_LEVEL` | `--log-level` |

An invalid value exits with status 64 and names where it came from:
`--max-progress="lots"`, `SW_MIN_PROGRESS="ten" (environment)` or
`max-progress="lots" (in sw.yaml)`.

Two names are checked for more than their shape:

- `--output` / `--bootstrap-output` must be a plain file name that the run
  will not then delete. `flutter_service_worker.js`, `flutter_bootstrap.js`
  and `flutter.js` are removed from the build after generation, so writing
  an output under one of those names used to succeed, report "Done!" and
  leave nothing behind; `index.html` and `main.dart.*` belong to the build
  itself.
- `--prefix` must be a plain name — not empty, no surrounding whitespace,
  no path separator. It names every cache the worker keeps *and* scopes the
  loading screen's "clear the cache and reload", which with an empty prefix
  cleared every cache on the origin, including another app's.

## Default Categorization Rules

### Core (pre-cached on install)

```
main.dart.js
main.dart.wasm
main.dart.mjs
*.support.wasm
```

CanvasKit and skwasm files are Optional, not Core: the bootstrap loads them
from the CDN first and falls back to the local copy, which is then cached on
first fetch (`--no-web-resources-cdn` builds load them locally from the start).

### Required (pre-cached on install)

```
index.html
assets/AssetManifest*.json
assets/FontManifest.json
manifest.json
```

`index.html` is the app shell: pre-caching it gives a navigation a fallback
when the network fails (the app still cannot start offline, since
`bootstrap.js` is never cached), and it puts the shell inside the
progress-counted set.
The fetch handler still serves it network-first, so a deploy is picked up
as soon as the origin is reachable.

### Optional (cached on first fetch)

**Fonts — any size** (declared in `FontManifest.json`, required for correct rendering):
`.ttf`, `.otf`, `.woff`, `.woff2`, `.eot`

**Other media — only when file ≤ 512 KB** (larger files fall through to `ignore`
and rely on the browser's HTTP cache):
`.json`, `.webp`, `.png`, `.jpg`, `.jpeg`, `.svg`, `.gif`, `.ico`

### Ignore (never cached)

```
*.map
*.symbols
assets/NOTICES
sw.js
bootstrap.js
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
