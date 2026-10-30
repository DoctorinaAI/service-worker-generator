// Draws the gallery's images and writes assets/data/gallery.json.
//
// Run from the repository root: node example/tool/generate_assets.mjs
// Needs `npm install`, Playwright's Chromium, and cwebp from libwebp.
//
// The art is generated so that the example carries no third-party licences.
// The formats and sizes are the point: PNG, JPEG and WebP all land in the
// worker's Optional category, and "static" is over the generator's 512 KB
// limit for images, so it stays out of the cache.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const example = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imagesDir = path.join(example, 'assets/images');
const galleryFile = path.join(example, 'assets/data/gallery.json');

const SCENES = [
  { file: 'aurora.webp', title: 'Aurora', draw: 'aurora', width: 1280, height: 860 },
  { file: 'dunes.webp', title: 'Dunes', draw: 'dunes', width: 1280, height: 860 },
  { file: 'orbits.webp', title: 'Orbits', draw: 'orbits', width: 1280, height: 860 },
  { file: 'mosaic.webp', title: 'Mosaic', draw: 'mosaic', width: 1280, height: 860 },
  { file: 'bloom.webp', title: 'Bloom', draw: 'bloom', width: 1280, height: 860 },
  { file: 'tides.webp', title: 'Tides', draw: 'tides', width: 1280, height: 860 },
  { file: 'ridge.png', title: 'Ridge', draw: 'ridge', width: 800, height: 540 },
  { file: 'dusk.jpg', title: 'Dusk', draw: 'dunes', width: 1280, height: 860, seed: 11 },
  { file: 'static.webp', title: 'Static', draw: 'grain', width: 1400, height: 940 },
];

/** Runs in the page. One function per scene, each from a seeded generator. */
function drawScene({ draw, width: w, height: h, seed }) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  document.body.append(canvas);
  const c = canvas.getContext('2d');
  let state = seed;
  const rnd = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const sky = (...stops) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    stops.forEach((color, i) => g.addColorStop(i / (stops.length - 1), color));
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  };
  const hills = (base, amp, color) => {
    const [a, b, p] = [rnd() * 6, rnd() * 6, 1.5 + rnd() * 2];
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(0, h);
    for (let x = 0; x <= w; x += 4) {
      const t = x / w;
      c.lineTo(x, base + Math.sin(t * p * 3.1 + a) * amp + Math.sin(t * p * 7 + b) * amp * 0.35);
    }
    c.lineTo(w, h);
    c.fill();
  };
  const scenes = {
    aurora() {
      sky('#04121f', '#0a2a3f', '#0d3b3a');
      c.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 14; i++) {
        const y = h * (0.15 + rnd() * 0.45);
        const hue = 130 + rnd() * 70;
        const g = c.createLinearGradient(0, y - 150, 0, y + 220);
        g.addColorStop(0, `hsla(${hue},90%,60%,0)`);
        g.addColorStop(0.5, `hsla(${hue},90%,60%,.08)`);
        g.addColorStop(1, `hsla(${hue},90%,60%,0)`);
        c.fillStyle = g;
        const [a, p] = [rnd() * 6, 1 + rnd() * 2];
        c.beginPath();
        c.moveTo(0, y + 220);
        for (let x = 0; x <= w; x += 8) c.lineTo(x, y + Math.sin((x / w) * p * 6 + a) * 70);
        c.lineTo(w, y + 220);
        c.fill();
      }
    },
    dunes() {
      sky('#2b1055', '#d53369', '#ffb56b');
      c.fillStyle = 'rgba(255,240,200,.9)';
      c.beginPath();
      c.arc(w * (0.25 + rnd() * 0.5), h * 0.42, h * 0.09, 0, 7);
      c.fill();
      ['#8f2d56', '#6a1f4d', '#451845', '#2a1035'].forEach((color, i) =>
        hills(h * (0.55 + i * 0.1), 44 - i * 6, color),
      );
    },
    orbits() {
      sky('#0b1026', '#141a3c');
      c.translate(w / 2, h / 2);
      for (let i = 0; i < 70; i++) {
        c.strokeStyle = `hsla(${190 + i * 2},85%,${45 + i / 3}%,.5)`;
        c.lineWidth = 1 + rnd() * 2;
        c.beginPath();
        c.ellipse(0, 0, 40 + i * 8, 20 + i * 4, rnd() * 3.14, 0, 7);
        c.stroke();
      }
      for (let i = 0; i < 90; i++) {
        c.fillStyle = `hsla(${170 + rnd() * 80},90%,75%,.9)`;
        c.beginPath();
        const [a, r] = [rnd() * 6.28, rnd() * h * 0.7];
        c.arc(Math.cos(a) * r, Math.sin(a) * r, 1 + rnd() * 4, 0, 7);
        c.fill();
      }
    },
    mosaic() {
      const size = 86;
      for (let y = -1; y * size < h + size; y++) {
        for (let x = -1; x * size < w + size; x++) {
          const l = 22 + (x / (w / size)) * 26 + rnd() * 14;
          const hue = 150 + (y / (h / size)) * 50;
          const flip = rnd() > 0.5;
          const [x0, y0, s] = [x * size, y * size, size + 1];
          c.fillStyle = `hsl(${hue},62%,${l}%)`;
          c.fillRect(x0, y0, s, s);
          c.fillStyle = `hsl(${hue + 18},68%,${l + 10}%)`;
          c.beginPath();
          c.moveTo(x0, y0);
          c.lineTo(x0 + s, flip ? y0 : y0 + s);
          c.lineTo(flip ? x0 + s : x0, y0 + s);
          c.fill();
        }
      }
    },
    bloom() {
      sky('#1b0a2a', '#32123f');
      c.translate(w / 2, h / 2);
      c.globalCompositeOperation = 'lighter';
      for (let ring = 7; ring > 0; ring--) {
        const petals = 8 + ring * 3;
        for (let i = 0; i < petals; i++) {
          c.rotate((Math.PI * 2) / petals);
          c.fillStyle = `hsla(${300 + ring * 14},85%,62%,.13)`;
          c.beginPath();
          c.ellipse(ring * 44, 0, ring * 34, ring * 11, 0, 0, 7);
          c.fill();
        }
      }
    },
    tides() {
      sky('#03263b', '#0a5c6e', '#25d366');
      for (let i = 0; i < 46; i++) {
        const y = (h / 46) * i;
        const [a, p] = [rnd() * 6, 2 + rnd() * 3];
        c.strokeStyle = `rgba(220,255,240,${0.08 + (i / 46) * 0.35})`;
        c.lineWidth = 1 + (i / 46) * 3;
        c.beginPath();
        for (let x = 0; x <= w; x += 6) {
          c.lineTo(x, y + Math.sin((x / w) * p * 6 + a) * (8 + i));
        }
        c.stroke();
      }
    },
    ridge() {
      sky('#fbe3c0', '#f4a88a');
      ['#c98b7c', '#8e6a78', '#574a68', '#2e2a4a'].forEach((color, i) =>
        hills(h * (0.42 + i * 0.14), 58 - i * 8, color),
      );
    },
    grain() {
      const image = c.createImageData(w, h);
      for (let i = 0; i < image.data.length; i += 4) {
        const y = i / 4 / w / h;
        const v = 40 + rnd() * 180;
        image.data[i] = v * 0.45;
        image.data[i + 1] = v * (0.5 + y * 0.5);
        image.data[i + 2] = v * 0.7;
        image.data[i + 3] = 255;
      }
      c.putImageData(image, 0, 0);
    },
  };
  scenes[draw]();
}

