import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { startDispatchServer } from './helpers.mjs';

async function seedTicket(base, title, root, extra = {}) {
  return fetch(`${base}/api/tickets`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, workspace: root, ...extra }),
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
    // the backlog and seeded agent tickets stay queued in the in-flight tracker.
    await fetch(`${harness.base}/api/settings`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxConcurrent: 0 }),
    });
    const seededState = await fetch(`${harness.base}/api/state`).then((r) => r.json());
    const seededBacklog = seededState.board.columns.find((c) => c.role === 'intake');
    const seededAgent = seededState.board.columns.find((c) => c.role === 'agent');
    assert.ok(seededBacklog, 'default board has an intake column');
    assert.ok(seededAgent, 'default board has an agent column');

    // Seed enough backlog tickets to force a vertical station scroll, and enough
    // queued agent tickets to force a vertical in-flight scroll.
    const railTicketCount = 12;
    const queuedTicketCount = 9;
    for (let i = 1; i <= railTicketCount; i++) await seedTicket(harness.base, `Rail ticket ${i}`, harness.root);
    for (let i = 1; i <= queuedTicketCount; i++) {
      await seedTicket(harness.base, `Queued tracker ticket ${i}`, harness.root, { columnId: seededAgent.id });
    }

    // ---- DESKTOP (≥760px): pipeline rail + in-flight tracker ----
    await page.setViewport({ width: 1440, height: 640 });
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

    const backlog = state.board.columns.find((c) => c.role === 'intake');
    const backlogStation = await page.evaluateHandle((cid) => {
      return [...document.querySelectorAll('.station')].find((s) => s.querySelector(`.cfg[data-cfg="${cid}"]`));
    }, backlog.id);

    const split = await page.$eval('#board', (board) => {
      const rail = document.querySelector('.rail');
      const inflight = document.querySelector('.inflight');
      const br = board.getBoundingClientRect();
      const rr = rail.getBoundingClientRect();
      const ir = inflight.getBoundingClientRect();
      return {
        display: getComputedStyle(board).display,
        boardHeight: br.height,
        railHeight: rr.height,
        inflightHeight: ir.height,
        inflightTop: ir.top - br.top,
      };
    });
    assert.equal(split.display, 'grid', 'desktop board uses a grid split');
    assert.ok(Math.abs(split.railHeight - split.boardHeight / 2) <= 2, `rail should occupy half the board, got ${JSON.stringify(split)}`);
    assert.ok(Math.abs(split.inflightHeight - split.boardHeight / 2) <= 2, `in-flight should occupy half the board, got ${JSON.stringify(split)}`);
    assert.ok(Math.abs(split.inflightTop - split.boardHeight / 2) <= 2, `in-flight should start at the lower half, got ${JSON.stringify(split)}`);

    const stationScroll = await backlogStation.evaluate((s, expectedCount) => {
      const body = s.querySelector('.station-body');
      body.scrollTop = body.scrollHeight;
      return {
        chips: s.querySelectorAll('.chip').length,
        hasMore: Boolean(s.querySelector('.chip-more')),
        overflowY: getComputedStyle(body).overflowY,
        scrollable: body.scrollHeight > body.clientHeight,
        scrolled: body.scrollTop > 0,
      };
    }, railTicketCount);
    assert.equal(stationScroll.chips, railTicketCount, 'desktop station renders every ticket in the scroll body');
    assert.equal(stationScroll.hasMore, false, 'desktop station no longer uses +N MORE');
    assert.ok(['auto', 'scroll'].includes(stationScroll.overflowY), `station body should scroll vertically, got ${stationScroll.overflowY}`);
    assert.ok(stationScroll.scrollable, 'overflowing station body has vertical overflow');
    assert.ok(stationScroll.scrolled, 'overflowing station body accepts vertical scroll');

    // in-flight tracker exists, is pinned in the lower half, and scrolls its own rows.
    await page.waitForSelector('.inflight');
    const headText = await page.$eval('.inflight-head', (e) => e.textContent);
    assert.match(headText, /IN FLIGHT/, 'in-flight header');
    assert.match(headText, new RegExp(`${queuedTicketCount} QUEUED`), 'in-flight header counts queued rows');
    assert.equal(await page.$$eval('.track-row', (els) => els.length), queuedTicketCount, 'one in-flight row per queued ticket');
    const segCount = await page.$$eval('.track-row:first-child .seg', (els) => els.length);
    assert.equal(segCount, colCount, 'tracker progress bar has one segment per column');
    const trackScroll = await page.$eval('.track', (track) => {
      track.scrollTop = track.scrollHeight;
      return {
        overflowY: getComputedStyle(track).overflowY,
        scrollable: track.scrollHeight > track.clientHeight,
        scrolled: track.scrollTop > 0,
      };
    });
    assert.ok(['auto', 'scroll'].includes(trackScroll.overflowY), `in-flight track should scroll vertically, got ${trackScroll.overflowY}`);
    assert.ok(trackScroll.scrollable, 'overflowing in-flight track has vertical overflow');
    assert.ok(trackScroll.scrolled, 'overflowing in-flight track accepts vertical scroll');
    assert.ok(!(await page.$('.inflight-empty')), 'in-flight empty state is hidden when rows exist');

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
    await page.waitForSelector('#board.mobile .inflight');

    const mobileHeadText = await page.$eval('#board.mobile .inflight-head', (e) => e.textContent);
    assert.match(mobileHeadText, /IN FLIGHT/, 'mobile in-flight header');
    assert.match(mobileHeadText, new RegExp(`${queuedTicketCount} QUEUED`), 'mobile in-flight header counts queued rows');

    const mobileLayout = await page.$eval('#board', (board) => {
      const body = board.querySelector('.mbody');
      const inflight = board.querySelector('.inflight');
      const track = board.querySelector('.track');
      body.scrollTop = body.scrollHeight;
      track.scrollTop = track.scrollHeight;
      const br = board.getBoundingClientRect();
      const mr = body.getBoundingClientRect();
      const ir = inflight.getBoundingClientRect();
      const tr = track.getBoundingClientRect();
      const rows = [...board.querySelectorAll('.track-row')].map((row) => row.getBoundingClientRect());
      return {
        display: getComputedStyle(board).display,
        boardOverflowY: getComputedStyle(board).overflowY,
        bodyOverflowY: getComputedStyle(body).overflowY,
        bodyScrollable: body.scrollHeight > body.clientHeight,
        bodyScrolled: body.scrollTop > 0,
        trackOverflowY: getComputedStyle(track).overflowY,
        trackOverflowX: getComputedStyle(track).overflowX,
        trackScrollable: track.scrollHeight > track.clientHeight,
        trackScrolled: track.scrollTop > 0,
        trackRows: rows.length,
        inflightBottomDelta: Math.abs(ir.bottom - br.bottom),
        phaseAboveTracker: mr.bottom <= ir.top + 1,
        rowsFitTrack: rows.every((r) => r.left >= tr.left - 1 && r.right <= tr.right + 1),
      };
    });
    assert.equal(mobileLayout.display, 'flex', 'mobile board uses a constrained flex column');
    assert.equal(mobileLayout.boardOverflowY, 'hidden', 'mobile board itself does not scroll');
    assert.ok(mobileLayout.inflightBottomDelta <= 1, `mobile in-flight should be pinned to board bottom, got ${JSON.stringify(mobileLayout)}`);
    assert.ok(mobileLayout.phaseAboveTracker, `mobile phase content should end above in-flight, got ${JSON.stringify(mobileLayout)}`);
    assert.ok(['auto', 'scroll'].includes(mobileLayout.bodyOverflowY), `mobile phase body should scroll vertically, got ${mobileLayout.bodyOverflowY}`);
    assert.ok(mobileLayout.bodyScrollable, 'overflowing mobile phase body has vertical overflow');
    assert.ok(mobileLayout.bodyScrolled, 'overflowing mobile phase body accepts vertical scroll');
    assert.ok(['auto', 'scroll'].includes(mobileLayout.trackOverflowY), `mobile in-flight track should scroll vertically, got ${mobileLayout.trackOverflowY}`);
    assert.equal(mobileLayout.trackOverflowX, 'hidden', 'mobile in-flight rows fit without horizontal scrolling');
    assert.ok(mobileLayout.trackScrollable, 'overflowing mobile in-flight track has vertical overflow');
    assert.ok(mobileLayout.trackScrolled, 'overflowing mobile in-flight track accepts vertical scroll');
    assert.equal(mobileLayout.trackRows, queuedTicketCount, 'mobile in-flight renders one row per queued ticket');
    assert.ok(mobileLayout.rowsFitTrack, `mobile in-flight rows stay inside the track, got ${JSON.stringify(mobileLayout)}`);

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
