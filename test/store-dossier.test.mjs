import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function tempStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-store-'));
  const previous = process.env.DISPATCH_DATA;
  process.env.DISPATCH_DATA = dataDir;
  const { Store } = await import(`../store.mjs?test=${Date.now()}-${Math.random()}`);
  if (previous === undefined) delete process.env.DISPATCH_DATA;
  else process.env.DISPATCH_DATA = previous;
  return { store: new Store(), dataDir };
}

test('store appends work log entries and replaces plan inside dossier sections', async () => {
  const { store, dataDir } = await tempStore();
  try {
    const ticket = store.createTicket({
      title: 'Read only',
      description: 'Readonly handoff',
      workspace: dataDir,
      attachments: [],
    });

    assert.equal(store.appendWorkLog(ticket.id, '### first\nFirst entry'), true);
    assert.equal(store.appendWorkLog(ticket.id, '### second\nSecond entry'), true);
    assert.equal(store.writePlan(ticket.id, 'New plan body'), true);

    const doc = store.readDossier(ticket.id);
    assert.match(doc, /## Plan\nNew plan body\n\n## Work Log/);
    assert.ok(doc.indexOf('### first') < doc.indexOf('### second'));
    assert.ok(doc.indexOf('### second') < doc.indexOf('## Open Questions'));
    assert.equal((doc.match(/### first/g) || []).length, 1);
    assert.equal((doc.match(/### second/g) || []).length, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