fs.mkdirSync(path.dirname(galleryFile), { recursive: true });
const browser = await chromium.launch();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-example-assets-'));
for (const [index, scene] of SCENES.entries()) {
  const page = await browser.newPage({ viewport: { width: scene.width, height: scene.height } });
  await page.setContent('<!doctype html><style>*{margin:0}canvas{display:block}</style>');
  await page.evaluate(drawScene, { seed: 7 + index * 31, ...scene });
  const out = path.join(imagesDir, scene.file);
  if (scene.file.endsWith('.webp')) {
    const png = path.join(work, `${index}.png`);
    await page.screenshot({ path: png });
    const quality = '80';
    execFileSync('cwebp', ['-quiet', '-q', quality, png, '-o', out]);
  } else {
    const type = scene.file.endsWith('.png') ? 'png' : 'jpeg';
    await page.screenshot({ path: out, type, ...(type === 'jpeg' ? { quality: 80 } : {}) });
  }
  await page.close();
}
await browser.close();
fs.rmSync(work, { recursive: true, force: true });

const titles = new Map(SCENES.map((scene) => [scene.file, scene.title]));
const generated = SCENES.map((scene) => scene.file);
// The soft-focus photos were here before; they follow the generated art.
const others = fs.readdirSync(imagesDir).filter((f) => !titles.has(f) && !f.startsWith('.')).sort();
let softFocus = 0;
const gallery = [...generated, ...others].map((file) => ({
  asset: `assets/images/${file}`,
  title: titles.get(file) ?? `Soft focus ${++softFocus}`,
  bytes: fs.statSync(path.join(imagesDir, file)).size,
}));
fs.writeFileSync(galleryFile, `${JSON.stringify(gallery, null, 2)}\n`);
for (const item of gallery) console.log(`${String(item.bytes).padStart(9)}  ${item.asset}`);
