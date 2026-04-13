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
