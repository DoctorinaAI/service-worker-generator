import { describe, it, expect } from 'vitest';
import {
  getContentCacheName,
  getTempCacheName,
  getManifestCacheName,
} from '../cache-manager';

describe('cache naming', () => {
  describe('getContentCacheName', () => {
    it('combines prefix and version', () => {
      expect(getContentCacheName('my-app', 'v1')).toBe('my-app-v1');
    });

    it('handles numeric version', () => {
      expect(getContentCacheName('app', '12345')).toBe('app-12345');
    });
  });

  describe('getTempCacheName', () => {
    it('includes temp suffix', () => {
      expect(getTempCacheName('my-app', 'v1')).toBe('my-app-temp-v1');
    });
  });

  describe('getManifestCacheName', () => {
    it('includes manifest suffix', () => {
      expect(getManifestCacheName('my-app')).toBe('my-app-manifest');
    });
  });
});
