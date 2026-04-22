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
- `index.html` (`/`): Network-first with cache fallback
- `bootstrap.js`, `sw.js`: Never cached (always fetch fresh)
- Non-GET requests: Pass-through

> These three files also require `Cache-Control: no-cache` at the HTTP layer. See [Server Configuration](../README.md#server-configuration) for the required headers.

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
3. Look up resource key in manifest
4. If not in manifest or Ignore category: pass-through to network
5. If `/` (index.html): network-first with cache fallback
6. Otherwise: cache-first with network fallback
7. On successful network fetch for Optional resources: cache the response
8. Notify clients of fetch progress

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

### Install Timeout
- If pre-caching hangs: 30s timeout, fail install
- SW will retry on next page load

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
  resourcesSize: number;     // Total size of all manifest resources
  resourceName: string;      // e.g., "main.dart.js"
  resourceUrl: string;       // Full URL
  resourceKey: string;       // Normalized path key
  resourceSize: number;      // Size of this resource in bytes
  loaded: number;            // Bytes loaded so far
  status: SWProgressStatus;
  error?: string;            // Error message if status is 'error'
}

type SWProgressStatus =
  | 'loading'     // Currently downloading
  | 'completed'   // Successfully cached
  | 'updated'     // Cache updated (hash changed)
  | 'cached'      // Served from cache (no download)
  | 'error';      // Failed to fetch
```

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
