import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runner } from '../engine/runner.mjs';

test('harnessFor marks read-only tickets and forces provider sandbox modes', () => {
  const store = {
    effectiveHarness: (_ticket, column) => ({ ...column.harness }),
  };
  const runner = new Runner(store, () => {});
  const ticket = { readOnly: true, overrides: {} };

  const claude = runner.harnessFor(ticket, {
    harness: { type: 'claude', model: 'claude-fable-5', effort: 'high', permissions: 'acceptEdits' },
  });
  assert.equal(claude.permissions, 'manual');
  assert.equal(claude.readOnly, true);

  const codex = runner.harnessFor(ticket, {
    harness: { type: 'codex', model: 'gpt-5.5', effort: 'xhigh', permissions: 'workspace-write' },
  });
  assert.equal(codex.permissions, 'read-only');
  assert.equal(codex.readOnly, true);
});

test('_applyControl appends engine-managed dossier fields from control block', () => {
  const ticket = { id: 'ticket-a', status: 'running', holds: 0 };
  const column = { id: 'col-planning', name: 'Planning' };
  const activity = [];
  const workLog = [];
  const plans = [];
  const store = {
    appendActivity: (id, item) => activity.push({ id, item }),
    appendWorkLog: (id, text) => workLog.push({ id, text }),
    writePlan: (id, text) => plans.push({ id, text }),
  };
  const runner = new Runner(store, () => {});

  runner._applyControl(ticket, column, { type: 'codex' }, {
    action: 'hold',
    comment: 'Need one more pass.',
    work_log: 'Read-only investigation completed.',
    plan: '1. Inspect only.\n2. Report findings.',
  }, '');

  assert.equal(activity[0].item.kind, 'handoff');
  assert.equal(activity[0].item.text, 'Need one more pass.');
  assert.equal(workLog.length, 1);
  assert.equal(workLog[0].id, 'ticket-a');
  assert.match(workLog[0].text, /^### .* — codex \(Planning\) \[engine-appended\]\nRead-only investigation completed\.$/);
  assert.deepEqual(plans, [{ id: 'ticket-a', text: '1. Inspect only.\n2. Report findings.' }]);
  assert.equal(ticket.status, 'idle');
  assert.equal(ticket.stuckReason.kind, 'hold');
});
