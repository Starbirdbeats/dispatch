import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { startDispatchServer } from './helpers.mjs';

// Drives the NEW TICKET modal end-to-end and asserts each stage of the create
// animation (terminal drawer -> log lines -> collapse -> receipt -> stamp) fires,
// and that the ticket actually lands on the board.

(async () => {
  const harness = await startDispatchServer({ claudeAuth: true, codexAuth: true });
  // Workspace validation requires a clean git repo — build one in a temp dir.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-ws-'));
  const git = (...a) => execFileSync('git', ['-C', ws, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@test', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@test' } });
  git('init');
  fs.writeFileSync(path.join(ws, 'README.md'), 'anim ws\n');
  git('add', '.');
  git('commit', '-m', 'init');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => { console.error('PAGE ERROR:', e.message); process.exitCode = 1; });

  try {
    // Pause the engine so the created ticket doesn't auto-start a run.
    await fetch(`${harness.base}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxConcurrent: 0 }),
    });

    await page.goto(harness.base, { waitUntil: 'networkidle0' });
    await page.click('#btn-new');
    await page.waitForSelector('#n-title');
    await page.type('#n-title', 'Animation verify');
    await page.evaluate((ws) => { document.querySelector('#n-ws').value = ws; }, ws);

    // Click via JS: the update FAB (z-index 3000) can cover the button in this viewport
    // and would swallow a coordinate-based click.
    await page.evaluate(() => document.querySelector('#n-create').click());

    // Stage 1: terminal drawer opens and types the command.
    await page.waitForSelector('.create-terminal.is-open');
    await page.waitForFunction(() =>
      document.querySelector('.create-terminal-typed')?.textContent.includes('dispatch ticket create'));
    console.log('ok: terminal drawer + typed command');

    // Stage 2: log lines appear, then the success line.
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.create-terminal-line')].some((l) => l.textContent.includes('title')));
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.create-terminal-line.tone-ok')].some((l) => l.textContent.includes('created')));
    console.log('ok: log lines + created confirmation');

    // Stage 3: panel collapses, receipt prints, stamp lands.
    await page.waitForSelector('.new-ticket-panel.is-create-collapsing');
    await page.waitForSelector('.new-create-receipt.is-printing');
    await page.waitForSelector('.new-create-receipt.is-stamped');
    const stamp = await page.$eval('.receipt-stamp', (el) => el.textContent.trim());
    assert.equal(stamp, 'CREATED');
    console.log('ok: collapse -> receipt -> CREATED stamp');

    // Stage 4: modal closes and the ticket is on the board.
    await page.waitForFunction(() => !document.querySelector('.new-create-receipt'));
    const st = await (await fetch(`${harness.base}/api/state`)).json();
    const t = st.tickets.find((x) => x.title === 'Animation verify');
    assert.ok(t, 'ticket should exist after animation');
    console.log(`ok: ticket landed (${t.id})`);

    console.log('PASS: create animation verified end-to-end');
  } finally {
    await browser.close();
    await harness.cleanup();
  }
})();
