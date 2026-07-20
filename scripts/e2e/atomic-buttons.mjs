import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { startDispatchServer, waitForCondition } from './helpers.mjs';

// Button clicks must be atomic: a slow request may not settle before the region that owns
// the button re-renders on a websocket state broadcast. A node-local guard would lose its
// lock when the button is replaced by a fresh clone; the action-keyed guard (inFlightActions
// + data-action-key) must re-lock the clone so the in-flight action can't be fired twice.
// This drives a real browser and hangs the request in-page to hold that window open.

async function api(base, path, method = 'GET', body = null) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const state = (base) => api(base, '/api/state');
const ticketOf = async (base, id) => (await state(base)).tickets.find((t) => t.id === id);
const commentCount = (t, marker) => (t?.activity || []).filter((a) => (a.text || '').includes(marker)).length;

(async () => {
  const harness = await startDispatchServer({ claudeAuth: true, codexAuth: true });
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => { console.error('PAGE ERROR:', e.message); process.exitCode = 1; });

  try {
    // Paused engine: no run auto-starts, so the ticket stays idle and comments don't schedule a wake race.
    await api(harness.base, '/api/settings', 'PATCH', { maxConcurrent: 0 });
    const { board } = await state(harness.base);
    const backlog = [...board.columns].sort((a, b) => a.order - b.order)[0];
    const ticket = await api(harness.base, '/api/tickets', 'POST', {
      title: 'Atomic button check',
      workspace: harness.root,
      columnId: backlog.id,
    });

    // Deep-link straight to the activity tab, where the comment box lives.
    await page.goto(`${harness.base}#${ticket.id}/activity`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#btn-comment');

    const MARKER = 'ATOMIC-E2E-MARKER';

    // Hold the comment POST open in-page so we control when it settles.
    await page.evaluate(() => {
      const orig = window.fetch;
      window.__origFetch = orig;
      window.__releaseComment = null;
      window.fetch = (url, opts) => {
        if (typeof url === 'string' && url.includes('/comment')) {
          return new Promise((resolve) => { window.__releaseComment = () => resolve(orig(url, opts)); });
        }
        return orig(url, opts);
      };
    });

    // Type a comment and press POST — the request now hangs.
    await page.type('#f-comment', `${MARKER} please update the ticket`);
    await page.$eval('#btn-comment', (el) => el.click());
    await page.waitForFunction(() => {
      const b = document.querySelector('#btn-comment');
      return b && b.disabled && /POSTING/.test(b.textContent);
    }, { timeout: 5000 });

    // The action is registered under its stable key while in flight.
    assert.equal(
      await page.evaluate((id) => inFlightActions.has(`comment:${id}`), ticket.id),
      true,
      'comment action is registered in the in-flight set',
    );

    // Force the exact hazard: a full re-render of the activity tab (what a websocket
    // state broadcast triggers) while the POST is still open.
    await page.evaluate(() => render());

    // The freshly rendered POST button must re-lock itself — this is the whole fix.
    const afterRerender = await page.$eval('#btn-comment', (b) => ({ disabled: b.disabled, text: b.textContent }));
    assert.equal(afterRerender.disabled, true, 're-rendered POST button stays disabled while the action is in flight');
    assert.match(afterRerender.text, /POSTING/, 're-rendered POST button keeps its busy label');

    // A click on the re-rendered button must not fire a second comment.
    await page.$eval('#btn-comment', (el) => el.click());

    // Release the request; the guard settles and the button returns to normal.
    await page.evaluate(() => window.__releaseComment && window.__releaseComment());
    await page.waitForFunction(() => {
      const b = document.querySelector('#btn-comment');
      return b && !b.disabled && /POST/.test(b.textContent) && !/POSTING/.test(b.textContent);
    }, { timeout: 5000 });

    assert.equal(
      await page.evaluate((id) => inFlightActions.has(`comment:${id}`), ticket.id),
      false,
      'the in-flight key is cleared once the request settles',
    );

    // Exactly one comment landed despite the extra click across the re-render.
    const settled = await waitForCondition(async () => commentCount(await ticketOf(harness.base, ticket.id), MARKER) >= 1, { timeoutMs: 5000 });
    assert.ok(settled, 'the comment reached the server');
    assert.equal(commentCount(await ticketOf(harness.base, ticket.id), MARKER), 1, 'no duplicate comment was posted across the re-render + extra click');

    // Server-side backstop: even if two creates slip through with the same requestId
    // (dropped response retried), the second replays the first ticket rather than twinning.
    const before = (await state(harness.base)).tickets.length;
    const payload = { requestId: 'atomic-e2e-dedupe', title: 'Dedupe check', workspace: harness.root, columnId: backlog.id };
    const first = await api(harness.base, '/api/tickets', 'POST', payload);
    const second = await api(harness.base, '/api/tickets', 'POST', payload);
    assert.equal(second.id, first.id, 'same requestId replays the same ticket');
    assert.equal(second.deduped, true, 'the replay is flagged as deduped');
    assert.equal((await state(harness.base)).tickets.length, before + 1, 'only one ticket was created for the duplicated request');

    console.log('atomic-buttons e2e: PASS');
  } finally {
    await browser.close();
    await harness.cleanup();
  }
})();
