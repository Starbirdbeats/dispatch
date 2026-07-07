// registry.mjs — model/effort registry + CLI health probe.
// Seeded from the installed CLIs where possible; every model field in the UI also accepts free text,
// because new models ship faster than any registry.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const run = promisify(execFile);

export const REGISTRY = {
  claude: {
    models: [
      { id: 'claude-fable-5', label: 'fable (Fable 5)' },
      { id: 'claude-opus-4-8', label: 'opus (Opus 4.8)' },
      { id: 'claude-sonnet-5', label: 'sonnet (Sonnet 5)' },
      { id: 'claude-haiku-4-5-20251001', label: 'haiku (Haiku 4.5)' },
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    permissions: ['auto', 'acceptEdits', 'manual', 'bypassPermissions'],
  },
  codex: {
    models: [
      { id: 'gpt-5.5', label: 'gpt-5.5' },
      { id: 'gpt-5.4', label: 'gpt-5.4' },
      { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
      { id: 'gpt-5.3-codex-spark', label: 'gpt-5.3-codex-spark' },
    ],
    efforts: ['low', 'medium', 'high', 'xhigh'],
    permissions: ['read-only', 'workspace-write', 'danger-full-access'],
  },
};

// Pull the user's configured default codex model into the registry so the dropdowns match reality.
export function loadCodexDefaults() {
  try {
    const toml = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
    const model = toml.match(/^model\s*=\s*"([^"]+)"/m)?.[1];
    if (model && !REGISTRY.codex.models.some((m) => m.id === model)) {
      REGISTRY.codex.models.unshift({ id: model, label: `${model} (config default)` });
    }
    return { model };
  } catch { return {}; }
}

export async function probe() {
  const result = { claude: { ok: false }, codex: { ok: false } };
  try {
    const { stdout } = await run('claude', ['--version'], { timeout: 15000 });
    result.claude = { ok: true, version: stdout.trim() };
  } catch (e) { result.claude.error = e.message; }
  try {
    const { stdout } = await run('codex', ['--version'], { timeout: 15000 });
    result.codex = { ok: true, version: stdout.trim() };
    const { stdout: auth } = await run('codex', ['login', 'status'], { timeout: 15000 });
    result.codex.auth = auth.trim();
  } catch (e) { result.codex.error = e.message; }
  return result;
}
