import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const BRIDGE_TOOLS = ['dispatch_spawn', 'dispatch_status', 'dispatch_message', 'dispatch_wait'];

export function bridgeInvocation(configFile, client = 'orchestrator') {
  return { command: process.execPath, args: [fileURLToPath(new URL('./agent-bridge.mjs', import.meta.url)), configFile, client] };
}

export function createAgentBridge({ runDir, workspace, gitDir, harness, enabledProviders }) {
  if (!harness.subagents?.type || harness.subagents.type === harness.type) return null;
  const worker = harness.subagents;
  if (!enabledProviders.includes(worker.type)) throw new Error(`Subagent provider ${worker.type} is disabled. Enable it in Settings before running this phase.`);
  const readOnly = Boolean(harness.readOnly) || ['read-only', 'manual'].includes(harness.permissions);
  const profiles = {
    [harness.type]: { ...harness, subagents: undefined },
    [worker.type]: {
      type: worker.type, model: worker.model, effort: worker.effort,
      permissions: worker.permissions || (worker.type === 'codex' ? 'workspace-write' : 'acceptEdits'),
      network: Boolean(harness.network),
    },
  };
  // Never transfer a permissive parent setting into a different provider implicitly.
  for (const profile of Object.values(profiles)) {
    profile.readOnly = readOnly;
    if (readOnly) profile.permissions = profile.type === 'codex' ? 'workspace-write' : 'manual';
  }
  fs.mkdirSync(runDir, { recursive: true });
  const configFile = path.join(runDir, 'agent-bridge.json');
  const key = crypto.createHash('sha256').update(runDir).digest('hex').slice(0, 24);
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\dispatch-${key}` : path.join(os.tmpdir(), `dispatch-${key}.sock`);
  // macOS Unix socket paths are limited to 104 bytes. /tmp is the short alias.
  const socketPath = process.platform === 'darwin' ? `/tmp/dispatch-${key}.sock` : socket;
  const config = { runDir, workspace, gitDir, profiles, defaultType: worker.type,
    socketPath, maxAgents: 12, maxConcurrent: 4, timeoutMs: 30 * 60 * 1000 };
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  return { configFile, mcp: bridgeInvocation(configFile) };
}
