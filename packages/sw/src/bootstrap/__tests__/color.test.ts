import { describe, it, expect } from 'vitest';
import { contrastRatio, ensureContrast, relativeLuminance } from '../color';

/**
 * Audit #30, item 5.1: the brand accent as text on the widget's own
 * background was about 1.9:1, and the error red about 3.3:1.
 */
describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('reads the short forms and rgb()', () => {
    expect(relativeLuminance('#fff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#ffff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('rgb(255, 255, 255)')).toBeCloseTo(1, 5);
    expect(relativeLuminance('rgba(255, 255, 255, 0.5)')).toBeCloseTo(1, 5);
  });

  it('is null for a colour it cannot read', () => {
    for (const value of ['teal', 'var(--brand)', '', '#12345', 'rgb(50%, 0, 0)']) {
      expect(relativeLuminance(value)).toBeNull();
    }
  });
});

describe('contrastRatio', () => {
  it('is 21 between black and white, either way round', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 2);
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 2);
  });

  it('is 1 for a colour against itself', () => {
    expect(contrastRatio('#25D366', '#25D366')).toBeCloseTo(1, 5);
  });

  it('is null when either side cannot be read', () => {
    expect(contrastRatio('teal', '#fff')).toBeNull();
    expect(contrastRatio('#fff', 'teal')).toBeNull();
  });

  it('shows the problem the fix is for', () => {
    // The default accent as the title, and the error red, on the light
    // background the widget paints.
    expect(contrastRatio('#25D366', '#f4fdf7')!).toBeLessThan(2);
    expect(contrastRatio('#ff4444', '#f4fdf7')!).toBeLessThan(4.5);
  });
});

describe('ensureContrast', () => {
  const LIGHT = '#f4fdf7';
  const DARK = '#1a1a2e';

  it('darkens a colour until it reads on a light background', () => {
    const fixed = ensureContrast('#25D366', LIGHT);
    expect(fixed).not.toBe('#25D366');
    expect(contrastRatio(fixed, LIGHT)!).toBeGreaterThanOrEqual(4.5);
  });

  it('lightens a colour until it reads on a dark background', () => {
    const fixed = ensureContrast('#0a3d20', DARK);
    expect(contrastRatio(fixed, DARK)!).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps a colour that already passes', () => {
    expect(ensureContrast('#000000', LIGHT)).toBe('#000000');
    expect(ensureContrast('#ffffff', DARK)).toBe('#ffffff');
  });

  it('honours a lower bar for a graphic', () => {
    // 3:1 is what WCAG asks of a non-text element, such as the white icon
    // on the reload button.
    const button = ensureContrast('#25D366', '#ffffff', 3);
    expect(contrastRatio(button, '#ffffff')!).toBeGreaterThanOrEqual(3);
    // And it stops there rather than going all the way to 4.5.
    expect(contrastRatio(button, '#ffffff')!).toBeLessThan(4.5);
  });

  it('leaves a colour it cannot read alone', () => {
    expect(ensureContrast('teal', LIGHT)).toBe('teal');
    expect(ensureContrast('#25D366', 'var(--bg)')).toBe('#25D366');
  });

  it('returns a value that is not a colour at all unchanged', () => {
    // Never reached through the config layer, which substitutes the
    // default for a non-string. Pinned because a throw from here is a
    // stylesheet that never renders: no loading screen, no error screen.
    const notAColour = 16711680 as unknown as string;
    expect(() => ensureContrast(notAColour, LIGHT)).not.toThrow();
    expect(ensureContrast(notAColour, LIGHT)).toBe(notAColour);
    expect(contrastRatio(notAColour, LIGHT)).toBeNull();
  });

  it('keeps the hue recognisable', () => {
    // Darkened, not replaced: green stays the strongest channel.
    const fixed = ensureContrast('#25D366', LIGHT);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(fixed.slice(i, i + 2), 16));
    expect(g).toBeGreaterThan(r!);
    expect(g).toBeGreaterThan(b!);
  });
});
