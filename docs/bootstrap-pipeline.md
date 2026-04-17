# Bootstrap Pipeline

## Overview

The bootstrap pipeline replaces Flutter's `flutter_bootstrap.js` with a controlled initialization sequence that provides granular progress tracking and a loading widget UI.

## Pipeline Stages

### Stage 1: Init (0% → 1%)
- Detect browser capabilities (WebAssembly, WebGL, ImageDecoder, Intl.Segmenter)
- Parse `data-config` from the `<script>` tag
- Merge with injected build-time config (engineRevision, buildConfig)
- Create and mount the loading widget
- Start stall detection timer (30s)

### Stage 2: Service Worker Registration (1% → 2%)
- Unregister any existing Flutter service worker (`flutter_service_worker.js`)
- Register `sw.js` with version query param (`sw.js?v={version}`)
- Wait for activation with timeout (4s default)
- On timeout or failure: continue without SW (app still works, just no caching)
- Listen for `sw-progress` messages from the SW

### Stage 3: CanvasKit Download (2% → 20%)
- Determine renderer from `buildConfig.builds` array
- Select appropriate CanvasKit variant based on browser capabilities
- Try loading from Google CDN (`gstatic.com/flutter-canvaskit/{engineRevision}/`)
- On CDN failure: fall back to local `canvaskit/` directory
- Stream-compile WASM for better performance

### Stage 4: Assets Download (20% → 80%)
- Load `flutter.js` dynamically (kept in build output)
- Call `_flutter.loader.load()` with custom `onEntrypointLoaded` callback
- Flutter loader handles loading `main.dart.js` or WASM entry point
- Track download progress via SW notifications
- Progress is proportional to bytes downloaded vs total expected size

### Stage 5: Dart Entry Point (80% → 90%)
- Flutter calls `onEntrypointLoaded` with `engineInitializer`
- Call `engineInitializer.initializeEngine()`
- Call `appRunner.runApp()`
- Disable pointer events on `<flutter-view>` during init

### Stage 6: Dart Initialization (90% → 100%)
- Dart application manages remaining progress
- Dart calls `window.Bootstrap.progress` to update percentage
- When ready, Dart calls `window.Bootstrap.dispose()` to remove loading widget
- Alternatively, listen for `flutter-first-frame` event as auto-dispose trigger

## Loading Widget

### Visual Design
- **Circular SVG progress ring** — animated, responsive
- **Logo image** — configurable via `data-config.logo`
- **Title text** — configurable via `data-config.title`
- **Status text** — shows current operation (e.g., "Downloading assets")
- **Percentage** — numeric progress display
- **Loading dots animation** — animated ellipsis after status text

### Theming
- `data-config.theme`: `"light"` | `"dark"` | `"auto"` (default)
- `"auto"` respects `prefers-color-scheme` media query
- Configurable accent color via `data-config.color`

### Error Handling
- On error: display error message in the widget area
- Show "Reset Cache" button for recovery
- Log detailed error to console

### Stall Detection
- Timer starts on widget creation
- Resets on every progress update
- After 30 seconds without progress: show "Reset Cache" button with tooltip
- Button clears all caches, unregisters SWs, clears storage, reloads page

### Disposal
- `window.Bootstrap.dispose()` triggers fade-out animation
- Removes all loading widget DOM elements
- Cleans up event listeners and timers
- Enables pointer events on `<flutter-view>`

## Global API (window.Bootstrap)

```typescript
interface BootstrapAPI {
  /** Remove loading widget and clean up. Called by Dart when app is ready. */
  dispose(): void;

  /** Current progress state (readonly). */
  progress: Readonly<ProgressState>;

  /**
   * Subscribe to progress changes.
   * Returns an unsubscribe function.
   */
  subscribe(callback: (state: ProgressState) => void): () => void;
}

interface ProgressState {
  /** Current pipeline phase name */
  phase: 'init' | 'sw' | 'canvaskit' | 'assets' | 'dart-entry' | 'dart-init';
  /** Progress percentage (0-100) */
  percent: number;
  /** Human-readable status message */
  message: string;
}
```

### Progress Range Configuration
- `data-config.minProgress`: minimum progress value (default: 0)
- `data-config.maxProgress`: maximum progress value (default: 90)
- Bootstrap maps its internal 0-100% to the configured range
- Remaining range (90-100% by default) is for Dart to manage

## Console Logging

### Version Banner
On startup, prints a styled banner to the console:
```
╔═══════════════════════════════════════╗
║  App: My App v1.0.0                  ║
║  Flutter Engine: 425cfb54d0...       ║
║  Service Worker: 2024-01-15T10:30:00 ║
║  Renderer: canvaskit (chromium)      ║
╚═══════════════════════════════════════╝
```

### Phase Logging
Each pipeline stage logs:
- Phase name with colored prefix
- Duration of each phase
- Relevant details (CDN URL, file count, etc.)

### Progress Bar
Periodic progress updates as styled console messages.

## HTML Integration

### Minimal index.html
```html
<!DOCTYPE html>
<html>
<head>
  <base href="/">
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="manifest" href="manifest.json">
</head>
<body>
  <script defer data-sw-bootstrap src="bootstrap.js"
    data-config='{
      "logo": "icons/Icon-192.png",
      "title": "My App",
      "theme": "auto",
      "color": "#25D366",
      "minProgress": 0,
      "maxProgress": 90
    }'></script>
</body>
</html>
```

### Configuration Options (data-config)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `logo` | string | — | Path to logo image for loading widget |
| `title` | string | — | Title text below logo |
| `theme` | string | `"auto"` | `"light"`, `"dark"`, or `"auto"` |
| `color` | string | `"#25D366"` | Accent color for progress ring |
| `showPercentage` | boolean | `true` | Show numeric percentage |
| `minProgress` | number | `0` | Minimum progress value |
| `maxProgress` | number | `90` | Maximum progress value (Dart manages the rest) |

## Retry Logic

### Fetch Retry (Exponential Backoff)
- Max attempts: 3
- Delays: 1s → 2s → 4s
- Applied to: CanvasKit CDN loading, asset fetching

### CanvasKit Fallback
- Try CDN with timeout (10s)
- On any failure: automatically try local `canvaskit/` directory
- Log which source was used

### SW Registration Fallback
- Timeout: 4s
- On timeout: continue without SW (app loads normally, no caching)
- On error: log warning, continue without SW
