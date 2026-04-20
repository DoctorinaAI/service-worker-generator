import type { BuildConfig } from '../shared/types';

const STYLE_HEADER = 'color: #25D366; font-weight: bold; font-size: 14px;';
const STYLE_LABEL = 'color: #888; font-weight: normal;';
const STYLE_VALUE = 'color: #fff; font-weight: bold;';
const STYLE_PHASE = 'color: #25D366; font-weight: bold;';
const STYLE_INFO = 'color: #aaa;';

/**
 * Print a styled version banner to the console.
 */
export function logVersionBanner(buildConfig: BuildConfig): void {
  const renderer =
    buildConfig.builds.find((b) => b.renderer)?.renderer ?? 'unknown';
  const target =
    buildConfig.builds.find((b) => b.compileTarget)?.compileTarget ?? 'unknown';

  console.log(
    '%c\u250C\u2500 Service Worker Bootstrap %c\n' +
      '%cEngine:   %c%s%c\n' +
      '%cSW:      %c%s%c\n' +
      '%cRenderer: %c%s%c\n' +
      '%cTarget:   %c%s%c\n' +
      '%c\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
    STYLE_HEADER,
    '',
    STYLE_LABEL,
    STYLE_VALUE,
    buildConfig.engineRevision.slice(0, 10) + '...',
    '',
    STYLE_LABEL,
    STYLE_VALUE,
    buildConfig.swVersion,
    '',
    STYLE_LABEL,
    STYLE_VALUE,
    renderer,
    '',
    STYLE_LABEL,
    STYLE_VALUE,
    target,
    '',
    STYLE_HEADER,
  );
}

/**
 * Log a pipeline phase transition.
 */
export function logPhase(phase: string, message: string): void {
  console.log(`%c[${phase}]%c ${message}`, STYLE_PHASE, STYLE_INFO);
}

/**
 * Log progress update.
 */
export function logProgress(percent: number, message: string): void {
  const bar = progressBar(percent, 20);
  console.log(
    `%c${bar} ${Math.round(percent)}%%%c ${message}`,
    STYLE_PHASE,
    STYLE_INFO,
  );
}

function progressBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}
