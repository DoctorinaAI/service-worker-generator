import { MANIFEST_CACHE_SUFFIX } from './constants';

/**
 * Which of [names] (a `caches.keys()` listing) belong to the app with
 * cache prefix [prefix]. Used by the worker's cleanup and by the loading
 * widget's reset, so the two can never disagree about what is ours.
 *
 * An app's caches are `{prefix}-{version}`, `{prefix}-temp-{version}` and
 * `{prefix}-manifest`. Matching on `{prefix}-` alone is not enough: another
 * app on the origin with prefix `app-cache-admin` names every one of its
 * caches `app-cache-…`, so prefix `app-cache` would claim them all —
 * including a temp cache its install is still writing.
 *
 * The rule: a name is ours when it starts with `{prefix}-` and is not
 * *shadowed*. Every `X-manifest` in the listing where `X` is longer than
 * our prefix and starts with `{prefix}-` marks `X` as another app's prefix
 * in use; `X-manifest` itself and every name starting with `X-` then
 * belong to that app, never to us. Our own `{prefix}-manifest` is always
 * ours.
 *
 * Why the marker is reliable: the worker opens its manifest cache at the
 * very start of install, before it creates its temp cache, and never
 * deletes it (a failed swap clears the stored manifest inside it, not the
 * cache). So any listing that contains another app's temp or content
 * cache also contains its marker, as long as that app runs a worker from
 * this release on. An app on an older release is protected from its first
 * activate on, when it writes its manifest cache.
 *
 * What it costs: a name of ours that happens to look shadowed — only
 * possible for a version ending in `-manifest` — is never cleaned up. The
 * rule errs towards keeping a cache, never towards deleting a foreign one.
 * Caches written by older workers of this app (0.2.0 used the same names)
 * are still ours and still cleaned.
 *
 * An empty [prefix] claims nothing.
 */
export function ownCacheNames(
  prefix: string,
  names: readonly string[],
): string[] {
  if (!prefix) return [];
  const own = `${prefix}-`;
  const ownManifest = `${prefix}${MANIFEST_CACHE_SUFFIX}`;
  const shadows = names
    .filter(
      (n) =>
        n !== ownManifest &&
        n.startsWith(own) &&
        n.endsWith(MANIFEST_CACHE_SUFFIX) &&
        n.length > ownManifest.length,
    )
    .map((n) => `${n.slice(0, -MANIFEST_CACHE_SUFFIX.length)}-`);
  return names.filter(
    (n) =>
      n === ownManifest ||
      (n.startsWith(own) && !shadows.some((shadow) => n.startsWith(shadow))),
  );
}
