import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyGraftEnv,
  buildGraftRuntime,
  graftEnabled,
  graftTimeoutSec,
} from '../engine/graft.mjs';
import { composePrompt } from '../engine/contract.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GRAFT_WORKER = path.join(ROOT, 'engine', 'graft.mjs');
const RUN_WRAPPER = path.join(ROOT, 'bin', 'dispatch-run.sh');

function initRepo(dir) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'dispatch@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Dispatch Test'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: dir, stdio: 'ignore' });
}

function runIndex(workDir, graphDir) {
  const stdout = execFileSync(
    process.execPath,
    [GRAFT_WORKER, 'index', workDir, graphDir],
    { encoding: 'utf8', timeout: 20_000 },
  );
  return JSON.parse(stdout.trim());
}

function callMcp(mcp, name, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(mcp.command, mcp.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Graft MCP timed out: ${stderr}`));
    }, 10_000);

    const finish = (fn, value) => {
      clearTimeout(timer);
      proc.kill('SIGTERM');
      fn(value);
    };
    proc.on('error', (err) => finish(reject, err));
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf('\n')) !== -1) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 2) finish(resolve, message);
      }
    });

    proc.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dispatch-test', version: '1' } },
    })}\n`);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    proc.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    })}\n`);
  });
}

test('Graft worker indexes outside the repo, reuses cache, and serves updated code over MCP', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-graft-real-'));
  const repo = path.join(temp, 'repo with spaces');
  const dataDir = path.join(temp, 'ticket data');
  try {
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const source = path.join(repo, 'src', 'greet.js');
    fs.writeFileSync(source, 'export function greet(name) { return `hello ${name}`; }\n');
    initRepo(repo);

    const runtime = buildGraftRuntime({ workDir: repo, dataDir });
    assert.ok(runtime);
    const first = runIndex(repo, runtime.graphDir);
    assert.equal(first.files, 1);
    assert.equal(first.parsed, 1);
    assert.equal(first.reused, 0);
    assert.equal(fs.existsSync(path.join(runtime.graphDir, '.graph', 'wiring.json')), true);
    assert.equal(fs.existsSync(path.join(runtime.graphDir, 'INDEX.md')), true);
    assert.equal(fs.existsSync(path.join(runtime.graphDir, 'src', 'greet.md')), true);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), '');
    assert.equal(fs.existsSync(path.join(repo, 'graft')), false);
    assert.equal(fs.existsSync(path.join(repo, '.ignore')), false);
    assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false);

    const second = runIndex(repo, runtime.graphDir);
    assert.equal(second.parsed, 0);
    assert.equal(second.reused, 1);

    fs.writeFileSync(
      source,
      [
        'export function greet(name) { return `hello ${name}`; }',
        'export function farewellMessage(name) { return `goodbye ${name}`; }',
        '',
      ].join('\n'),
    );
    const third = runIndex(repo, runtime.graphDir);
    assert.equal(third.parsed, 1);
    assert.equal(third.reused, 0);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), ' M src/greet.js\n');

    const response = await callMcp(runtime.mcp, 'graft_find_code', { query: 'farewellMessage' });
    assert.equal(response.result?.isError, false);
    assert.match(response.result.content[0].text, /farewellMessage/);
    assert.match(response.result.content[0].text, /src\/greet\.js/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Graft runtime is default-on, configurable, path-safe, and completely omittable', () => {
  assert.equal(graftEnabled({}), true);
  assert.equal(graftEnabled({ DISPATCH_GRAFT: 'false' }), false);
  assert.equal(graftEnabled({ DISPATCH_GRAFT: 'OFF' }), false);
  assert.equal(graftEnabled({ DISPATCH_GRAFT: '1' }), true);
  assert.equal(graftTimeoutSec({}), 120);
  assert.equal(graftTimeoutSec({ DISPATCH_GRAFT_TIMEOUT_SEC: 'bad' }), 120);
  assert.equal(graftTimeoutSec({ DISPATCH_GRAFT_TIMEOUT_SEC: '0' }), 1);
  assert.equal(graftTimeoutSec({ DISPATCH_GRAFT_TIMEOUT_SEC: '99999' }), 1800);

  const runtime = buildGraftRuntime({
    workDir: '/tmp/work space',
    dataDir: '/tmp/ticket data',
    env: {},
  });
  assert.ok(runtime);
  assert.equal(runtime.graphDir, '/tmp/ticket data/graft');
  assert.deepEqual(runtime.mcp.args.slice(-5), [
    runtime.mcp.args[0],
    '--dir',
    '/tmp/ticket data/graft',
    'mcp',
    '/tmp/work space',
  ]);

  const env = applyGraftEnv({ PATH: '/usr/bin', KEEP: 'yes' }, runtime);
  assert.equal(env.KEEP, 'yes');
  assert.equal(env.GRAFT_DIR, runtime.graphDir);
  assert.equal(env.DISPATCH_GRAFT_ROOT, '/tmp/work space');
  assert.ok(env.PATH.startsWith(`${runtime.binDir}${path.delimiter}`));

  assert.equal(buildGraftRuntime({
    workDir: '/tmp/work',
    dataDir: '/tmp/ticket',
    env: { DISPATCH_GRAFT: '0' },
  }), null);
  assert.equal(buildGraftRuntime({
    workDir: '/tmp/work',
    dataDir: '/tmp/work/dispatch-data/ticket',
    env: {},
  }), null, 'an index inside the target tree must be disabled instead of mutating the repo');
  assert.deepEqual(applyGraftEnv({ PATH: '/usr/bin' }, null), { PATH: '/usr/bin' });
});

test('Graft prompt guidance is concise, worktree-specific, and optional', () => {
  const common = {
    ticket: { title: 'Change greeting', workspace: '/tmp/shared-repo' },
    column: { name: 'Build', phasePrompt: 'Build it.' },
    harness: { type: 'codex', permissions: 'workspace-write' },
    dossierPath: '/tmp/ticket/DOSSIER.md',
    recentActivity: [],
    resume: false,
    workDir: '/tmp/worktree',
  };
  const withGraft = composePrompt({
    ...common,
    graft: { enabled: true, graphDir: '/tmp/ticket/graft' },
  });
  assert.match(withGraft, /## Graft repo index/);
  assert.match(withGraft, /repo-map/);
  assert.match(withGraft, /call-trace/);
  assert.match(withGraft, /\/tmp\/ticket\/graft\/INDEX\.md/);
  assert.match(withGraft, /never a blocker/);
  assert.doesNotMatch(composePrompt(common), /## Graft repo index/);
});

test('unsupported-language repositories produce a valid empty graph', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-graft-empty-'));
  try {
    const repo = path.join(temp, 'repo');
    const graph = path.join(temp, 'ticket', 'graft');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'README.md'), '# no supported source\n');
    const result = runIndex(repo, graph);
    assert.equal(result.files, 0);
    assert.equal(result.nodes, 0);
    assert.equal(fs.existsSync(path.join(graph, '.graph', 'wiring.json')), true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

function writeWrapperFixtures(temp) {
  const indexer = path.join(temp, 'fake indexer.mjs');
  const provider = path.join(temp, 'fake provider.mjs');
  fs.writeFileSync(indexer, `
