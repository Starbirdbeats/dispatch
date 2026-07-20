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

test('createTicket stores maxBounces as integer or null inheritance', async () => {
  const { store, dataDir } = await tempStore();
  try {
    const inherited = store.createTicket({
      title: 'Inherited cap',
      description: '',
      workspace: dataDir,
      attachments: [],
      maxBounces: null,
    });
    const capped = store.createTicket({
      title: 'Explicit cap',
      description: '',
      workspace: dataDir,
      attachments: [],
      maxBounces: '2.9',
    });

    assert.equal(inherited.maxBounces, null);
    assert.equal(capped.maxBounces, 2);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('store prunes disposable build caches from isolated worktrees only', async () => {
  const { store, dataDir } = await tempStore();
  try {
    const ticket = store.createTicket({
      title: 'Cache cleanup',
      description: '',
      workspace: dataDir,
      attachments: [],
    });
    const root = path.join(store.worktreesRoot(), ticket.id);
    const sourceDir = path.join(root, 'src');
    const nested = path.join(root, 'frontend');
    fs.mkdirSync(path.join(sourceDir, 'target'), { recursive: true });
    fs.mkdirSync(path.join(nested, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(nested, '.next'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'app.js'), 'console.log("keep");\n');
    fs.writeFileSync(path.join(sourceDir, 'target', 'artifact'), 'remove');
    fs.writeFileSync(path.join(nested, 'node_modules', 'dep'), 'remove');
    fs.writeFileSync(path.join(nested, '.next', 'bundle'), 'remove');

    const { removed } = store.pruneTicketWorktree(ticket.id);

    assert.deepEqual(removed.sort(), ['frontend/.next', 'frontend/node_modules', 'src/target']);
    assert.equal(fs.existsSync(path.join(sourceDir, 'app.js')), true);
    assert.equal(fs.existsSync(path.join(sourceDir, 'target')), false);
    assert.equal(fs.existsSync(path.join(nested, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(nested, '.next')), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
