import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { startDispatchServer } from './helpers.mjs';

// Clicking a provider in the usage strip re-probes that provider on demand instead of
// waiting out the server's 5-minute poll. The probes themselves can't produce real
// windows under the harness (no OAuth token, fake codex bin) — what matters here is that
// the click is wired, scoped to one provider, guarded while in flight, and always settles.
(async () => {
  const harness = await startDispatchServer({
    claudeAuth: true,
    codexAuth: true,
    claudeVersion: 'claude 1.0.0',
    codexVersion: 'codex 1.2.3',
    codexStatusText: 'You are logged in as test@example.com',
  });
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);

  const posts = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/usage/refresh')) posts.push(JSON.parse(req.postData() || '{}'));
  });

  try {
    await page.goto(harness.base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-usage-refresh="claude"]');

    // Both providers are click targets and start idle.
    for (const p of ['claude', 'codex']) {
      assert.equal(await page.$eval(`[data-usage-refresh="${p}"]`, (el) => el.getAttribute('aria-busy')), 'false', `${p} starts idle`);
    }

    // A click refreshes only the provider clicked, and marks it busy while in flight.
    await page.$eval('[data-usage-refresh="claude"]', (el) => el.click());
    await page.waitForFunction(() => document.querySelector('[data-usage-refresh="claude"]')?.classList.contains('refreshing'));
    assert.ok(
      !(await page.$eval('[data-usage-refresh="codex"]', (el) => el.classList.contains('refreshing'))),
      'refreshing one provider leaves the other alone',
    );
    await page.waitForFunction(() => !document.querySelector('[data-usage-refresh="claude"]')?.classList.contains('refreshing'));
    assert.deepEqual(posts, [{ provider: 'claude' }], 'one click sends one claude-scoped refresh');
    assert.equal(await page.$eval('[data-usage-refresh="claude"]', (el) => el.getAttribute('aria-busy')), 'false', 'busy state clears');

    // Re-probing stays available after a refresh settles, and the strip still renders.
    assert.ok(await page.$eval('[data-usage-refresh="claude"] .usage-name', (el) => el.textContent.trim().length), 'provider name still rendered');

    // Rapid clicks collapse into a single probe while one is already in flight. The node is
    // re-queried per click: the first click re-renders the strip, and clicking the detached
    // node would silently no-op and make this assertion vacuous.
    posts.length = 0;
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++) document.querySelector('[data-usage-refresh="codex"]').click();
    });
    await page.waitForFunction(() => !document.querySelector('[data-usage-refresh="codex"]')?.classList.contains('refreshing'));
    assert.deepEqual(posts, [{ provider: 'codex' }], 'in-flight guard collapses rapid clicks into one probe');

    // Keyboard users get the same affordance.
    posts.length = 0;
    await page.focus('[data-usage-refresh="codex"]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('[data-usage-refresh="codex"]')?.classList.contains('refreshing'));
    assert.deepEqual(posts, [{ provider: 'codex' }], 'Enter refreshes the focused provider');

    console.log('e2e: usage refresh checks passed');
  } finally {
    await browser.close();
    await harness.cleanup();
  }
})();
