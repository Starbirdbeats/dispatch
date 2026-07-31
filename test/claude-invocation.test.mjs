import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvocation, parseLine } from '../engine/claude.mjs';

function allowedToolsArg(args) {
  const idx = args.indexOf('--allowedTools');
  return idx === -1 ? null : args[idx + 1];
}

const GRAFT = {
  enabled: true,
  graphDir: '/tmp/dispatch ticket/graft',
  mcp: {
    command: '/opt/dispatch node/bin/node',
    args: ['/opt/dispatch/graft cli.js', '--dir', '/tmp/dispatch ticket/graft', 'mcp', '/tmp/work space'],
  },
};

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

test('manual-permission Claude invocation carves out dossier writes', () => {
  const { args } = buildInvocation({
    prompt: 'prompt',
    dataDir: '/tmp/dispatch-ticket',
    sessionId: null,
    harness: {
      type: 'claude',
      model: 'claude-fable-5',
      effort: 'high',
      permissions: 'manual',
      allowedTools: 'Bash(git log *)',
    },
  });

  const allowed = allowedToolsArg(args);
  assert.ok(allowed);
  // Headless manual mode denies anything off the allowlist — the dossier must stay writable.
  assert.match(allowed, /Write\(\/\/tmp\/dispatch-ticket\/\*\*\)/);
  assert.match(allowed, /Edit\(\/\/tmp\/dispatch-ticket\/\*\*\)/);
  assert.match(allowed, /Bash\(git log \*\)/, 'configured rules must be kept');
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

test('Claude invocation registers the ticket Graft MCP and allows it in restricted runs', () => {
  const { args } = buildInvocation({
    prompt: 'prompt',
    dataDir: '/tmp/dispatch ticket',
    sessionId: 'session-id',
    graft: GRAFT,
    harness: {
      type: 'claude',
      permissions: 'manual',
      allowedTools: 'Bash(git *) Read',
    },
  });

  const mcpIndex = args.indexOf('--mcp-config');
  assert.notEqual(mcpIndex, -1);
  assert.deepEqual(JSON.parse(args[mcpIndex + 1]), {
    mcpServers: {
      graft: {
        command: GRAFT.mcp.command,
        args: GRAFT.mcp.args,
      },
    },
  });
  const allowed = allowedToolsArg(args);
  assert.match(allowed, /Bash\(git \*\)/);
  for (const tool of [
    'graft_find_code',
    'graft_file_api',
    'graft_trace_calls',
    'graft_find_all',
    'graft_repo_map',
    'graft_check_freshness',
  ]) {
    assert.match(allowed, new RegExp(`mcp__graft__${tool}`));
  }
});

test('Graft MCP does not turn an unrestricted Claude run into an allowlist', () => {
  const { args } = buildInvocation({
    prompt: 'prompt',
    dataDir: '/tmp/dispatch-ticket',
    sessionId: null,
    graft: GRAFT,
    harness: { type: 'claude', permissions: 'acceptEdits' },
  });

  assert.equal(allowedToolsArg(args), null);
  assert.notEqual(args.indexOf('--mcp-config'), -1);
});

test('Claude tool events preserve full structured input for transcript rendering', () => {
  const longCommand = `printf '${'x'.repeat(240)}'`;
  const event = {
    type: 'assistant',
    message: {
      model: 'claude-fable-5',
      content: [{
        type: 'tool_use',
        name: 'Bash',
        input: {
          command: longCommand,
          description: 'Exercise a long tool payload that used to be truncated before transcript rendering',
        },
      }],
    },
  };

  const out = parseLine(JSON.stringify(event), {});
  assert.deepEqual(out, [{
    kind: 'tool',
    text: 'Bash',
    json: event.message.content[0].input,
  }]);
  assert.equal(out[0].json.command, longCommand);
  assert.doesNotMatch(JSON.stringify(out[0]), /…/);
});
