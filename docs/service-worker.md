# Service Worker

## Overview

The generated `sw.js` handles resource caching with category-aware strategies, version-based cache invalidation, and progress notifications to the client.

## Configuration

The SW receives its configuration via placeholder injection. The Dart CLI replaces `"__INJECT_SW_CONFIG__"` with a JSON object:

```typescript
interface SWConfig {
  cachePrefix: string;        // e.g., "my-app"
  version: string;            // e.g., "1713200000000" (timestamp)
  manifest: ResourceManifest; // path → { name, size, hash, category }
}
```

## Resource Manifest

```typescript
type ResourceManifest = Record<string, ResourceEntry>;

interface ResourceEntry {
  name: string;                // basename, e.g., "main.dart.js"
  size: number;                // file size in bytes
  hash: string;                // MD5 hash for cache busting
  category: ResourceCategory;  // "core" | "required" | "optional" | "ignore"
}
```

## Cache Strategy

### Cache Names
| Cache | Format | Purpose |
|-------|--------|---------|
| Content | `{prefix}-{version}` | Main resource cache |
| Temp | `{prefix}-temp-{version}` | Temporary cache during install (atomic swap) |
| Manifest | `{prefix}-manifest` | Previous manifest storage (unversioned) |

### Per-Category Behavior

| Category | On Install | On Fetch | Cache Busting |
|----------|-----------|----------|---------------|
| Core | Pre-cached | Cache-first | `?v={hash}` |
| Required | Pre-cached | Cache-first | `?v={hash}` |
| Optional | — | Cache on first fetch | `?v={hash}` |
| Ignore | — | Pass-through | — |

### Special Cases
- Navigations (`/`, `index.html`, and any SPA route): network-first, falling back to the pre-cached `index.html`
- Only `/` and `/index.html` may *write* that cached shell. Another
  same-origin page — a static legal page, a download, an OAuth callback —
  answers a navigation with its own HTML, and storing that under the shell
  key would leave the app unable to boot from cache at all
- `__/*`: pass-through. Hosts reserve namespaces they serve themselves and
  exclude from the SPA rewrite; Firebase Auth's `/__/auth/handler` and
  `/__/auth/iframe` live there when `authDomain` is the app's own domain.
  See `RESERVED_PATH_PREFIXES`
- `bootstrap.js`, `sw.js`: Never cached (always fetch fresh)
- Non-GET requests: Pass-through

> `index.html`, `bootstrap.js` and `sw.js` also require `Cache-Control: no-cache` at the HTTP layer. See [Server Configuration](../README.md#server-configuration) for the required headers.

### Resource keys are scope-relative

Every lookup and every guard in the fetch handler is keyed by a
manifest-relative path. The manifest is keyed the way the build directory is
laid out (`main.dart.wasm`), so a URL is reduced against the worker's
`registration.scope` before anything looks at it: with `<base href="/app/">`,
`/app/__/auth/handler` becomes `__/auth/handler`.

This matters beyond cache hits. `RESERVED_PATH_PREFIXES` — the list that
keeps the host's own namespace (`__/`, where Firebase serves its Auth
handler and iframe) away from the app-shell branch — matches on a key. Keyed
by absolute pathname it would simply stop matching under a base href, and
the app shell would start answering sign-in navigations.

A same-origin URL outside the scope is left as-is; it misses the manifest
and falls through to the network.

### Redirects

A navigation request carries redirect mode `manual`, so a same-origin 3xx
comes back opaque: `type` is `opaqueredirect`, `status` is `0`, `ok` is
`false`. The fetch handler passes it straight back, which is what lets the
browser follow the redirect. Reading it as a failure would answer every
redirecting URL on the origin with the app shell.

A response that *did* follow a redirect (`redirected === true`) cannot be
replayed for a later navigation — the browser rejects it. Both writers of
the shell, install-time pre-cache and the network-first refresh, store a
rebuilt copy with the flag dropped, so a host that normalizes
`/index.html` to `/` does not poison the offline path.


## Event Handlers

### Install Event
1. Open temp cache (`{prefix}-temp-{version}`)
2. Fetch all Core and Required resources with cache-busted URLs
3. Store responses in temp cache
4. Leave the new worker in `waiting` until the client explicitly opts in
5. Notify clients of progress during pre-caching

### Activate Event
1. Open content cache and temp cache
2. Move all resources from temp to content cache (atomic swap)
3. Load previous manifest from manifest cache
4. Compare hashes — remove outdated resources from content cache
5. Save current manifest to manifest cache
6. Delete all old caches with matching prefix
7. Delete temp cache
8. Call `self.clients.claim()`
9. On error: clear all caches (clean slate recovery)

