import path from 'node:path';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { startDispatchServer } from './helpers.mjs';

function screenshotDir() {
  return path.join(process.cwd(), 'docs', 'screenshots');
}

async function capture(page, fileName) {
  const out = path.join(screenshotDir(), fileName);
  await page.screenshot({ path: out, fullPage: false });
  return out;
}

async function withServer(fn) {
  const harness = await startDispatchServer({
    claudeAuth: true,
    codexAuth: true,
    codexStatusText: 'You are logged in as test@example.com',
  });
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.setViewport({ width: 1440, height: 960 });
  page.setDefaultTimeout(10000);

  try {
    await page.goto(harness.base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#btn-settings');
    await fn({ page, base: harness.base });
  } finally {
    await browser.close();
    await harness.cleanup();
  }
}

(async () => {
  await fs.mkdir(screenshotDir(), { recursive: true });
  const outputs = [];
  await withServer(async ({ page }) => {
    await page.waitForSelector('#board');
    outputs.push(await capture(page, 'board-overview.png'));

    await page.click('#btn-settings');
    await page.waitForSelector('.panel-head h3');
    outputs.push(await capture(page, 'setup-provider-cards.png'));

    await page.select('#s-preset', 'claude');
    await page.click('#s-preset-apply');
    await page.waitForFunction(() => {
      const select = document.querySelector('#s-preset');
      return select && select.value === 'claude';
    });
    outputs.push(await capture(page, 'setup-preset-claude-only.png'));

    await page.click('#s-claude-enabled');
    await page.click('#s-codex-enabled');
    await page.click('#s-save');
    await page.waitForFunction(() => !document.querySelector('#overlay'));
    outputs.push(await capture(page, 'setup-auth-toggle-example.png'));
  });

  console.log('captured screenshots:');
  for (const out of outputs) console.log(out);
})( ).catch((e) => {
  console.error(e);
  process.exit(1);
});