import fs from 'node:fs';
import path from 'node:path';
const mode = process.env.FAKE_INDEX_MODE || 'success';
const graphDir = process.argv[4];
if (mode === 'slow') {
  setInterval(() => {}, 1000);
} else if (mode === 'fail') {
  process.exit(9);
} else {
  fs.mkdirSync(graphDir, { recursive: true });
  fs.writeFileSync(path.join(graphDir, 'ready'), 'yes');
  process.stdout.write('{"parsed":1,"reused":0}\\n');
}
`);
  fs.writeFileSync(provider, `
import fs from 'node:fs';
import path from 'node:path';
const graphDir = process.env.DISPATCH_GRAFT_GRAPH_DIR;
if (process.env.REQUIRE_INDEX === '1' && !fs.existsSync(path.join(graphDir, 'ready'))) process.exit(31);
fs.writeFileSync(process.env.PROVIDER_MARKER, 'ran');
process.exit(Number(process.env.PROVIDER_EXIT || 0));
`);
  return { indexer, provider };
}

function wrapperEnv({ temp, indexer, mode, timeout = 5, providerExit = 0, requireIndex = false }) {
  return {
    ...process.env,
    DISPATCH_GRAFT_INDEXER: indexer,
    DISPATCH_GRAFT_NODE: process.execPath,
    DISPATCH_GRAFT_ROOT: path.join(temp, 'work tree'),
    DISPATCH_GRAFT_GRAPH_DIR: path.join(temp, 'ticket data', 'graft'),
    DISPATCH_GRAFT_TIMEOUT_SEC: String(timeout),
    FAKE_INDEX_MODE: mode,
    PROVIDER_MARKER: path.join(temp, 'provider-ran'),
    PROVIDER_EXIT: String(providerExit),
    REQUIRE_INDEX: requireIndex ? '1' : '0',
  };
}

function runWrapper(temp, fixtures, env) {
  const runDir = path.join(temp, `run-${Date.now()}-${Math.random()}`);
  const result = spawnSync(
    'bash',
    [RUN_WRAPPER, runDir, '--', process.execPath, fixtures.provider],
    { env, encoding: 'utf8', timeout: 15_000 },
  );
  return { runDir, result };
}

test('run wrapper indexes first and preserves the provider exit code', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-graft-wrapper-ok-'));
  try {
    fs.mkdirSync(path.join(temp, 'work tree'), { recursive: true });
    const fixtures = writeWrapperFixtures(temp);
    const env = wrapperEnv({
      temp,
      indexer: fixtures.indexer,
      mode: 'success',
      providerExit: 7,
      requireIndex: true,
    });
    const { runDir, result } = runWrapper(temp, fixtures, env);
    assert.equal(result.status, 7);
    assert.equal(fs.existsSync(env.PROVIDER_MARKER), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'graft-index.json'))), { status: 'ready', code: 0 });
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'exit.json'))).code, 7);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('run wrapper fails open after an index error or timeout', () => {
  for (const [mode, timeout, expected] of [
    ['fail', 5, 'failed'],
    ['slow', 1, 'timed-out'],
  ]) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), `dispatch-graft-wrapper-${mode}-`));
    try {
      fs.mkdirSync(path.join(temp, 'work tree'), { recursive: true });
      const fixtures = writeWrapperFixtures(temp);
      const env = wrapperEnv({ temp, indexer: fixtures.indexer, mode, timeout });
      const { runDir, result } = runWrapper(temp, fixtures, env);
      assert.equal(result.status, 0);
      assert.equal(fs.existsSync(env.PROVIDER_MARKER), true);
      assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'graft-index.json'))).status, expected);
      assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'exit.json'))).code, 0);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
});

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${file}`);
}

test('stopping the wrapper during indexing never starts the provider', { timeout: 10_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-graft-wrapper-stop-'));
  try {
    fs.mkdirSync(path.join(temp, 'work tree'), { recursive: true });
    const fixtures = writeWrapperFixtures(temp);
    const env = wrapperEnv({ temp, indexer: fixtures.indexer, mode: 'slow', timeout: 30 });
    const runDir = path.join(temp, 'run');
    const proc = spawn(
      'bash',
      [RUN_WRAPPER, runDir, '--', process.execPath, fixtures.provider],
      { env, stdio: 'ignore' },
    );
    await waitForFile(path.join(runDir, 'child.pid'));
    proc.kill('SIGTERM');
    const code = await new Promise((resolve, reject) => {
      proc.once('error', reject);
      proc.once('exit', resolve);
    });
    assert.equal(code, 143);
    assert.equal(fs.existsSync(env.PROVIDER_MARKER), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'exit.json'))).code, 143);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
