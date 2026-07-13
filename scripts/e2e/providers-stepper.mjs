// e2e: Providers → 4C guided stepper + subscription auth flow.
// Boots with BOTH providers unauthenticated, then drives the real login pipeline against
// fake CLIs: click AUTHENTICATE → server spawns `claude auth login` / `codex login` →
// captures the OAuth URL → client "opens" it → claude's one-time code is pasted back →
// the pill flips to AUTHENTICATED without a page reload. window.open is stubbed so no real
// network navigation happens.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startDispatchServer } from './helpers.mjs';

const SHOTS = path.join(os.tmpdir(), 'dispatch-e2e-shots');

async function openProvidersTab(page) {
  await page.waitForSelector('#btn-settings');
  await page.$eval('#btn-settings', (el) => el.click());
  await page.waitForSelector('.tabs [data-tab="providers"]');
  await page.$eval('.tabs [data-tab="providers"]', (el) => el.click());
  await page.waitForSelector('.s-pane[data-pane="providers"].active .stepper');
}

// Records every window.open (URL arg or later `.location =` assignment) without navigating.
async function stubWindowOpen(page) {
  await page.evaluateOnNewDocument(() => {
    window.__opened = [];
    window.open = (url) => {
      const rec = { url: url || null };
      window.__opened.push(rec);
      const o = { close() {} };
      Object.defineProperty(o, 'location', { configurable: true, get() { return rec.url; }, set(v) { rec.url = String(v); } });
      return o;
    };
  });
}

const openedUrls = (page) => page.evaluate(() => (window.__opened || []).map((o) => o.url).filter(Boolean));

// On any failure, print what the app actually looked like — which guard fired, what the
// server thought was pending, what the last toast said — so a flake is diagnosable from
// CI output alone instead of needing a local re-run.
async function dumpFailureState(page, harness, pageErrors) {
  try {
    const status = await fetch(`${harness.base}/api/setup/status`).then((r) => r.json());
    console.error('[diag] authPending:', JSON.stringify(status.authPending));
    console.error('[diag] authErrors:', JSON.stringify(status.authErrors));
    console.error('[diag] providers:', JSON.stringify(Object.fromEntries(Object.entries(status.providers || {}).map(([k, v]) => [k, { installed: v.installed, authenticated: v.authenticated, detail: v.authDetail }]))));
  } catch (e) { console.error('[diag] setup/status unreachable:', e.message); }
  try {
    console.error('[diag] toast:', JSON.stringify(await page.$eval('#toast', (el) => el.textContent).catch(() => '(none)')));
    console.error('[diag] opened urls:', JSON.stringify(await page.evaluate(() => (window.__opened || []).map((o) => o.url))));
    const html = await page.$eval('#s-stepper', (el) => el.innerHTML).catch(() => '(no stepper)');
    console.error('[diag] stepper buttons:', JSON.stringify((html.match(/data-(auth|auth-open|auth-cancel|auth-code|probe)="[a-z]+"/g) || [])));
    console.error('[diag] pills:', JSON.stringify((html.match(/setup-pill (ok|warn)">[^<]+/g) || [])));
  } catch { /* page already closed */ }
  console.error('[diag] page errors:', JSON.stringify(pageErrors));
}

(async () => {
  const harness = await startDispatchServer({ claudeAuth: false, codexAuth: false });
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(12000);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${String(m.text()).slice(0, 200)}`); });
  await stubWindowOpen(page);

  try {
    // ---- render: both providers unauthenticated, Step 2 active -----------------------
    await page.setViewport({ width: 1100, height: 900 });
    await page.goto(harness.base, { waitUntil: 'domcontentloaded' });
    await openProvidersTab(page);

    const nodeClasses = await page.$$eval('.stepper .step-node', (n) => n.map((x) => x.className));
    assert.equal(nodeClasses.length, 3);
    assert.ok(nodeClasses[0].includes('done'), 'step 1 enable done (both enabled)');
    assert.ok(nodeClasses[1].includes('active'), 'step 2 authenticate active');
    assert.ok(await page.$('.step-auth.todo [data-auth="claude"]'), 'claude AUTHENTICATE button missing');
    assert.ok(await page.$('.step-auth.todo [data-auth="codex"]'), 'codex AUTHENTICATE button missing');
    const completeDisabled = await page.$eval('#s-setup-complete', (el) => el.disabled);
    assert.equal(completeDisabled, true, 'MARK SETUP COMPLETE gated while unauthenticated');

    // ---- claude: full login via one-time code ----------------------------------------
    await page.$eval('.step-auth [data-auth="claude"]', (el) => el.click());
    // pending row appears: open-URL + code input + cancel
    await page.waitForSelector('[data-auth-code-input="claude"]');
    assert.ok(await page.$('[data-auth-open="claude"]'), 'OPEN LOGIN PAGE missing for claude');
    assert.ok(await page.$('[data-auth-cancel="claude"]'), 'CANCEL missing for claude');
    const claudeUrls = await openedUrls(page);
    assert.ok(claudeUrls.some((u) => /^https:\/\/claude\.com\/cai\/oauth/.test(u)), `expected claude auth URL to open, saw: ${JSON.stringify(claudeUrls)}`);

    // paste the code and submit → CLI writes creds, exits 0, server re-probes, pill flips
    await page.type('[data-auth-code-input="claude"]', 'GOOD-CODE');
    await page.$eval('[data-auth-code="claude"]', (el) => el.click());
    await page.waitForFunction(() => {
      const row = Array.from(document.querySelectorAll('.step-auth')).find((r) => r.querySelector('.step-auth-name')?.textContent?.includes('CLAUDE'));
      return row && row.querySelector('.setup-pill.ok');
    }, { timeout: 12000 });

    // ---- codex: start login, then CANCEL back to idle --------------------------------
    await page.$eval('.step-auth [data-auth="codex"]', (el) => el.click());
    await page.waitForSelector('[data-auth-cancel="codex"]');
    assert.ok(await page.$('[data-auth-open="codex"]'), 'OPEN LOGIN PAGE missing for codex');
    assert.equal(await page.$('[data-auth-code-input="codex"]'), null, 'codex must NOT show a code input (localhost-callback flow)');
    const codexUrls = await openedUrls(page);
    assert.ok(codexUrls.some((u) => /^https:\/\/auth\.openai\.com/.test(u)), `expected codex auth URL to open, saw: ${JSON.stringify(codexUrls)}`);

    await page.$eval('[data-auth-cancel="codex"]', (el) => el.click());
    await page.waitForSelector('.step-auth [data-auth="codex"]'); // back to idle AUTHENTICATE

    await fs.mkdir(SHOTS, { recursive: true }).catch(() => {});
    await page.screenshot({ path: path.join(SHOTS, 'providers-stepper-authflow.png') });

    // ---- mobile render sanity (rail drops, chips inline) -----------------------------
    await page.setViewport({ width: 375, height: 800 });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.stepper .step-rail')).display === 'none');
    const tabsScroll = await page.$eval('.tabs', (el) => getComputedStyle(el).overflowX);
    assert.ok(['auto', 'scroll'].includes(tabsScroll), `tab strip should scroll, got: ${tabsScroll}`);

    // ---- endpoint allowlist ----------------------------------------------------------
    const bogus = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/setup/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'nope' }) });
      return r.status;
    }, harness.base);
    assert.equal(bogus, 400, 'unknown provider must be rejected');

    console.log('e2e: providers stepper + auth flow checks passed');
  } catch (e) {
    await dumpFailureState(page, harness, pageErrors);
    throw e;
  } finally {
    await browser.close();
    await harness.cleanup();
  }
})();
