#!/usr/bin/env node

/**
 * Verifies that committed Dart string constants match
 * the compiled JS artifacts from packages/sw/dist/.
 *
 * Usage: node scripts/verify-assets.mjs
 * Exit code 0 = up to date, 1 = mismatch or missing
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import {
  artifacts,
  normalizeTextForComparison,
  renderDartAsset,
} from './asset-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

let ok = true;

for (const artifact of artifacts) {
  const distPath = resolve(root, artifact.input);
  const dartPath = resolve(root, artifact.output);

  if (!existsSync(distPath)) {
    console.error(`MISSING: ${artifact.input} — run 'npm run build' first`);
    ok = false;
    continue;
  }

  if (!existsSync(dartPath)) {
    console.error(`MISSING: ${artifact.output} — run 'npm run build:all' first`);
    ok = false;
    continue;
  }

  const jsContent = readFileSync(distPath, 'utf-8');
  const actualDartContent = readFileSync(dartPath, 'utf-8');
  const expectedDartContent = renderDartAsset(artifact, jsContent);

  if (
    normalizeTextForComparison(actualDartContent) ===
    normalizeTextForComparison(expectedDartContent)
  ) {
    const hash = createHash('md5').update(jsContent).digest('hex').slice(0, 8);
    console.log(`  OK: ${artifact.input} (${hash}) matches ${artifact.output}`);
  } else {
    const distHash = createHash('md5').update(jsContent).digest('hex').slice(0, 8);
    const actualHash = createHash('md5')
      .update(normalizeTextForComparison(actualDartContent))
      .digest('hex')
      .slice(0, 8);
    console.error(`MISMATCH: ${artifact.output} does not match current ${artifact.input}`);
    console.error(`  dist hash: ${distHash}`);
    console.error(`  dart hash: ${actualHash}`);
    console.error(`  Run 'npm run build:all' to update.`);
    ok = false;
  }
}

if (ok) {
  console.log('All assets are up to date.');
} else {
  process.exit(1);
}
