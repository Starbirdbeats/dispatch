import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startDispatchServer, waitForCondition } from './helpers.mjs';

// PICK UP NOW on a ticket that is mid-run has to end that run — the wake processor waits
// for the ticket to be free, so zeroing the countdown alone leaves the comment stranded
// behind a run that may take another 20 minutes. This drives the real server against a
// fake agent that never finishes on its own.

async function api(base, path, method = 'GET', body = null) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const ticketOf = async (base, id) => (await api(base, '/api/state')).tickets.find((t) => t.id === id);

// A claude that starts a session and then hangs, so the run stays live until it is killed.
function installHangingClaude(binDir) {
  fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "claude 1.0.0"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo '{"loggedIn":true,"authMethod":"claudeAiOauth","apiProvider":"firstParty"}'; exit 0
fi
echo '{"type":"system","subtype":"init","session_id":"e2e-session","model":"claude-opus-4-8"}'
sleep 600
`, 'utf8');
  fs.chmodSync(path.join(binDir, 'claude'), 0o755);
}

function makeRepo(root) {
  const repo = path.join(root, 'workspace');
  fs.mkdirSync(repo, { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'dispatch@example.invalid']);
  git(['config', 'user.name', 'Dispatch E2E']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# e2e\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'Initial commit']);
  return repo;
}

(async () => {
  const harness = await startDispatchServer({ claudeAuth: true, codexAuth: false });
  try {
    installHangingClaude(harness.bin);
    const workspace = makeRepo(harness.root);
    const { board } = await api(harness.base, '/api/state');
    const build = board.columns.find((c) => c.id === 'col-build');

    const ticket = await api(harness.base, '/api/tickets', 'POST', {
      title: 'Wake now during a run',
      description: 'e2e',
      workspace,
      columnId: build.id,
      overrides: { [build.id]: { type: 'claude', model: 'claude-opus-4-8', effort: 'high' } },
    });

    // 1. Get a run genuinely in flight.
    await api(harness.base, `/api/tickets/${ticket.id}/run`, 'POST', {});
    const running = await waitForCondition(async () => (await ticketOf(harness.base, ticket.id))?.activeRun, { timeoutMs: 20000 });
    assert.ok(running, 'the fake agent run is active');

    // 2. A comment on a running ticket schedules a wake that waits for the run.
    const posted = await api(harness.base, `/api/tickets/${ticket.id}/comment`, 'POST', {
      text: 'be sure to update the attached trello ticket',
      wakeHarness: { type: 'claude', model: 'claude-opus-4-8', effort: 'high' },
    });
    assert.equal(posted.running, true, 'the comment reports the ticket as running');
    assert.ok((await ticketOf(harness.base, ticket.id)).pendingWake, 'a wake is pending');

    // 3. Unforced pick-up-now must NOT silently no-op: it reports the run as the blocker.
    const soft = await api(harness.base, `/api/tickets/${ticket.id}/wake-now`, 'POST', {});
    assert.equal(soft.ok, false, 'unforced pick-up-now does not fire while a run is live');
    assert.equal(soft.running, true, 'unforced pick-up-now reports the run as the blocker');
    assert.ok((await ticketOf(harness.base, ticket.id)).activeRun, 'the run is untouched without force');

    // 4. Forced pick-up-now stops the run...
    const forced = await api(harness.base, `/api/tickets/${ticket.id}/wake-now`, 'POST', { force: true });
    assert.equal(forced.ok, true, 'forced pick-up-now is accepted');
    assert.equal(forced.stopped, true, 'forced pick-up-now reports stopping the run');

    // 5. ...and the wake actually fires afterwards, rather than stranding the comment.
    const pickedUp = await waitForCondition(async () => {
      const t = await ticketOf(harness.base, ticket.id);
      if (!t || t.pendingWake) return false;
      const fired = t.activity.some((a) => /comment wake fired/.test(a.text));
      return fired && (t.status === 'running' || t.status === 'queued' || Boolean(t.activeRun));
    }, { timeoutMs: 30000, intervalMs: 250 });

    const final = await ticketOf(harness.base, ticket.id);
    assert.ok(pickedUp, `the wake fired after the run was stopped (status=${final?.status}, pendingWake=${JSON.stringify(final?.pendingWake)})`);
    assert.ok(
      final.activity.some((a) => /stopping the current run to pick up/.test(a.text)),
      'the stop is recorded in the ticket activity',
    );

    console.log('wake-now e2e: PASS');
  } finally {
    await harness.cleanup();
  }
})();
