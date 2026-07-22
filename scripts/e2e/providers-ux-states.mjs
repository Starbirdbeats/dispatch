// Deterministic visual-state coverage for provider setup. With DISPATCH_E2E_BASE set,
// this checks an already-running Dispatch (useful for real Windows + Edge verification).
// Otherwise it starts the normal fake-CLI harness for CI.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startDispatchServer } from './helpers.mjs';

const externalBase = String(process.env.DISPATCH_E2E_BASE || '').trim();
const harness = externalBase ? null : await startDispatchServer({ claudeAuth: false, codexAuth: false });
const base = externalBase || harness.base;
const screenshot = process.env.DISPATCH_E2E_SCREENSHOT
  || path.join(os.tmpdir(), 'dispatch-providers-ux-states.png');
const browserOptions = { headless: true, args: ['--no-sandbox'] };
if (process.env.DISPATCH_E2E_BROWSER) browserOptions.executablePath = process.env.DISPATCH_E2E_BROWSER;

const browser = await puppeteer.launch(browserOptions);
const page = await browser.newPage();
page.setDefaultTimeout(12000);
let stateVersion = 0;

async function openProvidersTab() {
  await page.waitForFunction(async () => {
    const state = await fetch('/api/state').then((res) => res.json());
    return state.setup?.probePending === false;
  });
  await page.$eval('#btn-settings', (el) => el.click());
  await page.waitForSelector('.tabs [data-tab="providers"]');
  await page.$eval('.tabs [data-tab="providers"]', (el) => el.click());
  await page.waitForSelector('[data-provider-auth="codex"]');
}

async function renderProviderState(config) {
  stateVersion += 1;
  await page.evaluate(({ config: next, stateVersion: version }) => {
    S.data.setup.platform = 'win32';
    S.data.setup.probePending = Boolean(next.checking);
    S.data.setup.probedAt = `test-${version}`;
    S.data.setup.authPending = next.pending ? { [next.type]: next.pending } : {};
    S.data.setup.authErrors = next.error ? { [next.type]: next.error } : {};
    Object.assign(S.data.setup.providers[next.type], {
      enabled: true,
      installed: next.installed !== false,
      authenticated: Boolean(next.authenticated),
      error: next.probeError || null,
    });
    updateStepperUI();
  }, { config, stateVersion });

  return page.$eval(`[data-provider-auth="${config.type}"]`, (el) => ({
    text: (el.innerText || '').replace(/\s+/g, ' ').trim(),
    primary: el.querySelector('.btn-accent')?.textContent?.replace(/\s+/g, ' ').trim() || '',
    command: el.querySelector('.step-auth-cmd code')?.textContent?.trim() || '',
    code: el.querySelector('.step-auth-device-code code')?.textContent?.trim() || '',
    hasInput: Boolean(el.querySelector('[data-auth-code-input]')),
    technicalOpen: el.querySelector('.step-auth-technical')?.open ?? null,
  }));
}

try {
  await page.setViewport({ width: 1100, height: 900 });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await openProvidersTab();

  if (externalBase) {
    const real = await page.$eval('[data-provider-auth="codex"]', (el) => (el.innerText || '').replace(/\s+/g, ' ').trim());
    assert.match(real, /SETUP NEEDED/);
    assert.match(real, /Codex Desktop and the Codex CLI are separate installs/);
    assert.doesNotMatch(real, /EPERM|WSL|same environment/);
    if (process.env.DISPATCH_E2E_REAL_SCREENSHOT) {
      await page.screenshot({ path: process.env.DISPATCH_E2E_REAL_SCREENSHOT, fullPage: true });
    }
  }

  let state = await renderProviderState({ type: 'codex', checking: true, installed: false });
  assert.match(state.text, /CHECKING/);
  assert.equal(state.primary, '');

  state = await renderProviderState({ type: 'codex', installed: false, probeError: 'spawn codex ENOENT' });
  assert.match(state.text, /Install the Codex command-line tool before signing in/);
  assert.equal(state.command, 'irm https://chatgpt.com/codex/install.ps1 | iex');
  assert.match(state.primary, /COPY INSTALL COMMAND/);
  assert.equal(state.technicalOpen, false);

  state = await renderProviderState({ type: 'codex', installed: false, probeError: 'spawn EPERM' });
  assert.match(state.text, /Codex Desktop and the Codex CLI are separate installs/);
  assert.doesNotMatch(state.text, /EPERM/);

  state = await renderProviderState({ type: 'codex', installed: true });
  assert.match(state.text, /SIGN-IN NEEDED/);
  assert.equal(state.primary, 'SIGN IN →');
  assert.equal(state.command, 'codex login --device-auth');

  state = await renderProviderState({
    type: 'codex',
    installed: true,
    pending: { url: null, userCode: null, needsCode: false },
  });
  assert.match(state.text, /OPENING SIGN-IN/);
  assert.match(state.primary, /PLEASE WAIT/);

  state = await renderProviderState({
    type: 'codex',
    installed: true,
    pending: { url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234', needsCode: false },
  });
  assert.match(state.text, /FINISH IN BROWSER/);
  assert.equal(state.code, 'ABCD-1234');
  assert.match(state.primary, /COPY CODE & OPEN SIGN-IN/);
  assert.equal(state.hasInput, false);

  state = await renderProviderState({
    type: 'claude',
    installed: true,
    pending: { url: 'https://claude.com/cai/oauth/authorize', userCode: null, needsCode: true },
  });
  assert.match(state.text, /FINISH IN BROWSER/);
  assert.match(state.primary, /OPEN SIGN-IN PAGE/);
  assert.equal(state.hasInput, true);

  state = await renderProviderState({
    type: 'codex',
    installed: true,
    error: 'codex login --device-auth exited with code 1 — detail',
  });
  assert.match(state.text, /SIGN-IN FAILED/);
  assert.match(state.primary, /TRY AGAIN/);
  assert.equal(state.technicalOpen, false);

  state = await renderProviderState({ type: 'codex', installed: true, authenticated: true });
  assert.match(state.text, /READY/);
  assert.match(state.text, /Signed in and ready to use/);

  await page.setViewport({ width: 375, height: 800 });
  await page.screenshot({ path: screenshot, fullPage: true });
  const mobile = await page.$eval('[data-provider-auth="codex"]', (el) => ({
    width: el.getBoundingClientRect().width,
    viewport: innerWidth,
    overflow: document.documentElement.scrollWidth - innerWidth,
  }));
  assert.ok(mobile.width <= mobile.viewport);
  assert.ok(mobile.overflow <= 1, JSON.stringify(mobile));

  console.log(JSON.stringify({
    browser: process.env.DISPATCH_E2E_BROWSER ? 'configured executable' : 'Puppeteer default',
    states: 9,
    realBlockedState: Boolean(externalBase),
    mobile,
    screenshot,
  }));
} finally {
  await browser.close();
  await harness?.cleanup();
}
