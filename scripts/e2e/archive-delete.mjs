import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { startDispatchServer } from './helpers.mjs';

async function api(base, path, method = 'GET', body = null) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function state(base) {
  return api(base, '/api/state');
}

async function confirmText(page) {
  return page.$eval('#confirm-root', (el) => el.textContent);
}

async function assertConfirmButtonOneLine(page, selector, label) {
  const metrics = await page.$eval(selector, (btn) => {
    const text = btn.querySelector('.confirm-button-text') || btn;
    const range = document.createRange();
    range.selectNodeContents(text);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    return {
      text: text.textContent.trim(),
      whiteSpace: getComputedStyle(btn).whiteSpace,
      scrollWidth: btn.scrollWidth,
      clientWidth: btn.clientWidth,
      lineCount: rects.length,
    };
  });
  assert.equal(metrics.whiteSpace, 'nowrap', `${label} button forbids wrapping`);
  assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `${label} button text fits in one line: ${JSON.stringify(metrics)}`);
  assert.equal(metrics.lineCount, 1, `${label} button text renders as one line: ${JSON.stringify(metrics)}`);
}

async function assertConfirmButtonsOneLine(page) {
  await assertConfirmButtonOneLine(page, '#confirm-cancel', 'cancel');
  await assertConfirmButtonOneLine(page, '#confirm-ok', 'action');
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
  const dialogs = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => { console.error('PAGE ERROR:', e.message); process.exitCode = 1; });
  page.on('dialog', async (d) => {
    dialogs.push(d.message());
    await d.dismiss().catch(() => {});
  });

  try {
    await api(harness.base, '/api/settings', 'PATCH', { maxConcurrent: 0 });
    const initial = await state(harness.base);
    const columns = [...initial.board.columns].sort((a, b) => a.order - b.order);
    const done = columns.find((c) => c.role === 'terminal');
    assert.ok(done, 'test board has a terminal column');

    const tickets = [];
    for (const col of columns) {
      tickets.push(await api(harness.base, '/api/tickets', 'POST', {
        title: `Archive controls ${col.name}`,
        workspace: harness.root,
        columnId: col.id,
      }));
    }

    await page.setViewport({ width: 1440, height: 960 });
    await page.goto(harness.base, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.rail');

    assert.notEqual(
      await page.$eval('#btn-archive', (el) => getComputedStyle(el).display),
      'none',
      'desktop archive button is visible',
    );
    assert.equal(await page.$$eval('.station .chip [data-ticket-archive]', (els) => els.length), columns.length, 'desktop chips expose archive actions');
    assert.equal(await page.$$eval('.station .chip [data-ticket-delete]', (els) => els.length), columns.length, 'desktop chips expose delete actions');

    const backlogTicket = tickets.find((t) => columns.find((c) => c.id === t.columnId)?.role !== 'terminal');
    await page.$eval(`[data-ticket-archive="${backlogTicket.id}"]`, (el) => el.click());
    await page.waitForSelector('#confirm-overlay');
    const archiveConfirm = await confirmText(page);
    assert.match(archiveConfirm, /ARE YOU SURE\?/i, 'reference eyebrow is present');
    assert.match(archiveConfirm, /Archive ticket\?/i, 'archive confirmation title');
    assert.match(archiveConfirm, /Restore from \[ ARCHIVE \]/i, 'archive confirmation explains where to restore tickets');
    assert.equal(await page.$$eval('.confirm-meta-row', (els) => els.length), 3, 'reference metadata panel has ticket/title/board rows');
    assert.ok(await page.$('.confirm-callout'), 'reference red callout is rendered');
    assert.ok(await page.$('.confirm-disable'), 'modal disable row is rendered');
    assert.equal(
      await page.$eval('.confirm-panel', (el) => getComputedStyle(el).backgroundColor),
      'rgb(233, 226, 206)',
      'confirmation panel uses warm paper reference color',
    );
    await assertConfirmButtonsOneLine(page);
    const metaFits = await page.$$eval('.confirm-meta-value', (els) => els.every((el) => el.scrollWidth <= el.clientWidth + 1));
    assert.ok(metaFits, 'metadata values stay on one line');
    await page.$eval('#confirm-cancel', (el) => el.click());
    await page.waitForSelector('#confirm-overlay', { hidden: true });
    assert.equal(Boolean((await state(harness.base)).tickets.find((t) => t.id === backlogTicket.id)?.archived), false, 'cancel leaves ticket unarchived');

    await page.$eval(`[data-ticket-archive="${backlogTicket.id}"]`, (el) => el.click());
    await page.waitForSelector('#confirm-ok');
    await assertConfirmButtonsOneLine(page);
    await page.$eval('#confirm-ok', (el) => el.click());
    await page.waitForFunction(async (id) => {
      const s = await fetch('/api/state').then((r) => r.json());
      return s.tickets.find((t) => t.id === id)?.archived === true;
    }, {}, backlogTicket.id);

    let afterArchive = await state(harness.base);
    assert.equal(afterArchive.tickets.find((t) => t.id === backlogTicket.id).archived, true, 'non-terminal card archive succeeds');
    assert.equal(
      await page.$$eval(`.station .chip[data-id="${backlogTicket.id}"]`, (els) => els.length),
      0,
      'archived ticket leaves the board',
    );

    await page.$eval('#btn-archive', (el) => el.click());
    await page.waitForSelector(`[data-open="${backlogTicket.id}"]`);
    assert.equal(
      await page.$eval(`[data-restore-dest="${backlogTicket.id}"]`, (el) => el.value),
      done.id,
      'restore destination defaults to Done',
    );
    await page.$eval(`[data-restore="${backlogTicket.id}"]`, (el) => el.click());
    await page.waitForFunction(async (id, doneId) => {
      const s = await fetch('/api/state').then((r) => r.json());
      const t = s.tickets.find((x) => x.id === id);
      return t && !t.archived && t.columnId === doneId;
    }, {}, backlogTicket.id, done.id);

    const restored = (await state(harness.base)).tickets.find((t) => t.id === backlogTicket.id);
    assert.equal(restored.columnId, done.id, 'restore lands in Done by default');

    await api(harness.base, `/api/tickets/${backlogTicket.id}/archive`, 'POST', {});
    await page.reload({ waitUntil: 'networkidle2' });
    await page.$eval('#btn-archive', (el) => el.click());
    await page.waitForSelector(`[data-archive-delete="${backlogTicket.id}"]`);
    await page.$eval(`[data-archive-delete="${backlogTicket.id}"]`, (el) => el.click());
    await page.waitForSelector('#confirm-overlay');
    assert.match(await confirmText(page), /cannot be retrieved/i, 'delete confirmation explains permanent loss');
    await assertConfirmButtonsOneLine(page);
    await page.$eval('#confirm-ok', (el) => el.click());
    await page.waitForFunction(async (id) => {
      const s = await fetch('/api/state').then((r) => r.json());
      return !s.tickets.some((t) => t.id === id);
    }, {}, backlogTicket.id);

    assert.equal((await state(harness.base)).tickets.some((t) => t.id === backlogTicket.id), false, 'archive delete is permanent');

    const disableTicket = await api(harness.base, '/api/tickets', 'POST', {
      title: 'Archive controls disable',
      workspace: harness.root,
      columnId: columns[0].id,
    });
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector(`[data-ticket-archive="${disableTicket.id}"]`);
    await page.$eval(`[data-ticket-archive="${disableTicket.id}"]`, (el) => el.click());
    await page.waitForSelector('#confirm-disable-ticket-actions');
    await page.$eval('#confirm-disable-ticket-actions', (el) => el.click());
    await page.waitForFunction(() => document.querySelector('#confirm-disable-note')?.textContent.includes('Settings -> Engine -> Ticket Safety'));
    await page.waitForFunction(async () => {
      const s = await fetch('/api/state').then((r) => r.json());
      return s.board.settings.confirmTicketArchiveDelete === false;
    });
    await page.$eval('#confirm-cancel', (el) => el.click());
    await page.waitForSelector('#confirm-overlay', { hidden: true });
    await page.$eval(`[data-ticket-archive="${disableTicket.id}"]`, (el) => el.click());
    await page.waitForFunction(async (id) => {
      const s = await fetch('/api/state').then((r) => r.json());
      return s.tickets.find((t) => t.id === id)?.archived === true;
    }, {}, disableTicket.id);
    assert.equal(await page.$('#confirm-overlay'), null, 'disabled confirmation archives without a modal');

    await page.$eval('#btn-settings', (el) => el.click());
    await page.waitForSelector('#s-confirm-ticket-actions');
    assert.equal(await page.$eval('#s-confirm-ticket-actions', (el) => el.checked), false, 'settings reflects modal disable');
    assert.match(await page.$eval('.s-pane.active', (el) => el.textContent), /TICKET SAFETY/i, 'setting is in Engine ticket safety section');
    await page.$eval('#s-confirm-ticket-actions', (el) => { el.checked = true; });
    await page.$eval('#s-save', (el) => el.click());
    await page.waitForFunction(async () => {
      const s = await fetch('/api/state').then((r) => r.json());
      return s.board.settings.confirmTicketArchiveDelete === true;
    });

    await api(harness.base, '/api/tickets', 'POST', {
      title: 'Archive controls mobile',
      workspace: harness.root,
      columnId: columns[0].id,
    });

    await page.setViewport({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('.mcard');
    assert.ok(await page.$('.mcard [data-ticket-archive]'), 'mobile cards expose archive actions');
    assert.ok(await page.$('.mcard [data-ticket-delete]'), 'mobile cards expose delete actions');
    await page.$eval('.mcard [data-ticket-archive]', (el) => el.click());
    await page.waitForSelector('#confirm-overlay');
    await assertConfirmButtonsOneLine(page);
    await page.$eval('#confirm-cancel', (el) => el.click());
    await page.waitForSelector('#confirm-overlay', { hidden: true });
    await page.$eval('.mcard .title', (el) => el.click());
    await page.waitForSelector('#overlay');
    assert.deepEqual(dialogs, [], 'archive/delete actions should not emit browser dialogs');

    console.log('e2e: archive/delete checks passed');
  } finally {
    await browser.close();
    await harness.cleanup();
  }
})();
