/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  findBootstrapScript,
  parseDataConfig,
  resolveConfig,
  withAlpha,
} from '../config';
import type { BootstrapConfig, BuildConfig } from '../../shared/types';
import {
  DEFAULT_MAX_PROGRESS,
  DEFAULT_MIN_PROGRESS,
} from '../../shared/constants';
import {
  DEFAULT_LOG_LEVEL,
  getLogLevel,
  setLogLevel,
} from '../../shared/logger';

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

describe('findBootstrapScript', () => {
  it('finds the script by its data attribute, not by id', () => {
    document.body.innerHTML =
      '<script id="bootstrap"></script><script data-sw-bootstrap data-config="{}"></script>';
    const found = findBootstrapScript();
    expect(found?.hasAttribute('data-sw-bootstrap')).toBe(true);
    expect(found?.id).toBe('');
    document.body.innerHTML = '';
  });

  it('returns null when the page has no bootstrap script', () => {
    document.body.innerHTML = '';
    expect(findBootstrapScript()).toBeNull();
  });
});

describe('resolveConfig — runtime validation', () => {
  const build: BuildConfig = {
    engineRevision: 'abc',
    swVersion: '1',
    swFilename: 'sw.js',
    builds: [],
  };
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  /** data-config arrives as untyped JSON. */
  const ui = (raw: Record<string, unknown>) =>
    resolveConfig(build, raw as BootstrapConfig).ui;

  it('leaves a valid config untouched and silent', () => {
    const r = ui({
      theme: 'dark',
      color: '#112233',
      showPercentage: false,
      minProgress: 5,
      maxProgress: 80,
    });
    expect(r).toMatchObject({
      theme: 'dark',
      color: '#112233',
      showPercentage: false,
      minProgress: 5,
      maxProgress: 80,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('accepts theme case-insensitively', () => {
    expect(ui({ theme: 'Dark' }).theme).toBe('dark');
    expect(ui({ theme: ' AUTO ' }).theme).toBe('auto');
  });

  it('renders an unknown theme as light, as before, and warns', () => {
    expect(ui({ theme: 'system' }).theme).toBe('light');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('reads showPercentage given as a string', () => {
    expect(ui({ showPercentage: 'false' }).showPercentage).toBe(false);
    expect(ui({ showPercentage: 'TRUE' }).showPercentage).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('expands a #rgb color', () => {
    expect(ui({ color: '#0aF' }).color).toBe('#00aaFF');
  });

  it('leaves other color formats as they were, with one warning', () => {
    expect(ui({ color: 'teal' }).color).toBe('teal');
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('keeps #rrggbbaa as the accent', () => {
    expect(ui({ color: '#11223344' }).color).toBe('#11223344');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // `data-config` is untyped JSON, and everything downstream treats the
  // accent as a string: the contrast correction calls `.trim()` on it, and
  // a stylesheet that throws leaves the page with no loading screen and no
  // error screen either.
  it.each([
    ['a number', 16711680],
    ['a boolean', true],
    ['an array', ['#fff']],
    ['an object', { r: 255 }],
  ])('falls back to the default accent for %s', (_why, value) => {
    expect(ui({ color: value }).color).toBe('#25D366');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('treats a null accent as one that was never set', () => {
    expect(ui({ color: null }).color).toBe('#25D366');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // The accent is interpolated into the widget's stylesheet, where a `;`
  // or a `}` ends the declaration and corrupts every rule after it.
  it.each([
    '#fff; } .sw-overlay { display: none',
    'red;',
    '} * { display: none }',
    '#fff /* comment',
    '</style><script>x</script>',
    // An unclosed function or string swallows the rest of the stylesheet,
    // the hidden reload button's rule among it.
    'rgb(37, 211, 102',
    'rgb(37, 211, 102))',
    "red'",
    'url("x',
    'red\\',
  ])('refuses the CSS-breaking accent %s', (value) => {
    expect(ui({ color: value }).color).toBe('#25D366');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('still accepts the colour functions a page may legitimately pass', () => {
    expect(ui({ color: 'rgb(37 211 102)' }).color).toBe('rgb(37 211 102)');
    expect(ui({ color: 'var(--brand)' }).color).toBe('var(--brand)');
  });

  it('falls back to the defaults for non-numeric progress bounds', () => {
    const r = ui({ minProgress: 'abc', maxProgress: null });
    expect(r.minProgress).toBe(DEFAULT_MIN_PROGRESS);
    expect(r.maxProgress).toBe(DEFAULT_MAX_PROGRESS);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('reads numeric strings as numbers', () => {
    const r = ui({ minProgress: '10', maxProgress: '50' });
    expect(r.minProgress).toBe(10);
    expect(r.maxProgress).toBe(50);
  });

  it('clamps progress bounds into 0..100', () => {
    const r = ui({ minProgress: -5, maxProgress: 140 });
    expect(r.minProgress).toBe(0);
    expect(r.maxProgress).toBe(100);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('swaps progress bounds given in the wrong order', () => {
    const r = ui({ minProgress: 95, maxProgress: 90 });
    expect(r.minProgress).toBe(90);
    expect(r.maxProgress).toBe(95);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('validates uiDefaults from the build the same way', () => {
    const r = resolveConfig(
      { ...build, uiDefaults: { theme: 'Light' as 'light', minProgress: 120 } },
      {},
    ).ui;
    expect(r.theme).toBe('light');
    // 120 clamps to 100, which then exceeds the default max of 90: swapped.
    expect(r.minProgress).toBe(90);
    expect(r.maxProgress).toBe(100);
  });
});

describe('withAlpha', () => {
  it('appends alpha to #rrggbb', () => {
    expect(withAlpha('#25D366', '80')).toBe('#25D36680');
  });
  it('replaces the alpha of #rrggbbaa', () => {
    expect(withAlpha('#25D366ff', '80')).toBe('#25D36680');
  });
  it('expands #rgb and #rgba first', () => {
    expect(withAlpha('#fff', '80')).toBe('#ffffff80');
    expect(withAlpha('#fff8', '80')).toBe('#ffffff80');
  });
  it('keeps the old concatenation for other formats', () => {
    expect(withAlpha('teal', '80')).toBe('teal80');
  });
});

/**
 * Issue #38: the page can turn the console output off without regenerating
 * the artifacts, through the same `data-config` the widget is themed with.
 */
describe('resolveConfig — log level', () => {
  const buildConfig: BuildConfig = {
    engineRevision: 'abc123',
    swVersion: '12345',
    swFilename: 'sw.js',
    builds: [],
  };

  afterEach(() => {
    setLogLevel(DEFAULT_LOG_LEVEL);
    vi.restoreAllMocks();
  });

  it('applies a level given in data-config', () => {
    resolveConfig(buildConfig, { logLevel: 'silent' });
    expect(getLogLevel()).toBe('silent');
  });

  it('silences the corrections it would otherwise report', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // A theme and a colour the widget cannot use: normally a line each.
    resolveConfig(buildConfig, {
      logLevel: 'silent',
      theme: 'neon' as BootstrapConfig['theme'],
      color: 'rebeccapurple',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the level the build was generated with when data-config has none', () => {
    setLogLevel('error');
    resolveConfig(buildConfig, { title: 'App' });
    expect(getLogLevel()).toBe('error');
  });

  it('leaves logLevel out of the widget’s settings', () => {
    const resolved = resolveConfig(buildConfig, { logLevel: 'warn' });
    expect('logLevel' in resolved.ui).toBe(false);
  });
});

describe('resolveConfig — showWidget', () => {
  const build: BuildConfig = {
    engineRevision: 'abc123',
    swVersion: '12345',
    swFilename: 'sw.js',
    builds: [],
  };

  it('defaults to drawing the loading screen', () => {
    expect(resolveConfig(build, {}).ui.showWidget).toBe(true);
  });

  it('takes the generator default baked into the artifact', () => {
    expect(
      resolveConfig({ ...build, uiDefaults: { showWidget: false } }, {}).ui.showWidget,
    ).toBe(false);
  });

  it('lets the page override the generator per deployment', () => {
    expect(
      resolveConfig({ ...build, uiDefaults: { showWidget: false } }, { showWidget: true })
        .ui.showWidget,
    ).toBe(true);
  });

  it('reads "false" as false, since data-config is untyped JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ui = resolveConfig(
      build,
      { showWidget: 'false' as unknown as boolean },
    ).ui;
    expect(ui.showWidget).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never lets an unusable value be what removes the screen', () => {
    // A page that did not deliberately opt out must not end up with no
    // loading screen because of a typo in its `data-config`.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      resolveConfig(build, { showWidget: 'maybe' as unknown as boolean }).ui
        .showWidget,
    ).toBe(true);
    expect(
      resolveConfig(build, { showWidget: 1 as unknown as boolean }).ui.showWidget,
    ).toBe(true);
    warn.mockRestore();
  });
});
