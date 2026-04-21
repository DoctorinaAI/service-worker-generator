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

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const artifacts = [
  { dist: 'packages/sw/dist/sw.js', dart: 'lib/src/assets/sw_template.dart' },
  {
    dist: 'packages/sw/dist/bootstrap.js',
    dart: 'lib/src/assets/bootstrap_template.dart',
  },
];

let ok = true;

for (const { dist, dart } of artifacts) {
  const distPath = resolve(root, dist);
  const dartPath = resolve(root, dart);

  if (!existsSync(distPath)) {
    console.error(`MISSING: ${dist} — run 'npm run build' first`);
    ok = false;
    continue;
  }

  if (!existsSync(dartPath)) {
    console.error(`MISSING: ${dart} — run 'npm run build:all' first`);
    ok = false;
    continue;
  }

  const jsContent = readFileSync(distPath, 'utf-8');
  const dartContent = readFileSync(dartPath, 'utf-8');

  // Check that the Dart file contains the JS content
  if (dartContent.includes(jsContent.trim())) {
    const hash = createHash('md5').update(jsContent).digest('hex').slice(0, 8);
    console.log(`  OK: ${dist} (${hash}) matches ${dart}`);
  } else {
    console.error(`MISMATCH: ${dart} does not contain current ${dist}`);
    console.error(`  Run 'npm run build:all' to update.`);
    ok = false;
  }
}

if (ok) {
  console.log('All assets are up to date.');
} else {
  process.exit(1);
}
