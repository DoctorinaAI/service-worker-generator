#!/usr/bin/env node

/**
 * Copies compiled JS artifacts from packages/sw/dist/
 * into Dart string constants in lib/src/assets/.
 *
 * Usage: node scripts/copy-assets.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { artifacts, renderDartAsset } from './asset-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

for (const { input, output, constName, description } of artifacts) {
  const inputPath = resolve(root, input);
  const outputPath = resolve(root, output);

  if (!existsSync(inputPath)) {
    console.error(`ERROR: ${input} not found. Run 'npm run build' first.`);
    process.exit(1);
  }

  const js = readFileSync(inputPath, 'utf-8');
  const dart = renderDartAsset({ input, constName, description }, js);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, dart, 'utf-8');

  const sizeKB = (js.length / 1024).toFixed(1);
  console.log(`  ${input} (${sizeKB} KB) → ${output}`);
}

console.log('Assets copied successfully.');
