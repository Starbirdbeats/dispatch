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

// ---- live model discovery ----
// There's no CLI/API to list models without provider keys, so "refresh" scrapes the official
// model docs pages for IDs and unions them into the registry (never removes a known model).
const MODEL_SOURCES = {
  claude: 'https://platform.claude.com/docs/en/docs/about-claude/models/overview',
  codex: 'https://developers.openai.com/codex/models',
};
const MODELS_CACHE = path.join(process.env.DISPATCH_DATA || path.join(os.homedir(), 'dispatch-data'), 'models-cache.json');

function parseModelIds(type, html) {
  // lookahead (?!\d) rejects truncated slugs like "claude-opus-47" (would-be "claude-opus-4")
  const re = type === 'claude'
    ? /claude-(?:opus|sonnet|haiku|fable|mythos)-\d(?:-\d)*(?:-\d{8})?(?!\d)/gi
    : /gpt-\d\.\d(?:-[a-z]+)*/gi;
  return [...new Set([...html.matchAll(re)].map((m) => m[0].toLowerCase()))];
}

export async function refreshModels() {
  const found = {};
  for (const [type, url] of Object.entries(MODEL_SOURCES)) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Dispatch/0.1' } });
      found[type] = res.ok ? parseModelIds(type, await res.text()) : null;
    } catch { found[type] = null; }
  }
  let added = 0;
  const failures = [];
  for (const type of ['claude', 'codex']) {
    if (!found[type]?.length) { if (found[type] === null) failures.push(type); continue; }
    const byId = new Map(REGISTRY[type].models.map((m) => [m.id, m])); // preserve curated labels
    for (const id of found[type]) if (!byId.has(id)) { byId.set(id, { id, label: id }); added++; }
    REGISTRY[type].models = [...byId.values()];
  }
  saveModelsCache();
  return { added, failures, counts: { claude: REGISTRY.claude.models.length, codex: REGISTRY.codex.models.length } };
}

function saveModelsCache() {
  try {
    fs.mkdirSync(path.dirname(MODELS_CACHE), { recursive: true });
    fs.writeFileSync(MODELS_CACHE, JSON.stringify({ claude: REGISTRY.claude.models, codex: REGISTRY.codex.models }, null, 2));
  } catch { /* cache is best-effort */ }
}

// Merge a previously-refreshed cache back in at boot so discovered models survive restarts.
export function loadModelsCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(MODELS_CACHE, 'utf8'));
    for (const type of ['claude', 'codex']) {
      const byId = new Map(REGISTRY[type].models.map((m) => [m.id, m]));
      for (const m of cached[type] || []) if (m?.id && !byId.has(m.id)) byId.set(m.id, m);
      REGISTRY[type].models = [...byId.values()];
    }
  } catch { /* no cache yet */ }
}

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
