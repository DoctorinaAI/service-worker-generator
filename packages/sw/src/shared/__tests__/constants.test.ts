import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CACHE_PREFIX,
  TEMP_CACHE_SUFFIX,
  MANIFEST_CACHE_SUFFIX,
  CANVASKIT_CDN_BASE,
  FETCH_TIMEOUT_MS,
  SW_REGISTRATION_TIMEOUT_MS,
  STALLED_TIMEOUT_MS,
  MAX_RETRY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  STAGE_PROGRESS,
  SW_CONFIG_PLACEHOLDER,
  BOOTSTRAP_CONFIG_PLACEHOLDER,
  NEVER_CACHE_FILES,
} from '../constants';

describe('constants', () => {
  it('has expected default cache prefix', () => {
    expect(DEFAULT_CACHE_PREFIX).toBe('app-cache');
  });

  it('has cache suffixes', () => {
    expect(TEMP_CACHE_SUFFIX).toBe('-temp');
    expect(MANIFEST_CACHE_SUFFIX).toBe('-manifest');
  });

  it('has CanvasKit CDN URL', () => {
    expect(CANVASKIT_CDN_BASE).toContain('gstatic.com');
  });

  it('has reasonable timeout values', () => {
    expect(FETCH_TIMEOUT_MS).toBe(10_000);
    expect(SW_REGISTRATION_TIMEOUT_MS).toBe(4_000);
    expect(STALLED_TIMEOUT_MS).toBe(30_000);
  });

  it('has retry config', () => {
    expect(MAX_RETRY_ATTEMPTS).toBe(3);
    expect(RETRY_BASE_DELAY_MS).toBe(1_000);
  });

  it('has stage progress milestones in ascending order', () => {
    expect(STAGE_PROGRESS.init).toBeLessThan(STAGE_PROGRESS.sw);
    expect(STAGE_PROGRESS.sw).toBeLessThan(STAGE_PROGRESS.canvaskit);
    expect(STAGE_PROGRESS.canvaskit).toBeLessThan(STAGE_PROGRESS.assets);
    expect(STAGE_PROGRESS.assets).toBeLessThan(STAGE_PROGRESS.dartEntry);
    expect(STAGE_PROGRESS.dartEntry).toBeLessThan(STAGE_PROGRESS.dartInit);
    expect(STAGE_PROGRESS.dartInit).toBe(100);
  });

  it('has placeholder tokens wrapped in double quotes', () => {
    expect(SW_CONFIG_PLACEHOLDER).toBe('"__INJECT_SW_CONFIG__"');
    expect(BOOTSTRAP_CONFIG_PLACEHOLDER).toBe('"__INJECT_BOOTSTRAP_CONFIG__"');
  });

  it('never-cache list contains bootstrap.js and sw.js (index.html is NOT in it)', () => {
    expect(NEVER_CACHE_FILES).toContain('bootstrap.js');
    expect(NEVER_CACHE_FILES).toContain('sw.js');
    // index.html is intentionally excluded — it must flow through networkFirst.
    expect(NEVER_CACHE_FILES).not.toContain('index.html');
  });
});
