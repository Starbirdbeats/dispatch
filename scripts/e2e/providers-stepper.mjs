// e2e: Providers → 4C guided stepper + subscription auth flow.
// Boots with BOTH providers unauthenticated, then drives the real login pipeline against
// fake CLIs: start browser sign-in → server spawns `claude auth login` / `codex login` →
// captures the OAuth URL → client exposes it as the pending login link → claude's
// one-time code is pasted back → the pill flips to AUTHENTICATED without a page reload.
// window.open is stubbed for the initial blank popup so no real network navigation happens.
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

const authHref = (page, type) => page.$eval(`[data-auth-open="${type}"]`, (el) => el.href);

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
    assert.ok(await page.$('.step-auth.todo [data-auth="claude"]'), 'claude browser sign-in button missing');
    assert.ok(await page.$('.step-auth.todo [data-auth="codex"]'), 'codex browser sign-in button missing');
    const idleAuth = await page.$eval('[data-provider-auth="claude"]', (el) => ({
      text: el.textContent || '',
      button: el.querySelector('[data-auth="claude"]')?.textContent || '',
      manualCommand: el.querySelector('.step-auth-manual code')?.textContent || '',
    }));
    assert.ok(idleAuth.text.includes('Dispatch runs claude auth login'), idleAuth.text);
    assert.ok(idleAuth.button.includes('START BROWSER SIGN-IN'), idleAuth.button);
    assert.equal(idleAuth.manualCommand.trim(), 'claude auth login');
    const completeDisabled = await page.$eval('#s-setup-complete', (el) => el.disabled);
    assert.equal(completeDisabled, true, 'MARK SETUP COMPLETE gated while unauthenticated');

    // An enabled but unrunnable CLI is blocked setup work, not an auth-success shortcut.
    await page.evaluate(() => {
      S.data.setup.providers.claude.authenticated = true;
      S.data.setup.providers.codex.installed = false;
      S.data.setup.providers.codex.authenticated = false;
      S.data.setup.providers.codex.error = 'spawn EPERM';
      updateStepperUI();
    });
    const unavailable = await page.$eval('[data-provider-auth="codex"]', (el) => ({
      text: el.textContent || '',
      hasSignIn: Boolean(el.querySelector('[data-auth="codex"]')),
      detailsOpen: el.querySelector('.step-auth-technical')?.open,
    }));
    assert.ok(unavailable.text.includes('CLI UNAVAILABLE'), unavailable.text);
    assert.ok(unavailable.text.includes('operating system blocked it from running'), unavailable.text);
    assert.equal(unavailable.hasSignIn, false, 'unrunnable CLI must not offer browser sign-in');
    assert.equal(unavailable.detailsOpen, false, 'raw process error should stay collapsed');
    assert.equal(await page.$eval('#s-setup-complete', (el) => el.disabled), true, 'unavailable enabled provider must block setup completion');
    const blockedStepClasses = await page.$$eval('.stepper .step-node', (nodes) => nodes.map((node) => node.className));
    assert.ok(blockedStepClasses[1].includes('active'), 'authentication step should remain active');
    assert.ok(!blockedStepClasses[1].includes('done'), 'authentication step must not skip an unavailable CLI');
    const presetsLocked = await page.$eval('.step-title[data-step="3"]', (node) => node.parentElement?.classList.contains('step-locked'));
    assert.equal(presetsLocked, true, 'presets step should remain locked');

    // Restore the server-backed fake provider state before exercising real auth sessions.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openProvidersTab(page);

    // ---- claude: full login via one-time code ----------------------------------------
    await page.$eval('.step-auth [data-auth="claude"]', (el) => el.click());
    // pending row appears: open-URL + code input + cancel
    await page.waitForSelector('[data-auth-code-input="claude"]');
    assert.ok(await page.$('[data-auth-open="claude"]'), 'OPEN SIGN-IN PAGE missing for claude');
    assert.ok(await page.$('[data-auth-cancel="claude"]'), 'CANCEL missing for claude');
    const claudePendingHelp = await page.$eval('[data-provider-auth="claude"] .step-auth-progress-copy', (el) => el.textContent || '');
    assert.ok(claudePendingHelp.includes('one-time code'), claudePendingHelp);
    const claudeHref = await authHref(page, 'claude');
    assert.ok(/^https:\/\/claude\.com\/cai\/oauth/.test(claudeHref), `expected claude auth link, saw: ${JSON.stringify(claudeHref)}`);

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
    assert.ok(await page.$('[data-auth-open="codex"]'), 'OPEN SIGN-IN PAGE missing for codex');
    assert.equal(await page.$('[data-auth-code-input="codex"]'), null, 'codex must NOT show a code input (localhost-callback flow)');
    const codexPendingHelp = await page.$eval('[data-provider-auth="codex"] .step-auth-progress-copy', (el) => el.textContent || '');
    assert.ok(codexPendingHelp.includes('updates automatically'), codexPendingHelp);
    const codexHref = await authHref(page, 'codex');
    assert.ok(/^https:\/\/auth\.openai\.com/.test(codexHref), `expected codex auth link, saw: ${JSON.stringify(codexHref)}`);

    await page.$eval('[data-auth-cancel="codex"]', (el) => el.click());
    await page.waitForSelector('.step-auth [data-auth="codex"]'); // back to idle browser sign-in

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

    // ---- per-phase harness selection (PHASE DEFAULTS grid) ---------------------------
    // Build ships as codex; switch it to claude from the grid and save — no CFG panel.
    await page.setViewport({ width: 1100, height: 900 });
    const buildTypeSel = '[data-pd="col-build:type"]';
    await page.waitForSelector(buildTypeSel);
    assert.equal(await page.$eval(buildTypeSel, (el) => el.value), 'codex', 'build phase starts as codex');
    await page.select(buildTypeSel, 'claude');
    // the model select refills with claude's registry, reset to CLI default
    const modelAfterSwap = await page.$eval('[data-pd="col-build:model"]', (el) => ({ value: el.value, opts: Array.from(el.options).map((o) => o.value) }));
    assert.equal(modelAfterSwap.value, '', 'model resets to CLI default on harness swap');
    await page.$eval('#s-save', (el) => el.click());
    await page.waitForFunction(async () => {
      const s = await fetch('/api/state').then((r) => r.json());
      return s.board.columns.find((c) => c.id === 'col-build')?.harness?.type === 'claude';
    }, { timeout: 8000 });
    console.log('e2e: per-phase harness swap (build codex → claude) saved');

    console.log('e2e: providers stepper + auth flow checks passed');
  } catch (e) {
    await dumpFailureState(page, harness, pageErrors);
    throw e;
  } finally {
    await browser.close();
    await harness.cleanup();
  }
})();
