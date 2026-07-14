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
  page.on('pageerror', (e) => { console.error('PAGE ERROR:', e.message); process.exitCode = 1; });
  page.on('dialog', (d) => d.accept());

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
    await page.waitForFunction(async (id) => {
      const s = await fetch('/api/state').then((r) => r.json());
      return !s.tickets.some((t) => t.id === id);
    }, {}, backlogTicket.id);

    assert.equal((await state(harness.base)).tickets.some((t) => t.id === backlogTicket.id), false, 'archive delete is permanent');

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
    await page.$eval('.mcard .title', (el) => el.click());
    await page.waitForSelector('#overlay');

    console.log('e2e: archive/delete checks passed');
  } finally {
    await browser.close();
    await harness.cleanup();
  }
})();
