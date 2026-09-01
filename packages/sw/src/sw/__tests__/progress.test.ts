/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProgressReporter, COUNTED_CATEGORIES } from '../progress';
import { notifyClients } from '../notify';
import type { ResourceManifest, SWProgressMessage } from '../../shared/types';
import { ResourceCategory } from '../../shared/types';

vi.mock('../notify', () => ({
  notifyClients: vi.fn(async () => undefined),
}));

const mockedNotify = vi.mocked(notifyClients);

function manifest(): ResourceManifest {
  return {
    'main.dart.wasm': {
      name: 'main.dart.wasm',
      size: 1000,
      hash: 'h1',
      category: ResourceCategory.Core,
    },
    'index.html': {
      name: 'index.html',
      size: 200,
      hash: 'h2',
      category: ResourceCategory.Required,
    },
    'assets/fonts/Inter.ttf': {
      name: 'Inter.ttf',
      size: 500,
      hash: 'h3',
      category: ResourceCategory.Optional,
    },
    'assets/NOTICES': {
      name: 'NOTICES',
      size: 90,
      hash: 'h4',
      category: ResourceCategory.Ignore,
    },
  };
}

function lastMessage(): SWProgressMessage {
  const call = mockedNotify.mock.calls.at(-1);
  return call![1] as SWProgressMessage;
}

describe('createProgressReporter', () => {
  beforeEach(() => {
    mockedNotify.mockClear();
  });

  it('counts only the categories that are pre-cached', () => {
    expect(COUNTED_CATEGORIES).toEqual([
      ResourceCategory.Core,
      ResourceCategory.Required,
    ]);
    const reporter = createProgressReporter('v1', manifest());
    expect(reporter.resourcesCount).toBe(2);
    expect(reporter.isCounted('main.dart.wasm')).toBe(true);
    expect(reporter.isCounted('index.html')).toBe(true);
    expect(reporter.isCounted('assets/fonts/Inter.ttf')).toBe(false);
    expect(reporter.isCounted('assets/NOTICES')).toBe(false);
    expect(reporter.isCounted('never/seen.bin')).toBe(false);
  });

  it('reports a byte total describing the same set as the count', () => {
    const reporter = createProgressReporter('v1', manifest());
    expect(reporter.resourcesSize).toBe(1200);
  });

  it('stamps every message with the sender version and set membership', async () => {
    const reporter = createProgressReporter('build-42', manifest());

    await reporter.report({
      key: 'main.dart.wasm',
      name: 'main.dart.wasm',
      url: 'https://host/main.dart.wasm',
      size: 1000,
      loaded: 1000,
      status: 'completed',
    });
    expect(lastMessage()).toMatchObject({
      type: 'sw-progress',
      swVersion: 'build-42',
      resourcesCount: 2,
      resourcesSize: 1200,
      resourceKey: 'main.dart.wasm',
      counted: true,
      status: 'completed',
    });

    await reporter.report({
      key: 'assets/fonts/Inter.ttf',
      name: 'Inter.ttf',
      url: 'https://host/assets/fonts/Inter.ttf',
      size: 500,
      loaded: 500,
      status: 'cached',
    });
    expect(lastMessage()).toMatchObject({
      resourceKey: 'assets/fonts/Inter.ttf',
      counted: false,
    });
  });

  it('omits `error` unless one was given', async () => {
    const reporter = createProgressReporter('v1', manifest());
    await reporter.report({
      key: 'index.html',
      name: 'index.html',
      url: 'https://host/',
      size: 200,
      loaded: 0,
      status: 'completed',
    });
    expect('error' in lastMessage()).toBe(false);

    await reporter.report({
      key: 'index.html',
      name: 'index.html',
      url: 'https://host/',
      size: 200,
      loaded: 0,
      status: 'error',
      error: 'HTTP 503',
    });
    expect(lastMessage().error).toBe('HTTP 503');
  });

  it('treats the lifecycle beat (empty key) as uncounted', async () => {
    const reporter = createProgressReporter('v1', manifest());
    await reporter.report({
      key: '',
      name: '',
      url: '',
      size: 0,
      loaded: 0,
      status: 'loading',
    });
    expect(lastMessage()).toMatchObject({
      resourceKey: '',
      counted: false,
      resourcesCount: 2,
    });
  });

  it('reports a zero total for a manifest with nothing to pre-cache', () => {
    const reporter = createProgressReporter('v1', {});
    expect(reporter.resourcesCount).toBe(0);
    expect(reporter.resourcesSize).toBe(0);
  });
});
