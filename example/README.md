# Service Worker Example

A Flutter Web app that runs on the worker and bootstrap the `sw` package generates, and shows what they do on real files.

**[Live demo](https://doctorinaai.github.io/service-worker-generator/)**

## What it shows

- **Loading screen**: progress from the bootstrap, then from the app's own initialization through `updateLoadingProgress`.
- **Live status**: whether the worker controls the page, its version, the files in the cache and the storage used, all read from the browser.
- **Lazy caching**: every picture in the gallery is an Optional file. Its label changes to "In cache" once the worker has stored it.
- **The size limit**: `static.webp` is over 512 KB, so the generator leaves it out of the manifest and it is never cached.
- **Recovery**: "Clear caches and reload" does what a browser does under disk pressure. The next load restores what it needs.
- **Updates**: when a new worker is waiting, a banner offers to switch to it.

## Running it

From the repository root:

```bash
cd example && flutter build web --release --wasm -o build/web && cd ..
dart run sw:generate --input=example/build/web
python3 -m http.server 8080 --directory example/build/web
```

Open <http://localhost:8080>. The generator refuses a build it has already processed, so build again before generating again.

## Assets

| Files | Worker category |
|---|---|
| `assets/images/*`: WebP, PNG and JPEG up to 512 KB | Optional, cached on first fetch |
| `assets/images/static.webp`: over 512 KB | Not in the manifest, never cached |
| `assets/fonts/*`: Roboto and Font Awesome | Optional, or Required with `--required` as `pages.yml` does |
| `assets/data/gallery.json` | Optional |
| `assets/shaders/shimmer.frag` | Not in the manifest, always from the network |

Roboto is bundled on purpose. Without it the engine fetches it from `fonts.gstatic.com`, which the worker cannot cache, and text disappears offline.

`tool/generate_assets.mjs` draws the generated pictures and writes `gallery.json`, so re-run it after adding an image. It needs `npm install`, Playwright's Chromium and `cwebp`.
