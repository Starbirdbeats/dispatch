import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForCondition(check, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await wait(intervalMs);
  }
  return false;
}

async function waitForProcessExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.killed) return;
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error('process did not exit before timeout')), timeoutMs));
  try {
    await Promise.race([once(child, 'exit'), timer]);
  } catch {
    /* avoid throwing if this is called during cleanup after signal attempts */
  }
}

async function waitForServer(url, { timeoutMs = 12000 } = {}) {
  const ok = await waitForCondition(async () => {
    try {
      const res = await fetch(`${url}/api/state`);
      return res.ok;
    } catch {
      return false;
    }
  }, { timeoutMs });
  if (!ok) throw new Error(`dispatch server did not become ready: ${url}`);
}

function writeScript(file, body) {
  fs.writeFileSync(file, `#!/bin/sh\n${body.trim()}\n`, 'utf8');
  fs.chmodSync(file, 0o755);
}

function setupFakeClaude(home, token = 'e2e-token') {
  if (!token) return;
  const base = path.join(home, '.claude');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token } }, null, 2), 'utf8');
}

function setupFakeCodexBin(binDir, statusText = 'You are logged in as test@example.com') {
  writeScript(path.join(binDir, 'codex'), `
if [ "$1" = "--version" ]; then
  echo "codex 1.2.3"
  exit 0
fi

if [ "$1" = "app-server" ]; then
  while IFS= read -r line; do
    if [ -z "$line" ]; then
      continue
    fi

    if printf '%s' "$line" | grep -q '"id":1'; then
      echo '{ "jsonrpc":"2.0", "id": 1, "result": {} }'
      echo '{ "jsonrpc":"2.0", "id": 2, "result": { "rateLimitsByLimitId": { "codex": { "primary": { "usedPercent": 0, "resetsAt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'" }, "secondary": { "usedPercent": 0, "resetsAt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'" } } } } }'
      break
    elif printf '%s' "$line" | grep -q '"id":2'; then
      echo '{ "jsonrpc":"2.0", "id": 2, "result": { "rateLimitsByLimitId": { "codex": { "primary": { "usedPercent": 0, "resetsAt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'" }, "secondary": { "usedPercent": 0, "resetsAt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'" } } } } }'
      exit 0
    fi
  done
fi

if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  echo "${statusText}" 1>&2
  exit 0
fi

# Subscription login: print the auth URL to STDERR (as real codex-cli does) then block on
# the localhost callback. e2e drives the pending → cancel path; a marker file lets a test
# simulate success out-of-band.
if [ "$1" = "login" ]; then
  echo "Starting local login server on http://localhost:1455." 1>&2
  echo "navigate to https://auth.openai.com/oauth/authorize?client_id=fake-e2e&state=e2e" 1>&2
  sleep 120
  exit 0
fi

exit 1
`);
}

function setupFakeClaudeBin(binDir, version = 'claude 1.0.0') {
  writeScript(path.join(binDir, 'claude'), `
if [ "$1" = "--version" ]; then
  echo "${version}"
  exit 0
fi

# Subscription login: print the auth URL on STDOUT and wait for the one-time code on STDIN
# (mirrors \`claude auth login\`). On the expected code, write credentials so a subsequent
# \`auth status\` reports logged in — this is what flips the UI to AUTHENTICATED in e2e.
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  echo "Opening browser to sign in…"
  echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=fake-e2e&state=e2e"
  echo "Paste code here if prompted > "
  read code
  if [ "\$code" = "GOOD-CODE" ]; then
    mkdir -p "\$HOME/.claude"
    printf '%s' '{"claudeAiOauth":{"accessToken":"","expiresAt":0}}' > "\$HOME/.claude/.credentials.json"
    exit 0
  fi
  echo "invalid code" 1>&2
  exit 1
fi

if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -f "$HOME/.claude/.credentials.json" ]; then
    echo '{"loggedIn":true,"authMethod":"claudeAiOauth","apiProvider":"firstParty"}'
    exit 0
  fi
  echo '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'
  exit 1
fi

if [ "$1" = "setup-token" ]; then
  exit 0
fi

exit 1
`);
}

export function makeDispatchHarness({
  claudeAuth = true,
  codexAuth = true,
  claudeVersion = 'claude 1.0.0',
  codexVersion = 'codex 1.2.3',
  codexStatusText = 'You are logged in as test@example.com',
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dispatch-e2e-'));
  const work = path.join(root, 'dispatch-data');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const envFile = path.join(root, '.env');
  const dataDir = path.join(work, 'tickets');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(envFile, '', 'utf8');

  if (claudeAuth) setupFakeClaude(home);
  setupFakeClaudeBin(bin, claudeVersion);
  setupFakeCodexBin(bin, codexAuth ? codexStatusText : 'not logged in');

  return {
    root,
    dataDir: work,
    home,
    bin,
    envFile,
    env: {
      HOME: home,
      DISPATCH_DATA: work,
      DISPATCH_ENV_FILE: envFile,
    },
    codexVersion,
  };
}

export async function startDispatchServer(overrides = {}) {
  const harness = makeDispatchHarness(overrides);
  const port = overrides.port || await freePort();
  const env = {
    ...process.env,
    ...harness.env,
    DISPATCH_PORT: String(port),
    PATH: `${harness.bin}:${process.env.PATH}`,
  };

  const child = spawn('node', [path.join(ROOT_DIR, 'server.mjs')], {
    cwd: ROOT_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const bootBuffers = { stdout: [], stderr: [] };
  child.stdout.on('data', (chunk) => bootBuffers.stdout.push(String(chunk)));
  child.stderr.on('data', (chunk) => bootBuffers.stderr.push(String(chunk)));

  const waitForStartup = waitForServer(`http://127.0.0.1:${port}`);
  const done = await Promise.race([
    waitForStartup,
    new Promise((_, reject) => {
      child.once('exit', (code, signal) => {
        const out = bootBuffers.stdout.join('').trim();
        const err = bootBuffers.stderr.join('').trim();
        const details = [out && `stdout:\n${out}`, err && `stderr:\n${err}`].filter(Boolean).join('\n');
        reject(new Error(`server exited during startup (code=${code}, signal=${signal})${details ? `\n${details}` : ''}`));
      });
    }),
  ]);

  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    port,
    child,
    root: harness.root,
    dataDir: harness.dataDir,
    home: harness.home,
    bin: harness.bin,
    envFile: harness.envFile,
    cleanup: async () => {
      if (!child.killed) child.kill('SIGTERM');
      await waitForProcessExit(child, 5000).catch(() => {
        if (!child.killed) child.kill('SIGKILL');
      });
      await waitForProcessExit(child, 2000);
      fs.rmSync(harness.root, { recursive: true, force: true });
      return done;
    },
  };
}
