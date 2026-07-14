import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { startDispatchServer } from './helpers.mjs';

async function seedTicket(base, title, root) {
  return fetch(`${base}/api/tickets`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, workspace: root }),
  }).then((r) => r.json());
}

(async () => {
  const harness = await startDispatchServer({
    claudeAuth: true, codexAuth: true,
    claudeVersion: 'claude 1.0.0', codexVersion: 'codex 1.2.3',
    codexStatusText: 'You are logged in as test@example.com',
  });
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => { console.error('PAGE ERROR:', e.message); process.exitCode = 1; });

  try {
    // Pause the engine first so seeded intake tickets aren't auto-dispatched out of
    // the backlog — keeps the +N cap assertion deterministic.
    await fetch(`${harness.base}/api/settings`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxConcurrent: 0 }),
    });
    // Seed 6 backlog tickets so the +N cap (4) triggers and the rail has content.
    for (let i = 1; i <= 6; i++) await seedTicket(harness.base, `Rail ticket ${i}`, harness.root);

    // ---- DESKTOP (≥760px): pipeline rail + in-flight tracker ----
    await page.setViewport({ width: 1440, height: 960 });
    await page.goto(harness.base, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.rail');

    const state = await fetch(`${harness.base}/api/state`).then((r) => r.json());
    const colCount = state.board.columns.length;

    const stations = await page.$$eval('.station', (els) => els.length);
    assert.equal(stations, colCount, 'one station per column');
    const arrows = await page.$$eval('.rail-arrow', (els) => els.length);
    assert.equal(arrows, colCount - 1, 'connector arrows between stations');

    // every station header exposes a CFG hook (setup-ui + column routing depend on it)
    for (const col of state.board.columns) {
      assert.ok(await page.$(`.station .cfg[data-cfg="${col.id}"]`), `CFG present for ${col.id}`);
    }

    // +N more cap: backlog has 6 tickets, cap 4 -> 4 chips + a "+2 MORE" button
    const backlog = state.board.columns.find((c) => c.role === 'intake');
    const backlogStation = await page.evaluateHandle((cid) => {
      return [...document.querySelectorAll('.station')].find((s) => s.querySelector(`.cfg[data-cfg="${cid}"]`));
    }, backlog.id);
    const chipsBefore = await backlogStation.evaluate((s) => s.querySelectorAll('.chip').length);
    assert.equal(chipsBefore, 4, 'station caps at 4 chips');
    const moreText = await backlogStation.evaluate((s) => s.querySelector('.chip-more')?.textContent);
    assert.equal(moreText, '+2 MORE', 'shows +N MORE for the overflow');
    await backlogStation.evaluate((s) => s.querySelector('.chip-more').click());
    await page.waitForFunction((cid) => {
      const st = [...document.querySelectorAll('.station')].find((s) => s.querySelector(`.cfg[data-cfg="${cid}"]`));
      return st && st.querySelectorAll('.chip').length === 6;
    }, {}, backlog.id);
    const lessText = await page.evaluate((cid) => {
      const st = [...document.querySelectorAll('.station')].find((s) => s.querySelector(`.cfg[data-cfg="${cid}"]`));
      return st.querySelector('.chip-more')?.textContent;
    }, backlog.id);
    assert.equal(lessText, 'SHOW LESS', 'expanded station offers SHOW LESS');

    // in-flight tracker exists; progress bars have one segment per column
    await page.waitForSelector('.inflight');
    const headText = await page.$eval('.inflight-head', (e) => e.textContent);
    assert.match(headText, /IN FLIGHT/, 'in-flight header');
    // no runs seeded -> empty-state row
    assert.ok(await page.$('.inflight-empty'), 'empty in-flight state when nothing is running');

    // clicking a chip opens the ticket modal and writes the hash (URL routing preserved)
    await page.$eval('.station .chip', (el) => el.click());
    await page.waitForSelector('#overlay');
    assert.match(await page.evaluate(() => location.hash), /^#t-/, 'chip click routes to a ticket hash');
    await page.$eval('#modal-close', (el) => el.click());
    await page.waitForFunction(() => !document.querySelector('#overlay'));

    // the intake drop target is also a create affordance, preselecting that station
    const dropText = await backlogStation.evaluate((s) => s.querySelector('.chip-drop-action')?.textContent || '');
    assert.match(dropText, /CREATE \/ DROP TICKET/, 'desktop drop target advertises create/drop');
    await backlogStation.evaluate((s) => s.querySelector('.chip-drop-action').click());
    await page.waitForSelector('#overlay #n-title');
    assert.equal(await page.evaluate(() => location.hash), '#new', 'drop target opens new-ticket modal');
    assert.equal(await page.$eval('#n-col', (el) => el.value), backlog.id, 'desktop drop target preselects intake column');
    const createdTitle = 'Created from rail drop target';
    await page.type('#n-title', createdTitle);
    await page.$eval('#n-create', (el) => el.click());
    await page.waitForFunction(() => !document.querySelector('#overlay'));
    const afterCreate = await fetch(`${harness.base}/api/state`).then((r) => r.json());
    const created = afterCreate.tickets.find((t) => t.title === createdTitle);
    assert.equal(created?.columnId, backlog.id, 'desktop drop target creates the ticket in intake');

    // ---- MOBILE (<760px): one phase per screen ----
    await page.setViewport({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('.mphase-nav');
    assert.ok(!(await page.$('.rail')), 'rail is not rendered on mobile');

    const dotCount = await page.$$eval('.mdots span', (els) => els.length);
    assert.equal(dotCount, colCount, 'one pager dot per phase');
    assert.equal(await page.$$eval('.mdots span.on', (e) => e.length), 1, 'exactly one active dot');
    assert.ok(await page.$eval('.mprev', (b) => b.disabled), 'prev disabled on first phase');

    await page.$eval('.mbody .chip-drop-action', (el) => el.click());
    await page.waitForSelector('#overlay #n-col');
    assert.equal(await page.evaluate(() => location.hash), '#new', 'mobile drop target opens new-ticket modal');
    assert.equal(await page.$eval('#n-col', (el) => el.value), backlog.id, 'mobile drop target preselects visible phase');
    await page.$eval('#modal-close', (el) => el.click());
    await page.waitForFunction(() => !document.querySelector('#overlay'));

    // ticket modal tabs stay usable on phone-sized viewports: the strip scrolls
    // horizontally, preserves 44px touch targets, and keeps the active tab visible.
    await page.$eval('.mcard', (el) => el.click());
    await page.waitForSelector('#overlay .tabs [data-tab="overview"]');
    const tabsOverflow = await page.$eval('.tabs', (el) => getComputedStyle(el).overflowX);
    assert.ok(['auto', 'scroll'].includes(tabsOverflow), `ticket tab strip should scroll, got: ${tabsOverflow}`);
    const tabsFitViewport = await page.$eval('.tabs', (el) => {
      const r = el.getBoundingClientRect();
      return r.left >= -1 && r.right <= window.innerWidth + 1;
    });
    assert.ok(tabsFitViewport, 'ticket tab strip stays within the mobile viewport');
    const tabHeights = await page.$$eval('.tabs [data-tab]', (els) => els.map((el) => el.getBoundingClientRect().height));
    assert.ok(tabHeights.every((h) => h >= 44), `ticket tabs should be >=44px tall, got: ${tabHeights.join(', ')}`);

    for (const tab of ['overview', 'activity', 'transcript', 'dossier']) {
      await page.$eval(`.tabs [data-tab="${tab}"]`, (el) => {
        el.scrollIntoView({ block: 'nearest', inline: 'center' });
        el.click();
      });
      await page.waitForFunction((want) => document.querySelector('.tabs button.active')?.dataset.tab === want, {}, tab);
      const hash = await page.evaluate(() => location.hash);
      if (tab === 'overview') assert.match(hash, /^#t-[^/]+$/, 'overview tab keeps bare ticket hash');
      else assert.match(hash, new RegExp(`^#t-[^/]+/${tab}$`), `${tab} tab updates the hash`);
      const activeVisible = await page.$eval('.tabs', (strip) => {
        const active = strip.querySelector('button.active');
        const sr = strip.getBoundingClientRect();
        const ar = active.getBoundingClientRect();
        return ar.left >= sr.left - 1 && ar.right <= sr.right + 1 && ar.top >= sr.top - 1 && ar.bottom <= sr.bottom + 1;
      });
      assert.ok(activeVisible, `${tab} tab remains visible in the mobile strip`);
    }
    await page.$eval('#modal-close', (el) => el.click());
    await page.waitForFunction(() => !document.querySelector('#overlay'));

    const firstPhase = await page.$eval('.mphase-title .n', (e) => e.textContent);
    await page.$eval('.mnext', (b) => b.click());
    await page.waitForFunction((prev) => document.querySelector('.mphase-title .n')?.textContent !== prev, {}, firstPhase);
    const secondPhase = await page.$eval('.mphase-title .n', (e) => e.textContent);
    assert.notEqual(secondPhase, firstPhase, 'next advances the phase');
    assert.ok(!(await page.$eval('.mprev', (b) => b.disabled)), 'prev enabled after advancing');
    // (swipe is a thin wrapper over the same go() path the nav buttons exercise above;
    //  synthetic TouchEvent dispatch is too environment-fragile to assert reliably here.)

    // last phase disables next
    const total = await page.$$eval('.mdots span', (els) => els.length);
    for (let i = 0; i < total; i++) {
      const disabled = await page.$eval('.mnext', (b) => b.disabled);
      if (disabled) break;
      await page.$eval('.mnext', (b) => b.click());
    }
    assert.ok(await page.$eval('.mnext', (b) => b.disabled), 'next disabled on last phase');

    console.log('e2e: board responsive checks passed');
  } finally {
    await browser.close();
    await harness.cleanup();
  }
})();
