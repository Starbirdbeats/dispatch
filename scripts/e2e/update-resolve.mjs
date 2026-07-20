import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startDispatchServer } from './helpers.mjs';

// The [ UPDATE ] flow when the Dispatch checkout itself is dirty: the server answers
// 409 { code: 'dirty-tree' } and the client must offer stash/discard choices instead
// of a dead-end error toast. Drives the dialog with fixture data and a stubbed
// /api/update/apply — the git strategies themselves are unit-tested in
// test/update-status.test.mjs.

const FIXTURE = {
  error: 'working tree has uncommitted changes — commit or stash first',
  code: 'dirty-tree',
  root: '/home/Starbird/git/dispatch',
  branch: 'main',
  changeCount: 7,
  changes: [
    { code: ' M', path: 'server.mjs' },
    { code: ' M', path: 'public/app.js' },
    { code: ' M', path: 'public/dispatch.css' },
    { code: '??', path: 'scripts/e2e/atomic-buttons.mjs' },
    { code: '??', path: 'scripts/e2e/wake-now.mjs' },
  ],
};

const shot = (name) => path.join(os.tmpdir(), name);

(async () => {
  const harness = await startDispatchServer({ claudeAuth: true, codexAuth: false });
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(harness.base, { waitUntil: 'networkidle0' });

    // 1. Open the dialog with fixture data, as the 409 handler would.
    await page.evaluate((data) => openUpdateResolve(data), FIXTURE);
    await page.waitForSelector('#update-resolve-overlay');
    const labels = await page.$$eval('[data-update-strategy]', (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(labels, ['[ STASH & UPDATE ]', '[ DISCARD & UPDATE ]']);
    const fileRows = await page.$$eval('#update-resolve-overlay .workspace-resolve-change', (els) => els.length);
    assert.equal(fileRows, 5);
    const more = await page.$eval('#update-resolve-overlay .workspace-resolve-more', (el) => el.textContent.trim());
    assert.equal(more, '+ 2 more change(s)');
    await page.screenshot({ path: shot('update-resolve-desktop.png') });

    // 2. STASH click → POST with strategy; stub fetch to answer with a fresh 409 →
    //    dialog must re-render in place with the error and the new change list.
    await page.evaluate(() => {
      window.__posts = [];
      const orig = window.fetch;
      window.fetch = async (url, opts = {}) => {
        if (String(url).includes('/api/update/apply')) {
          window.__posts.push(JSON.parse(opts.body || '{}'));
          return new Response(JSON.stringify({
            error: 'working tree has uncommitted changes — commit or stash first',
            code: 'dirty-tree', root: '/home/Starbird/git/dispatch', branch: 'main',
            changeCount: 1, changes: [{ code: ' M', path: 'README.md' }],
          }), { status: 409, headers: { 'content-type': 'application/json' } });
        }
        return orig(url, opts);
      };
    });
    await page.click('[data-update-strategy="stash"]');
    await page.waitForSelector('#update-resolve-overlay .workspace-resolve-error');
    const posts = await page.evaluate(() => window.__posts);
    assert.deepEqual(posts, [{ strategy: 'stash' }]);
    const rowsAfter = await page.$$eval('#update-resolve-overlay .workspace-resolve-change', (els) => els.map((e) => e.textContent));
    assert.equal(rowsAfter.length, 1, 'change list must refresh from the new 409 body');
    assert.ok(rowsAfter[0].includes('README.md'));
    await page.screenshot({ path: shot('update-resolve-error.png') });

    // 3. DISCARD is confirm-gated: dismissing the confirm must not fire the POST.
    await page.evaluate(() => { window.confirm = () => false; });
    await page.click('[data-update-strategy="discard"]');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await page.evaluate(() => window.__posts)).length, 1, 'declined confirm must not POST');

    // 4. Accepted confirm fires strategy: 'discard'.
    await page.evaluate(() => { window.confirm = () => true; });
    await page.click('[data-update-strategy="discard"]');
    await page.waitForFunction(() => window.__posts.length === 2);
    assert.deepEqual((await page.evaluate(() => window.__posts))[1], { strategy: 'discard' });
    // Wait for the apply to settle (buttons re-enable) — Escape is ignored mid-apply.
    await page.waitForFunction(() => document.querySelector('[data-update-strategy]:not([disabled])'));

    // 5. Escape closes the dialog.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#update-resolve-overlay'));

    // 6. Mobile layout.
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate((data) => openUpdateResolve(data), FIXTURE);
    await page.waitForSelector('#update-resolve-overlay');
    await page.screenshot({ path: shot('update-resolve-mobile.png') });

    console.log(`update-resolve UI verification passed — screenshots in ${os.tmpdir()}`);
  } finally {
    await browser.close();
    await harness.cleanup();
  }
})();
