import { expect, test, type Page } from '@playwright/test';

const BASE_URL = 'http://localhost:8089';
const COUNTER = /Loaded (\d+) of (\d+) resources/;
const TERMINAL = new Set(['completed', 'cached', 'updated']);

interface ProgressMessage {
  resourceKey: string;
  resourcesCount: number;
  status: string;
  counted?: boolean;
  swVersion?: string;
}

declare global {
  interface Window {
    __swProgress?: ProgressMessage[];
  }
}

/**
 * Record every `sw-progress` message the page receives, installed before
 * bootstrap.js runs. The rendered counter only exists while the loading
 * overlay is up, so watching console output alone would stop looking exactly
 * when the fetch handler starts serving lazily-cached resources.
 */
async function recordProgress(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__swProgress = [];
    navigator.serviceWorker?.addEventListener('message', (event) => {
      const data = (event as MessageEvent).data;
      if (data?.type === 'sw-progress') window.__swProgress!.push(data);
    });
  });
}

async function progressMessages(page: Page): Promise<ProgressMessage[]> {
  return page.evaluate(() => window.__swProgress ?? []);
}

/** Counter lines printed by the loading overlay, in order. */
function watchCounter(page: Page): Array<{ done: number; total: number }> {
  const samples: Array<{ done: number; total: number }> = [];
  page.on('console', (msg) => {
    const m = COUNTER.exec(msg.text());
    if (m) samples.push({ done: Number(m[1]), total: Number(m[2]) });
  });
  return samples;
}

async function clearSiteData(page: Page): Promise<void> {
  await page.goto(BASE_URL);
  await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
  });
}

/**
 * The numerator the bootstrap accumulates — distinct counted resources that
 * reached a terminal status — must never leave the counted set.
 */
function assertCounterHolds(messages: ProgressMessage[]): void {
  expect(messages.length, 'the SW should report something').toBeGreaterThan(0);

  const totals = new Set(
    messages.map((m) => m.resourcesCount).filter((n) => n > 0),
  );
  expect([...totals], 'the denominator must not change mid-load').toHaveLength(1);
  const total = [...totals][0]!;

  // Accumulate exactly as a client following the message contract does:
  // distinct keys that reached a terminal status and belong to the counted
  // set. `counted ?? true` is what a client had to assume before the flag
  // existed, and it is what made the numerator run past its own total.
  const counted = new Set(
    messages
      .filter((m) => (m.counted ?? true) && TERMINAL.has(m.status) && m.resourceKey)
      .map((m) => m.resourceKey),
  );
  expect(
    counted.size,
    `counted [${[...counted].join(', ')}] against a total of ${total}`,
  ).toBeLessThanOrEqual(total);
}

test.describe('startup progress counter', () => {
  test('cold load never counts past its total', async ({ page }) => {
    await clearSiteData(page);
    await recordProgress(page);
    const counter = watchCounter(page);

    await page.goto(BASE_URL);
    await page.waitForTimeout(6000);

    assertCounterHolds(await progressMessages(page));
    expect(counter.filter((s) => s.done > s.total)).toEqual([]);
  });

  test('warm load never counts past its total', async ({ page }) => {
    await clearSiteData(page);
    await page.goto(BASE_URL);
    await page.waitForTimeout(6000);

    await recordProgress(page);
    const counter = watchCounter(page);
    await page.reload();
    await page.waitForTimeout(6000);

    assertCounterHolds(await progressMessages(page));
    expect(counter.filter((s) => s.done > s.total)).toEqual([]);
  });

  test('five consecutive cold loads never overflow', async ({ page }) => {
    const counter = watchCounter(page);
    for (let run = 0; run < 5; run++) {
      await clearSiteData(page);
      await recordProgress(page);
      await page.goto(BASE_URL);
      await page.waitForTimeout(4000);
      assertCounterHolds(await progressMessages(page));
    }
    expect(counter.filter((s) => s.done > s.total)).toEqual([]);
  });
});
