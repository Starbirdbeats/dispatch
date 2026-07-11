import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeClockRunning, reconcileActiveClock } from '../store.mjs';

const agentColumn = { role: 'agent' };
const intakeColumn = { role: 'intake' };
const terminalColumn = { role: 'terminal' };

test('active clock excludes parked human wait and freezes on done', () => {
  const t0 = 1_000_000;
  const ticket = {
    startedAt: new Date(t0).toISOString(),
    status: 'running',
  };

  reconcileActiveClock(ticket, agentColumn, t0);
  assert.equal(ticket.activeMs, 0);
  assert.equal(ticket.activeSince, t0);

  ticket.status = 'awaiting-human';
  reconcileActiveClock(ticket, agentColumn, t0 + 60_000);
  assert.equal(ticket.activeMs, 60_000);
  assert.equal(ticket.activeSince, null);

  reconcileActiveClock(ticket, agentColumn, t0 + 360_000);
  assert.equal(ticket.activeMs, 60_000);
  assert.equal(ticket.activeSince, null);

  ticket.status = 'queued';
  reconcileActiveClock(ticket, agentColumn, t0 + 360_000);
  assert.equal(ticket.activeMs, 60_000);
  assert.equal(ticket.activeSince, t0 + 360_000);

  ticket.status = 'running';
  ticket.completedAt = new Date(t0 + 390_000).toISOString();
  reconcileActiveClock(ticket, agentColumn, t0 + 390_000);
  assert.equal(ticket.activeMs, 90_000);
  assert.equal(ticket.activeSince, null);
});

test('active clock is idempotent and never runs outside agent columns', () => {
  const ticket = {
    startedAt: new Date(1_000).toISOString(),
    status: 'queued',
    activeMs: 10_000,
  };

  assert.equal(activeClockRunning(ticket, intakeColumn), false);
  reconcileActiveClock(ticket, intakeColumn, 2_000);
  assert.equal(ticket.activeMs, 10_000);
  assert.equal(ticket.activeSince, undefined);

  reconcileActiveClock(ticket, terminalColumn, 3_000);
  assert.equal(ticket.activeMs, 10_000);
  assert.equal(ticket.activeSince, undefined);

  reconcileActiveClock(ticket, agentColumn, 4_000);
  assert.equal(ticket.activeSince, 4_000);
  reconcileActiveClock(ticket, agentColumn, 5_000);
  assert.equal(ticket.activeMs, 10_000);
  assert.equal(ticket.activeSince, 4_000);
});

test('active clock initializes missing accumulator during migration', () => {
  const ticket = {
    startedAt: new Date(1_000).toISOString(),
    status: 'running',
  };

  reconcileActiveClock(ticket, agentColumn, 2_000);
  assert.equal(ticket.activeMs, 0);
  assert.equal(ticket.activeSince, 2_000);
});
