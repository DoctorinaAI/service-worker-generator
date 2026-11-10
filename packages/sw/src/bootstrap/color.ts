/**
 * Just enough colour maths to keep the loading screen readable.
 *
 * The accent colour is chosen for a brand, not for a text contrast ratio:
 * the default `#25D366` as the title on the light background is about
 * 1.9:1, and the error red `#ff4444` about 3.3:1, where WCAG asks for
 * 4.5:1 on body text and 3:1 on a graphic. The widget therefore does not
 * paint text with the accent as given — it darkens or lightens it until it
 * passes, which keeps the hue the brand asked for and the contrast the
 * reader needs (audit #30, item 5.1).
 *
 * `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()` are understood.
 * Anything else — a colour name, a custom property, a percentage form — is
 * returned untouched: a guess about an unknown colour would be worse than
 * the colour.
 */

/**
 * sRGB channels of a colour, 0-255, or `null` when it is not one this
 * understands.
 *
 * `rgb()` and `rgba()` are read as well as hex, because that is the form a
 * browser gives back for `element.style.color` — and a `--color` written
 * that way deserves the same contrast correction as a hex one.
 */
function channels(color: string): [number, number, number] | null {
  const hex = color.trim();
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(hex);
  if (rgb) {
    const parts = rgb[1]!
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map((part) => Number(part.endsWith('%') ? NaN : part));
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) {
      return null;
    }
    return [parts[0]!, parts[1]!, parts[2]!];
  }
  if (!/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
  const body = hex.slice(1);
  const short = body.length <= 4;
  const part = (i: number): number =>
    short
      ? parseInt(body[i]!.repeat(2), 16)
      : parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return [part(0), part(1), part(2)];
}

function toHex([r, g, b]: readonly [number, number, number]): string {
  const pair = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${pair(r)}${pair(g)}${pair(b)}`;
}

/**
 * Relative luminance per WCAG 2.1, or `null` for a colour that cannot be
 * read. Alpha is ignored: what is behind it is not knowable here.
 */
export function relativeLuminance(color: string): number | null {
  const rgb = channels(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Contrast ratio between two colours (1 to 21), or `null` when either
 * cannot be read.
 */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** Mix [color] toward [target] by [amount] (0-1). */
function mix(
  color: readonly [number, number, number],
  target: readonly [number, number, number],
  amount: number,
): [number, number, number] {
  return [
    color[0] + (target[0] - color[0]) * amount,
    color[1] + (target[1] - color[1]) * amount,
    color[2] + (target[2] - color[2]) * amount,
  ];
}

const BLACK: readonly [number, number, number] = [0, 0, 0];
const WHITE: readonly [number, number, number] = [255, 255, 255];

/**
 * [color] darkened or lightened until it reaches [min] contrast against
 * [background], whichever direction the background calls for.
 *
 * Returned unchanged when it already passes, when either colour cannot be
 * read, or when even black and white would not reach [min] — there is no
 * answer then, and the brand's colour is the better guess.
 */
export function ensureContrast(
  color: string,
  background: string,
  min = 4.5,
): string {
  const current = contrastRatio(color, background);
  if (current === null || current >= min) return color;
  const rgb = channels(color);
  const bgLuminance = relativeLuminance(background);
  if (!rgb || bgLuminance === null) return color;

  // Toward black on a light background, toward white on a dark one: the
  // other direction moves away from the contrast being asked for.
  const target = bgLuminance > 0.5 ? BLACK : WHITE;
  // Twenty steps is a ~5% move each, closer than a reader can tell from
  // the brand colour and cheap to walk.
  for (let step = 1; step <= 20; step++) {
    const candidate = toHex(mix(rgb, target, step / 20));
    const ratio = contrastRatio(candidate, background);
    if (ratio !== null && ratio >= min) return candidate;
  }
  return color;
}
