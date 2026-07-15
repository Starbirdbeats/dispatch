import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
    await fetch(`${harness.base}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxConcurrent: 0 }),
    });
    const ticket = await fetch(`${harness.base}/api/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Transcript formatting test', workspace: harness.root }),
    }).then((r) => r.json());

    const transcriptsDir = path.join(harness.dataDir, 'tickets', ticket.id, 'transcripts');
    fs.mkdirSync(transcriptsDir, { recursive: true });
    const longClaudeTool = {
      command: `find /tmp/dispatch-data/tickets -name '*.jsonl' -maxdepth 4 | sort | head -20 # ${'x'.repeat(220)}`,
      description: 'Find real transcript jsonl files with a payload long enough to exceed the old 160 character summary cap',
    };
    const handoff = {
      action: 'advance',
      target_column: 'Review',
      comment: `Second-pass build complete with a deliberately long comment so the transcript renderer must use readable field rows instead of one raw JSON wall. ${'review '.repeat(30)}`,
      human_test: '1. Open the ticket transcript.\n2. Confirm the fenced control JSON is rendered as readable fields.\n3. Confirm the prose above the block remains readable.',
    };
    const handoffText = `**Build complete.** The important part is the final control block below.\n\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\``;
    fs.writeFileSync(path.join(transcriptsDir, 'run-json-test.jsonl'), [
      JSON.stringify({ ev: { kind: 'system', text: '{"session":"abc","model":"test"}' } }),
      JSON.stringify({ ev: { kind: 'tool', text: 'Bash', json: longClaudeTool } }),
      JSON.stringify({ ev: { kind: 'tool', text: 'Bash {"cmd":"npm test","args":["--","json"],"nested":{"ok":true}}' } }),
      JSON.stringify({ ev: { kind: 'error', text: 'turn failed: {"code":"bad_json","retry":false}' } }),
      JSON.stringify({ ev: { kind: 'text', text: handoffText } }),
      JSON.stringify({ ev: { kind: 'text', text: 'not json: {broken' } }),
    ].join('\n') + '\n', 'utf8');

    await page.goto(`${harness.base}#${ticket.id}/transcript`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.transcript .ln.k-tool .transcript-json code');

    // The long Claude tool has prose values, so it renders as expanded field
    // rows rather than one JSON block. The full payload must survive untruncated.
    const fieldVals = await page.$$eval('.transcript .ln.k-tool .tr-field-val', (els) => els.map((el) => el.textContent || ''));
    assert.ok(fieldVals.some((text) => text.includes(longClaudeTool.command)), 'long structured Claude tool value is preserved and rendered, untruncated');
    assert.ok(fieldVals.some((text) => text.includes(longClaudeTool.description)), 'every prose field of the tool payload is rendered');
    const toolKeys = await page.$$eval('.transcript .ln.k-tool .tr-field-key', (els) => els.map((el) => el.textContent || ''));
    assert.ok(toolKeys.includes('COMMAND') && toolKeys.includes('DESCRIPTION'), 'prose fields are labelled with humanized keys');

    // The short legacy tool object stays a compact, indented JSON block.
    const toolJsonBlocks = await page.$$eval('.transcript .ln.k-tool .transcript-json code', (els) => els.map((el) => el.textContent || ''));
    assert.ok(toolJsonBlocks.some((text) => /\n  "cmd": "npm test"/.test(text)), 'legacy tool JSON text is pretty-printed');
    assert.ok(toolJsonBlocks.some((text) => /\n    "ok": true\n  }/.test(text)), 'nested JSON is indented');

    const systemJson = await page.$eval('.transcript .ln.k-system .transcript-json code', (el) => el.textContent || '');
    assert.match(systemJson, /\n  "session": "abc"/, 'whole JSON payload is pretty-printed');

    const errorPrefix = await page.$eval('.transcript .ln.k-error .tr-prefix', (el) => el.textContent || '');
    assert.equal(errorPrefix, 'turn failed:', 'prefix is preserved before error JSON');

    const handoffFields = await page.$$eval('.transcript .ln.k-text .tr-field-key', (els) => els.map((el) => el.textContent || ''));
    for (const key of ['ACTION', 'TARGET COLUMN', 'COMMENT', 'HUMAN TEST']) {
      assert.ok(handoffFields.includes(key), `handoff control field is labelled: ${key}`);
    }
    assert.ok(!handoffFields.includes('TARGET_COLUMN') && !handoffFields.includes('HUMAN_TEST'), 'handoff labels are humanized without underscores');
    const firstHandoffFieldDisplay = await page.$eval('.transcript .ln.k-text .tr-field', (el) => getComputedStyle(el).display);
    assert.equal(firstHandoffFieldDisplay, 'grid', 'handoff control fields use a two-column grid structure');
    const handoffCollapseCount = await page.$$eval('.transcript .ln.k-text .tr-collapse', (els) => els.length);
    assert.equal(handoffCollapseCount, 0, 'handoff control values are expanded, not collapsed behind toggles');
    const handoffValues = await page.$$eval('.transcript .ln.k-text .tr-field-val', (els) => els.map((el) => el.textContent || ''));
    assert.ok(handoffValues.some((text) => text.includes(handoff.comment)), 'fenced handoff JSON comment is rendered readably');
    const handoffSteps = await page.$$eval('.transcript .ln.k-text .human-test-field ol li', (els) => els.map((el) => el.textContent || ''));
    assert.deepEqual(handoffSteps, [
      'Open the ticket transcript.',
      'Confirm the fenced control JSON is rendered as readable fields.',
      'Confirm the prose above the block remains readable.',
    ], 'fenced handoff human_test is rendered as a numbered list');
    const handoffProse = await page.$eval('.transcript .ln.k-text .tr-prose', (el) => el.textContent || '');
    assert.match(handoffProse, /Build complete\./, 'handoff prose before the fence remains visible');
    const textBodies = await page.$$eval('.transcript .ln.k-text .msg', (els) => els.map((el) => el.textContent || ''));
    assert.ok(textBodies.every((text) => !text.includes('```json')), 'handoff fence markers are not rendered as raw transcript text');

    assert.ok(textBodies.some((text) => text === 'not json: {broken'), 'malformed JSON stays plain');

    await clickFresh(page, '#modal-close');
    await page.waitForFunction(() => !document.querySelector('#overlay'));
    await clickFresh(page, '#btn-settings');
    await page.waitForSelector('.tabs [data-tab="appearance"]');
    await clickFresh(page, '.tabs [data-tab="appearance"]');
    await page.waitForSelector('[data-tr-color="tool"]');
    await page.$eval('[data-tr-color="tool"]', (el) => {
      el.value = '#123456';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tr-kind-tool').trim()),
      '#123456',
      'tool color CSS variable updates immediately',
    );

    await page.reload({ waitUntil: 'networkidle2' });
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tr-kind-tool').trim()),
      '#123456',
      'tool color preference survives reload',
    );

    await page.goto(`${harness.base}#${ticket.id}/transcript`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.transcript .ln.k-tool .tag');
    const tagColor = await page.$eval('.transcript .ln.k-tool .tag', (el) => getComputedStyle(el).color);
    assert.equal(tagColor, 'rgb(18, 52, 86)', 'custom tool color applies to transcript tag');

    console.log('e2e: transcript formatting checks passed');
  } finally {
    await browser.close();
    await harness.cleanup();
  }
})();
