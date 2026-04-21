/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { parseDataConfig, resolveConfig } from '../config';
import type { BuildConfig } from '../../shared/types';

describe('parseDataConfig', () => {
  it('returns empty config when element is null', () => {
    expect(parseDataConfig(null)).toEqual({});
  });

  it('returns empty config when no data-config attribute', () => {
    const el = document.createElement('script');
    expect(parseDataConfig(el)).toEqual({});
  });

  it('parses valid JSON data-config', () => {
    const el = document.createElement('script');
    el.dataset.config = JSON.stringify({
      logo: 'icons/Icon-192.png',
      title: 'My App',
      theme: 'dark',
      color: '#ff0000',
    });

    const config = parseDataConfig(el);
    expect(config.logo).toBe('icons/Icon-192.png');
    expect(config.title).toBe('My App');
    expect(config.theme).toBe('dark');
    expect(config.color).toBe('#ff0000');
  });

  it('returns empty config on invalid JSON', () => {
    const el = document.createElement('script');
    el.dataset.config = 'not json';

    expect(parseDataConfig(el)).toEqual({});
  });

  it('handles partial config', () => {
    const el = document.createElement('script');
    el.dataset.config = JSON.stringify({ logo: 'logo.png' });

    const config = parseDataConfig(el);
    expect(config.logo).toBe('logo.png');
    expect(config.title).toBeUndefined();
  });
});

describe('resolveConfig', () => {
  const buildConfig: BuildConfig = {
    engineRevision: 'abc123',
    swVersion: '12345',
    swFilename: 'sw.js',
    builds: [],
  };

  it('applies all defaults when user config is empty', () => {
    const resolved = resolveConfig(buildConfig, {});

    expect(resolved.build).toBe(buildConfig);
    expect(resolved.ui.logo).toBe('');
    expect(resolved.ui.title).toBe('');
    expect(resolved.ui.theme).toBe('auto');
    expect(resolved.ui.color).toBe('#25D366');
    expect(resolved.ui.showPercentage).toBe(true);
    expect(resolved.ui.minProgress).toBe(0);
    expect(resolved.ui.maxProgress).toBe(90);
  });

  it('uses user values over defaults', () => {
    const resolved = resolveConfig(buildConfig, {
      logo: 'my-logo.png',
      title: 'Test App',
      theme: 'dark',
      color: '#ff0000',
      showPercentage: false,
      minProgress: 10,
      maxProgress: 80,
    });

    expect(resolved.ui.logo).toBe('my-logo.png');
    expect(resolved.ui.title).toBe('Test App');
    expect(resolved.ui.theme).toBe('dark');
    expect(resolved.ui.color).toBe('#ff0000');
    expect(resolved.ui.showPercentage).toBe(false);
    expect(resolved.ui.minProgress).toBe(10);
    expect(resolved.ui.maxProgress).toBe(80);
  });

  it('preserves build config reference', () => {
    const resolved = resolveConfig(buildConfig, {});
    expect(resolved.build.engineRevision).toBe('abc123');
    expect(resolved.build.swVersion).toBe('12345');
  });

  it('applies uiDefaults from buildConfig when user config is empty', () => {
    const cfg: BuildConfig = {
      ...buildConfig,
      uiDefaults: {
        logo: 'brand.png',
        title: 'Baked Brand',
        theme: 'dark',
        color: '#123456',
        minProgress: 5,
        maxProgress: 95,
      },
    };
    const resolved = resolveConfig(cfg, {});
    expect(resolved.ui.logo).toBe('brand.png');
    expect(resolved.ui.title).toBe('Baked Brand');
    expect(resolved.ui.theme).toBe('dark');
    expect(resolved.ui.color).toBe('#123456');
    expect(resolved.ui.minProgress).toBe(5);
    expect(resolved.ui.maxProgress).toBe(95);
  });

  it('data-config overrides uiDefaults from buildConfig', () => {
    const cfg: BuildConfig = {
      ...buildConfig,
      uiDefaults: { title: 'Baked', color: '#000000' },
    };
    const resolved = resolveConfig(cfg, { title: 'Runtime', color: '#ffffff' });
    expect(resolved.ui.title).toBe('Runtime');
    expect(resolved.ui.color).toBe('#ffffff');
  });
});
