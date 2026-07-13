import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startDispatchServer } from './helpers.mjs';

async function pickSetupPreset(page, preset) {
  await page.select('#s-preset', preset);
  await clickFresh(page, '#s-preset-apply');
  await page.waitForFunction(() => !document.querySelector('#s-preset-apply')?.disabled);
}

async function waitForState(page, base, predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await fetch(`${base}/api/state`).then((r) => r.json());
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`timeout waiting for state: ${label}`);
}

async function assertSelectorText(page, selector, expectedIncludes) {
  const el = await page.waitForSelector(selector, { timeout: 3000 });
  const text = await el.evaluate((node) => node.textContent || '');
  assert.ok(text.toLowerCase().includes(expectedIncludes.toLowerCase()), `expected ${selector} to include ${expectedIncludes}`);
}

async function clickFresh(page, selector, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    await page.waitForSelector(selector, { timeout: 3000 });
    try {
      await page.$eval(selector, (el) => el.click());
      return;
    } catch (e) {
      const msg = String(e);
      if (i + 1 < attempts && /detached|not attached|missing/i.test(msg)) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        continue;
      }
      throw e;
    }
  }
}

function screenshotsDir() {
  return path.join(process.cwd(), 'docs', 'screenshots');
}

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

  try {
    await page.goto(harness.base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#setup-notice');
    await assertSelectorText(page, '#setup-notice', 'setup');

    // New installs should show setup required until explicitly marked complete.
    const notice = await page.$eval('#setup-notice', (el) => el.textContent || '');
    assert.ok(notice.includes('SETUP REQUIRED'), notice);

    // Open settings and confirm setup controls and status cards render.
    await clickFresh(page, '#btn-settings');
    await page.waitForSelector('.panel-head h3', { timeout: 3000 });
    const setupHeading = await page.$eval('.panel-head h3', (el) => el.textContent || '');
    assert.ok(setupHeading.includes('SETTINGS'));
    const checkboxes = await Promise.all(['#s-claude-enabled', '#s-codex-enabled'].map((id) => page.$(id)));
    for (const cb of checkboxes) assert.ok(Boolean(cb), 'provider checkbox missing');

    const state = await page.evaluate(async () => (await fetch('/api/setup/status').then((r) => r.json())));
    assert.deepEqual(state.enabledTypes.sort(), ['claude', 'codex'].sort());

    // Apply "Both" baseline then disable Codex so presets + disabled-provider warning paths are exercised.
    await pickSetupPreset(page, 'both');
    await clickFresh(page, '#s-codex-enabled');
    const codexEnabledAfterClick = await page.$eval('#s-codex-enabled', (el) => el.checked);
    assert.equal(codexEnabledAfterClick, false);
    await clickFresh(page, '#s-save');
    await page.waitForSelector('#btn-settings', { hidden: false, timeout: 3000 });

    const afterSaveState = await waitForState(page, harness.base, (s) => s.setup.providers.claude?.enabled === true && s.setup.providers.codex?.enabled === false, 'providers saved');
    assert.equal(afterSaveState.setup.providers.claude.enabled, true);
    assert.equal(afterSaveState.setup.providers.codex.enabled, false);

    // Re-open settings and check the build phase still renders a warning if a disabled provider is selected.
    await clickFresh(page, '#btn-settings');
    await page.waitForSelector('.stepper');

    await page.waitForSelector('#board .cfg[data-cfg="col-build"]', { timeout: 3000 });
    await clickFresh(page, '#board .cfg[data-cfg="col-build"]');
    await page.waitForSelector('#c-type');
    const codexOptionText = await page.$eval('select#c-type', (el) => Array.from(el.options).map((o) => `${o.value}|${o.disabled}|${o.textContent || ''}`));
    assert.ok(codexOptionText.some((row) => row.includes('codex|true|')));
    assert.ok(codexOptionText.some((row) => row.includes('claude|false|') || row.includes('claude|true|')), 'enabled replacement option missing');
    await clickFresh(page, '#modal-close');

    // Verify preset assignment updates harness defaults from API state.
    await clickFresh(page, '#btn-settings');
    await page.waitForSelector('#s-preset');
    await pickSetupPreset(page, 'claude');
    await page.waitForFunction(() => {
      const select = document.querySelector('#s-preset');
      return select && select.value === 'claude';
    });
    await clickFresh(page, '#s-save');
    await page.waitForSelector('#btn-settings', { timeout: 3000 });

    const assigned = await waitForState(page, harness.base, (s) => s.board.columns.some((c) => c.id === 'col-build' && c.harness?.type === 'claude'), 'build assigned to claude');
    assert.equal(assigned.board.columns.find((c) => c.id === 'col-planning').harness.type, 'claude');
    assert.equal(assigned.board.columns.find((c) => c.id === 'col-build').harness.type, 'claude');
    assert.equal(assigned.board.columns.find((c) => c.id === 'col-review').harness.type, 'claude');

    console.log('e2e: setup UI checks passed');
  } finally {
    await browser.close();
    await harness.cleanup();
    await fs.mkdir(screenshotsDir(), { recursive: true }).catch(() => {});
  }
})();