### Fetch Event
1. Only handle GET requests
2. Normalize URL: strip query params, handle trailing slashes
3. If the path is under a reserved prefix (`__/`): pass-through
4. If the request is a navigation (or targets `index.html`): network-first,
   falling back to the pre-cached shell — checked before the manifest lookup,
   since an SPA route has no manifest entry of its own. The shell cache is
   refreshed only when the request is for the shell itself, and never from a
   redirected response (which browsers refuse to replay for a navigation)
5. Look up resource key in manifest
6. If not in manifest or Ignore category: pass-through to network
7. Otherwise: cache-first with network fallback
8. On successful network fetch for Optional resources: cache the response
9. Notify clients of fetch progress (best-effort — a progress failure never
   fails the response)

### Message Event

| Command | Action |
|---------|--------|
| `skipWaiting` | Call `self.skipWaiting()` to activate waiting SW |
| `getVersion` | Respond with current SW version string |

## Resilience

### Fetch with Retry (Exponential Backoff)
```
Attempt 1: immediate
Attempt 2: wait 1s
Attempt 3: wait 2s
(fail after 3 attempts)
```

### Fetch with Timeout
- Default: 10 seconds per request
- Uses `AbortController` for clean cancellation
- Timeout triggers retry logic
- Covers the response headers only — see the body watchdog below

### Body Stall Watchdog
- A pre-cached body that produces no bytes for 30s is cancelled
- Measured as idle time, not total duration: a slow connection that keeps
  delivering bytes is never cut off, however long a ~10 MB `main.dart.js` takes
- Without it, `cache.put` reads a stalled stream forever. That hangs `install`,
  and an install that never settles blocks the scope's job queue — every later
  `register()` and `unregister()` on the origin hangs with it, until the browser
  times the install out minutes later
- A cancelled body fails that one entry; a `Core` entry fails the install, which
  is retried on the next page load

### Activate Recovery
- On any error during activate: clear all caches
- Always call `self.clients.claim()` even on error
- Prevents stuck pages

## Client Notifications

The SW sends progress messages to all connected clients via `postMessage`:

```typescript
interface SWProgressMessage {
  type: 'sw-progress';
  timestamp: number;
  swVersion: string;         // Version of the worker that sent this
  resourcesSize: number;     // Total bytes of the counted set
  resourcesCount: number;    // Size of the counted set — the denominator
  resourceName: string;      // e.g., "main.dart.js"
  resourceUrl: string;       // Full URL
  resourceKey: string;       // Normalized path key ('' for lifecycle beats)
  resourceSize: number;      // Size of this resource in bytes
  loaded: number;            // Bytes loaded so far
  status: SWProgressStatus;
  counted: boolean;          // Whether this resource is in the counted set
  error?: string;            // Error message if status is 'error'
}

type SWProgressStatus =
  | 'loading'     // Currently downloading
  | 'completed'   // Successfully cached
  | 'updated'     // Cache updated (hash changed)
  | 'cached'      // Served from cache (no download)
  | 'error';      // Failed to fetch
```

### The counted set

`resourcesCount` and `resourcesSize` describe the **pre-cached set** —
`Core` + `Required`. Those are the resources a *cold* startup is guaranteed
to hear about, because the SW fetches them itself during install. Whether an
`Optional` resource is requested at all depends on the browser, the route
and the CanvasKit CDN, so it cannot belong to a total fixed at build time.

A warm load has no install event, so the numerator only reflects what the
fetch handler happens to serve, and it will not reach the total: the shell
is answered during the navigation itself — before any page script exists to
hear the message — a JS-build entry point is never requested on a
wasm-capable browser, and the rest may come from the browser's own HTTP
cache without a fetch event. Expect the count to stop short on every load
after the first. It is a floor, not a completion signal; the pipeline's own
stages carry the bar the rest of the way.

The SW reports every resource it serves, so a client showing
`Loaded n of resourcesCount` must observe two rules:

1. **Count only `counted: true` messages.** Everything else is reported for
   display, not for arithmetic.
2. **Ignore messages whose `swVersion` is not yours.** During an update load
   an older worker still controls the page and broadcasts its own manifest's
   totals to the same client.

Breaking either rule lets the numerator leave the set the denominator
describes — which is how `Loaded 5 of 4 resources` happened.

## Version Management

### SW Version
- The SW itself has a version string (embedded in the script)
- Used for registration: `sw.js?v={version}`
- Browser detects byte changes in SW script → triggers update

### Cache Version
- Each generation produces a new cache version (timestamp by default)
- New version → new cache name → old caches cleaned on activate
- Manifest comparison ensures only changed resources are re-fetched

### Update Flow
1. Browser detects new `sw.js` (byte comparison)
2. New SW installs in background (pre-caches into temp cache)
3. New SW waits while the currently active worker keeps serving traffic
4. Client calls `skipWaiting` only after the user accepts the update prompt
5. New SW activates → atomic cache swap → old caches cleaned → `clients.claim()`
