import { describe, it, expect } from 'vitest';
import { DEFAULT_STRINGS, format, resolveStrings } from '../strings';

/**
 * Audit #30, item 5.1: every string the loading screen showed was an
 * English literal with no way to change it, and `updateLoadingProgress`
 * only exists once Dart is running — after all of them.
 */
describe('resolveStrings', () => {
  it('is the defaults when there is nothing to override', () => {
    for (const value of [undefined, null, {}, 'nonsense', 42]) {
      expect(resolveStrings(value)).toEqual(DEFAULT_STRINGS);
    }
  });

  it('applies the keys it is given and keeps the rest', () => {
    const resolved = resolveStrings({ app: 'Загрузка приложения' });
    expect(resolved.app).toBe('Загрузка приложения');
    expect(resolved.reload).toBe(DEFAULT_STRINGS.reload);
  });

  it('ignores unknown keys', () => {
    const resolved = resolveStrings({ nope: 'x', app: 'ok' });
    expect(resolved).not.toHaveProperty('nope');
    expect(resolved.app).toBe('ok');
  });

  it('ignores values that are not usable strings', () => {
    // `data-config` is untyped JSON: a typo must not blank out a label.
    const resolved = resolveStrings({
      app: '',
      reload: 42,
      offline: null,
      failed: ['a'],
    });
    expect(resolved.app).toBe(DEFAULT_STRINGS.app);
    expect(resolved.reload).toBe(DEFAULT_STRINGS.reload);
    expect(resolved.offline).toBe(DEFAULT_STRINGS.offline);
    expect(resolved.failed).toBe(DEFAULT_STRINGS.failed);
  });

  it('does not hand back the defaults themselves', () => {
    const resolved = resolveStrings({ app: 'x' });
    expect(resolved).not.toBe(DEFAULT_STRINGS);
    expect(DEFAULT_STRINGS.app).toBe('Loading application');
  });
});

describe('format', () => {
  it('fills the placeholders', () => {
    expect(format(DEFAULT_STRINGS.resources, { done: 3, total: 5 })).toBe(
      'Loaded 3 of 5 resources',
    );
  });

  it('leaves a placeholder with no value visible', () => {
    // A broken override should look broken, not silently empty.
    expect(format('Loaded {done} of {missing}', { done: 1 })).toBe(
      'Loaded 1 of {missing}',
    );
  });

  it('is a no-op for a string without placeholders', () => {
    expect(format('Обновить', { done: 1 })).toBe('Обновить');
  });
});
