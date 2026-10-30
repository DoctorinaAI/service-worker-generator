import { describe, it, expect } from 'vitest';
import { ownCacheNames } from '../cache-ownership';

describe('ownCacheNames', () => {
  it('claims the three shapes of this prefix, on a `-` boundary', () => {
    expect(
      ownCacheNames('app', [
        'app-v1',
        'app-temp-v2',
        'app-manifest',
        'app2-v1',
        'app',
        'workbox-precache-v2',
      ]),
    ).toEqual(['app-v1', 'app-temp-v2', 'app-manifest']);
  });

  it('claims nothing of an app whose prefix extends ours with a `-`', () => {
    // `app-cache-admin` names every cache `app-cache-…`; its manifest cache
    // marks the prefix as in use.
    expect(
      ownCacheNames('app-cache', [
        'app-cache-manifest',
        'app-cache-v1',
        'app-cache-temp-v2',
        'app-cache-admin-manifest',
        'app-cache-admin-v1',
        'app-cache-admin-temp-v2',
      ]),
    ).toEqual(['app-cache-manifest', 'app-cache-v1', 'app-cache-temp-v2']);
  });

  it('claims caches of older workers of this prefix', () => {
    // 0.2.0 named its caches the same way and wrote no marker of its own
    // beyond the manifest cache.
    expect(ownCacheNames('app', ['app-1.0.0', 'app-temp-1.0.1'])).toEqual([
      'app-1.0.0',
      'app-temp-1.0.1',
    ]);
  });

  it('always claims its own manifest cache', () => {
    expect(ownCacheNames('app', ['app-manifest', 'app-x-manifest'])).toEqual([
      'app-manifest',
    ]);
  });

  it('claims nothing for an empty prefix', () => {
    expect(ownCacheNames('', ['-v1', 'a-v1'])).toEqual([]);
  });
});
