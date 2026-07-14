import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvocation } from '../engine/claude.mjs';

function allowedToolsArg(args) {
  const idx = args.indexOf('--allowedTools');
  return idx === -1 ? null : args[idx + 1];
}

test('read-only Claude invocation allows dossier writes in the ticket data dir only', () => {
  const { args } = buildInvocation({
    prompt: 'prompt',
    dataDir: '/tmp/dispatch-ticket',
    sessionId: null,
    harness: {
      type: 'claude',
      model: 'claude-fable-5',
      effort: 'high',
      permissions: 'manual',
      allowedTools: 'Bash(git *) Write(/tmp/other/**)',
      readOnly: true,
    },
  });

  const allowed = allowedToolsArg(args);
  assert.ok(allowed);
  assert.match(allowed, /\bRead\b/);
  assert.match(allowed, /\bGlob\b/);
  assert.match(allowed, /\bGrep\b/);
  assert.match(allowed, /\bLS\b/);
  assert.match(allowed, /Write\(\/\/tmp\/dispatch-ticket\/\*\*\)/);
  assert.match(allowed, /Edit\(\/\/tmp\/dispatch-ticket\/\*\*\)/);
  assert.doesNotMatch(allowed, /\bBash\b/);
  assert.doesNotMatch(allowed, /\/tmp\/other/);
});

test('non-read-only Claude invocation leaves allowedTools behavior unchanged', () => {
  const configured = buildInvocation({
    prompt: 'prompt',
    dataDir: '/tmp/dispatch-ticket',
    sessionId: 'session-id',
    harness: { type: 'claude', permissions: 'acceptEdits', allowedTools: 'Read Grep' },
  });
  assert.equal(allowedToolsArg(configured.args), 'Read Grep');

  const unset = buildInvocation({
    prompt: 'prompt',
    dataDir: '/tmp/dispatch-ticket',
    sessionId: 'session-id',
    harness: { type: 'claude', permissions: 'acceptEdits' },
  });
  assert.equal(allowedToolsArg(unset.args), null);
});
