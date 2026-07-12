import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { startDispatchServer } from './helpers.mjs';

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

async function clickCardByTitle(page, title) {
  await page.evaluate((title) => {
    const el = [...document.querySelectorAll('.card .title')].find((n) => n.textContent === title);
    (el?.closest('.card'))?.click();
  }, title);
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

  const hash = () => page.evaluate(() => location.hash);

  try {
    const ticket = await fetch(`${harness.base}/api/tickets`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Routing test ticket', workspace: harness.root }),
    }).then((r) => r.json());

    await page.goto(harness.base, { waitUntil: 'networkidle2' });
    assert.equal(await hash(), '', 'boots with an empty hash on a plain load');

    // Opening a ticket pushes its bare id into the hash — matches the links notify.mjs
    // already sends over Telegram, so old notifications keep working.
    await clickCardByTitle(page, 'Routing test ticket');
    await page.waitForSelector('.tabs [data-tab="activity"]');
    assert.equal(await hash(), `#${ticket.id}`, 'ticket hash uses the bare-id convention');

    // Switching tabs inside the open modal replaces the hash entry rather than pushing —
    // otherwise Back would need one press per tab click to actually leave the ticket.
    const lengthBeforeTabSwitch = await page.evaluate(() => history.length);
    await clickFresh(page, '.tabs [data-tab="activity"]');
    assert.equal(await hash(), `#${ticket.id}/activity`, 'tab switch updates the hash');
    assert.equal(await page.evaluate(() => history.length), lengthBeforeTabSwitch, 'tab switch does not grow history');

    // Hard refresh must restore the exact modal + tab from the URL alone.
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('.tabs button.active');
    assert.equal(await hash(), `#${ticket.id}/activity`, 'hash survives a hard refresh');
    assert.equal(await page.$eval('.tabs button.active', (e) => e.dataset.tab), 'activity', 'correct tab re-opens after refresh');
    assert.ok(await page.$('#overlay'), 'modal is actually rendered after refresh, not just reflected in the hash');

    // Back from a page that *loaded* straight into a modal (the common case for a
    // shared/bookmarked/Telegram link) must land on the board, never bounce out of
    // the app — this is the floor entry initHistoryFromLocation() guarantees.
    await page.goBack({ waitUntil: 'networkidle2' }).catch(() => {});
    await page.waitForFunction(() => !document.querySelector('#overlay'));
    assert.equal(await hash(), '', 'Back from a reloaded deep link lands on the board');
    assert.ok(page.url().startsWith(harness.base), 'Back kept us inside the app');

    await page.goForward({ waitUntil: 'networkidle2' });
    await page.waitForSelector('#overlay');
    assert.equal(await hash(), `#${ticket.id}/activity`, 'Forward restores the modal + tab');

    // Settings tabs follow the same contract, including the default-tab hash omission.
    await clickFresh(page, '#modal-close');
    await page.waitForFunction(() => !document.querySelector('#overlay'));
    await clickFresh(page, '#btn-settings');
    await page.waitForSelector('.tabs [data-tab="environment"]');
    assert.equal(await hash(), '#settings', 'default settings tab omits the /engine suffix');
    await clickFresh(page, '.tabs [data-tab="environment"]');
    assert.equal(await hash(), '#settings/environment', 'non-default settings tab is in the hash');
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('.s-pane[data-pane="environment"].active');
    assert.equal(await page.$eval('.tabs button.active', (e) => e.dataset.tab), 'environment', 'settings tab survives a hard refresh');

    // Opening a different modal (here: a ticket from inside the archive list) is a
    // distinct push, not a replace — Back should peel back to the archive, not the board.
    await clickFresh(page, '#modal-close');
    await page.waitForFunction(() => !document.querySelector('#overlay'));
    const state = await fetch(`${harness.base}/api/state`).then((r) => r.json());
    const terminalCol = state.board.columns.find((c) => c.role === 'terminal');
    await fetch(`${harness.base}/api/tickets/${ticket.id}/move`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ columnId: terminalCol.id }),
    });
    await fetch(`${harness.base}/api/tickets/${ticket.id}/archive`, { method: 'POST' });
    await page.reload({ waitUntil: 'networkidle2' });
    await clickFresh(page, '#btn-archive');
    await page.waitForSelector('.arch-item');
    assert.equal(await hash(), '#archive', 'archive modal hash');
    await clickFresh(page, `[data-open="${ticket.id}"]`);
    await page.waitForSelector('.tabs [data-tab="overview"]');
    assert.equal(await hash(), `#${ticket.id}`, 'opening a ticket from the archive pushes a new identity');
    await page.goBack({ waitUntil: 'networkidle2' });
    await page.waitForSelector('.arch-item');
    assert.equal(await hash(), '#archive', 'Back from the ticket returns to the archive modal, not the board');

    // A deep link to a ticket that no longer exists must fail soft: toast, clear the
    // hash, and never leave a dangling/broken modal on screen.
    await page.goto(`${harness.base}#t-doesnotexist`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => document.querySelector('#toast')?.classList.contains('show'));
    const toastText = await page.$eval('#toast', (e) => e.textContent || '');
    assert.match(toastText, /NOT FOUND/, 'missing ticket surfaces a toast');
    assert.equal(await hash(), '', 'hash is cleared for a dead deep link');
    assert.ok(!(await page.$('#overlay')), 'no modal is shown for a dead deep link');

    // Column config modal round-trips the same way.
    const colId = await page.$eval('.cfg', (el) => el.dataset.cfg);
    await clickFresh(page, '.cfg');
    await page.waitForSelector('#overlay');
    assert.equal(await hash(), `#column/${colId}`, 'column hash');
    await page.reload({ waitUntil: 'networkidle2' });
    assert.ok(await page.$('#overlay'), 'column modal reopens after a hard refresh');

    console.log('e2e: url routing checks passed');
  } finally {
    await browser.close();
    await harness.cleanup();
  }
})();
