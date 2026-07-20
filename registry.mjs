// registry.mjs — model/effort registry: authoritative live sources, layered fallbacks, cache.
//
// "Latest models + their effort levels" is resolved per provider through an ordered source chain:
//
//   claude:  1. api.anthropic.com/v1/models with Claude Code's own OAuth token
//               (official Models API; capabilities.effort gives per-model effort levels)
//            2. platform.claude.com models docs page (scrape — models only)
//            3. last successful cache (models-cache.json)
//            4. built-in seed
//   codex:   1. `codex app-server` JSON-RPC `model/list`
//               (the ChatGPT-authed picker list; per-model supportedReasoningEfforts + default)
//            2. developers.openai.com/codex/models docs page (scrape — models only)
//            3. cache  4. seed
//
// An authoritative hit REPLACES that provider's list (it is the truth for what this account can
// run), then curated labels are re-attached by id and any model still referenced by a column or
// ticket override is kept (marked stale) so existing configs never lose their selection.
// See docs/models-registry.md for the full design.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const run = promisify(execFile);

const SEED = {
  claude: [
    { id: 'claude-fable-5', label: 'fable (Fable 5)' },
    { id: 'claude-opus-4-8', label: 'opus (Opus 4.8)' },
    { id: 'claude-sonnet-5', label: 'sonnet (Sonnet 5)' },
    { id: 'claude-haiku-4-5-20251001', label: 'haiku (Haiku 4.5)' },
  ],
  codex: [
    { id: 'gpt-5.6-sol', label: 'sol (GPT-5.6 Sol)' },
    { id: 'gpt-5.6-terra', label: 'terra (GPT-5.6 Terra)' },
    { id: 'gpt-5.6-luna', label: 'luna (GPT-5.6 Luna)' },
    { id: 'gpt-5.5', label: 'gpt-5.5' },
    { id: 'gpt-5.3-codex-spark', label: 'gpt-5.3-codex-spark' },
  ],
};
const CURATED_LABELS = new Map(SEED.claude.concat(SEED.codex).map((m) => [m.id, m.label]));

export const REGISTRY = {
  claude: {
    models: structuredClone(SEED.claude),
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], // type-level fallback when a model has none
    permissions: ['auto', 'acceptEdits', 'manual', 'bypassPermissions'],
    meta: { source: 'seed', fetchedAt: null },
  },
  codex: {
    models: structuredClone(SEED.codex),
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], // 'ultra' is GPT-5.6 Sol/Terra only
    permissions: ['read-only', 'workspace-write', 'danger-full-access'],
    meta: { source: 'seed', fetchedAt: null },
  },
};

const DATA_DIR = process.env.DISPATCH_DATA || path.join(os.homedir(), 'dispatch-data');
const MODELS_CACHE = path.join(DATA_DIR, 'models-cache.json');
const CACHE_VERSION = 2;

/* ================= source 1a: Anthropic Models API (OAuth) ================= */

export const CLAUDE_OAUTH_TOKEN_MISSING = 'CLAUDE_OAUTH_TOKEN_MISSING';
export const CLAUDE_OAUTH_TOKEN_EXPIRED = 'CLAUDE_OAUTH_TOKEN_EXPIRED';
export const CLAUDE_OAUTH_TOKEN_UNREADABLE = 'CLAUDE_OAUTH_TOKEN_UNREADABLE';

export class ClaudeOAuthTokenError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'ClaudeOAuthTokenError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

export function isClaudeOAuthTokenUnavailable(err) {
  return err instanceof ClaudeOAuthTokenError
    && [CLAUDE_OAUTH_TOKEN_MISSING, CLAUDE_OAUTH_TOKEN_UNREADABLE].includes(err.code);
}

export function readClaudeOAuthToken() {
  // Claude Code may keep the token in a keyring; when an env token is provided it is
  // the only readable OAuth material Dispatch has for account usage/model APIs.
  const envToken = String(process.env.CLAUDE_CODE_OAUTH_TOKEN || '').trim();
  if (envToken) return envToken;

  // Claude Code refreshes this file itself; read fresh every time, never cache or log it.
  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'));
  } catch (e) {
    throw new ClaudeOAuthTokenError(
      e.code === 'ENOENT' ? CLAUDE_OAUTH_TOKEN_MISSING : CLAUDE_OAUTH_TOKEN_UNREADABLE,
      'claude oauth token unavailable',
      e,
    );
  }
  const oauth = creds.claudeAiOauth || creds;
  const token = String(oauth.accessToken || '').trim();
  if (!token) throw new ClaudeOAuthTokenError(CLAUDE_OAUTH_TOKEN_MISSING, 'claude oauth token unavailable');
  const expiresAt = Number(oauth.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0 && Date.now() > expiresAt) {
    throw new ClaudeOAuthTokenError(CLAUDE_OAUTH_TOKEN_EXPIRED, 'claude oauth token expired');
  }
  return token;
}

// capabilities.effort → ordered effort list; explicit [] means "model takes no effort param"
export function effortsFromCapabilities(caps) {
  const eff = caps?.effort;
  if (!eff || eff.supported === false) return [];
  const order = ['low', 'medium', 'high', 'xhigh', 'max'];
  return order.filter((lvl) => eff[lvl]?.supported);
}

async function fetchClaudeModelsAPI() {
  const token = readClaudeOAuthToken();
  const headers = {
    authorization: `Bearer ${token}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20',
  };
  const models = [];
  let url = 'https://api.anthropic.com/v1/models?limit=100';
  for (let page = 0; page < 5; page++) { // pagination guard
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`models API ${res.status}`);
    const body = await res.json();
    for (const m of body.data || []) {
      models.push({
        id: m.id,
        label: CURATED_LABELS.get(m.id) || m.display_name || m.id,
        efforts: effortsFromCapabilities(m.capabilities),
        defaultEffort: null,
      });
    }
    if (!body.has_more || !body.data?.length) break;
    url = `https://api.anthropic.com/v1/models?limit=100&after_id=${encodeURIComponent(body.data.at(-1).id)}`;
  }
  if (!models.length) throw new Error('models API returned empty list');
  return models;
}

/* ================= source 1b: Codex app-server model/list ================= */

function fetchCodexAppServerModels({ timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const rl = readline.createInterface({ input: proc.stdout });
    const models = [];
    let settled = false;
    const safeSend = (o) => {
      if (!proc.stdin || proc.stdin.destroyed || proc.stdin.writableEnded) return false;
      try {
        proc.stdin.write(JSON.stringify(o) + '\n');
        return true;
      } catch (e) {
        finish(e);
        return false;
      }
    };
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill(); } catch {}
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('app-server timeout')), timeoutMs);
    proc.on('error', (e) => finish(e));
    proc.stdin.on('error', (e) => finish(e));
    proc.on('exit', () => { if (!settled) finish(new Error('app-server exited early')); });
    let reqId = 1;
    const list = (cursor) => safeSend({ jsonrpc: '2.0', id: ++reqId, method: 'model/list', params: { includeHidden: false, cursor: cursor ?? null } });
    rl.on('line', (l) => {
      let m; try { m = JSON.parse(l); } catch { return; }
      if (m.id === 1) { // initialize response
        if (m.error) return finish(new Error(`initialize: ${m.error.message}`));
        if (safeSend({ jsonrpc: '2.0', method: 'initialized' })) list();
      } else if (m.id >= 2) {
        if (m.error) return finish(new Error(`model/list: ${m.error.message}`));
        for (const mod of m.result?.data || []) {
          const id = mod.model || mod.id;
          models.push({
            id,
            label: CURATED_LABELS.get(id) || mod.displayName || id,
            efforts: (mod.supportedReasoningEfforts || []).map((e) => e.reasoningEffort || e).filter(Boolean),
            defaultEffort: mod.defaultReasoningEffort || null,
          });
        }
        if (m.result?.nextCursor) list(m.result.nextCursor);
        else models.length ? finish(null, models) : finish(new Error('model/list returned empty'));
      }
    });
    safeSend({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'dispatch', title: 'Dispatch', version: '0.1.0' } } });
  });
}

/* ================= source 2: docs-page scrape (models only) ================= */

const DOCS_SOURCES = {
  claude: 'https://platform.claude.com/docs/en/docs/about-claude/models/overview',
  codex: 'https://developers.openai.com/codex/models',
};

function truncate(value, max = 180) {
  const v = String(value || '').trim().replace(/[\r\n]+/g, ' ');
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

function normalizeProbeError(e, fallback = 'command failed') {
  if (!e) return fallback;
  if (typeof e === 'string') return truncate(e);
  if (e.message) return truncate(e.message);
  return fallback;
}

function parseCodexAuth(stdout) {
  const raw = String(stdout || '').trim();
  const lower = raw.toLowerCase();
  if (!raw) return { authenticated: null, detail: '' };
  if (/not logged|not authenticated|please log ?in|requires login|login required|signed out|expired/.test(lower)) {
    return { authenticated: false, detail: truncate(raw) };
  }
  if (/error|denied|failed/.test(lower)) {
    return { authenticated: null, detail: truncate(raw) };
  }
  return { authenticated: true, detail: truncate(raw) };
}

// `claude auth status --json` → { loggedIn, authMethod, apiProvider }. Modern Claude Code
// keeps the token in the OS keyring (not .credentials.json), so the CLI is the source of
// truth. Returns authenticated:null when the output can't be understood (caller falls back).
function parseClaudeAuth(raw) {
  const text = String(raw || '').trim();
  if (!text) return { authenticated: null, detail: '' };
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      const method = String(obj.authMethod || '').toLowerCase();
      const loggedIn = obj.loggedIn === true || (method !== '' && method !== 'none');
      if (obj.loggedIn === true || obj.loggedIn === false || method) {
        const detail = loggedIn
          ? (method && method !== 'none' ? `authenticated · ${method}` : 'authenticated')
          : 'not authenticated';
        return { authenticated: loggedIn, detail };
      }
    } catch { /* not JSON — fall through to text heuristics */ }
  }
  const lower = text.toLowerCase();
  if (/not logged|logged out|not authenticated|signed out|please log ?in|login required|no auth/.test(lower)) {
    return { authenticated: false, detail: truncate(text) };
  }
  if (/logged in|authenticated|active session/.test(lower)) {
    return { authenticated: true, detail: truncate(text) };
  }
  return { authenticated: null, detail: truncate(text) };
}

// lookahead (?!\d) rejects truncated slugs like "claude-opus-47" (would-be "claude-opus-4")
export function parseModelIds(type, html) {
  const re = type === 'claude'
    ? /claude-(?:opus|sonnet|haiku|fable|mythos)-\d(?:-\d)*(?:-\d{8})?(?!\d)/gi
    : /gpt-\d\.\d(?:-[a-z]+)*/gi;
  return [...new Set([...html.matchAll(re)].map((m) => m[0].toLowerCase()))];
}

async function fetchDocsModels(type) {
  const res = await fetch(DOCS_SOURCES[type], { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Dispatch/0.1' } });
  if (!res.ok) throw new Error(`docs page ${res.status}`);
  const ids = parseModelIds(type, await res.text());
  if (!ids.length) throw new Error('docs page yielded no model ids');
  return ids.map((id) => ({ id, label: CURATED_LABELS.get(id) || id, efforts: null, defaultEffort: null }));
}

/* ================= union / apply ================= */

// Models still referenced by board columns or ticket overrides must never vanish from the
// dropdowns, even if the provider retired them — they're kept and marked stale.
export function applyModels(registry, type, fetched, source, inUseIds = new Set()) {
  const byId = new Map(fetched.map((m) => [m.id, { ...m }]));
  for (const old of registry[type].models) {
    if (!byId.has(old.id) && inUseIds.has(old.id)) byId.set(old.id, { ...old, stale: true });
  }
  registry[type].models = [...byId.values()];
  registry[type].meta = { source, fetchedAt: new Date().toISOString() };
}

/* ================= public: refresh ================= */

export async function refreshModels({ inUse = { claude: new Set(), codex: new Set() } } = {}) {
  const report = {};
  const chains = {
    claude: [
      ['anthropic-api', fetchClaudeModelsAPI],
      ['docs', () => fetchDocsModels('claude')],
    ],
    codex: [
      ['codex-app-server', fetchCodexAppServerModels],
      ['docs', () => fetchDocsModels('codex')],
    ],
  };
  for (const [type, chain] of Object.entries(chains)) {
    const errors = [];
    let applied = false;
    for (const [name, fn] of chain) {
      try {
        const models = await fn();
        applyModels(REGISTRY, type, models, name, inUse[type]);
        report[type] = { ok: true, source: name, count: models.length };
        applied = true;
        break;
      } catch (e) {
        errors.push(`${name}: ${e.message}`);
      }
    }
    if (!applied) report[type] = { ok: false, errors, kept: REGISTRY[type].meta.source }; // cache/seed stays
  }
  saveModelsCache();
  return report;
}

/* ================= cache (survives restarts) ================= */

function saveModelsCache() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MODELS_CACHE, JSON.stringify({
      version: CACHE_VERSION,
      claude: { models: REGISTRY.claude.models, meta: REGISTRY.claude.meta },
      codex: { models: REGISTRY.codex.models, meta: REGISTRY.codex.meta },
    }, null, 2));
  } catch { /* cache is best-effort */ }
}

export function loadModelsCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(MODELS_CACHE, 'utf8'));
    if (cached.version !== CACHE_VERSION) return; // stale schema → reseed via refresh
    for (const type of ['claude', 'codex']) {
      if (cached[type]?.models?.length) {
        REGISTRY[type].models = cached[type].models;
        REGISTRY[type].meta = cached[type].meta || { source: 'cache', fetchedAt: null };
      }
    }
  } catch { /* no cache yet */ }
}

// Age of the freshest data we have — drives boot-time and periodic auto-refresh.
export function registryAgeMs() {
  const stamps = [REGISTRY.claude.meta.fetchedAt, REGISTRY.codex.meta.fetchedAt].filter(Boolean).map((s) => Date.parse(s));
  if (!stamps.length) return Infinity;
  return Date.now() - Math.min(...stamps);
}

/* ================= codex config default + CLI probe (unchanged) ================= */

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
  const result = {
    claude: { ok: false, installed: false, authenticated: false, authDetail: '', version: null, error: null },
    codex: { ok: false, installed: false, authenticated: false, authDetail: '', version: null, error: null },
  };

  // Claude: installed status from `claude --version`.
  try {
    const { stdout } = await run('claude', ['--version'], { timeout: 15000 });
    result.claude.installed = true;
    result.claude.ok = true;
    result.claude.version = truncate(stdout, 60);
  } catch (e) { result.claude.error = normalizeProbeError(e); }
  // Claude auth: ask the CLI (`claude auth status --json`) — the token lives in the OS
  // keyring on modern Claude Code, so the file may exist with an empty token. Fall back to
  // the OAuth token file / env key for older CLIs or key-based (non-interactive) auth.
  try {
    let parsed = { authenticated: null, detail: '' };
    try {
      const { stdout, stderr } = await run('claude', ['auth', 'status', '--json'], { timeout: 15000 });
      parsed = parseClaudeAuth(stdout);
      if (parsed.authenticated === null) parsed = parseClaudeAuth(stderr);
    } catch (statusErr) {
      // `claude auth status --json` exits non-zero when logged out but still prints the
      // JSON verdict on stdout; ENOENT (older CLI without the subcommand) yields neither,
      // leaving parsed indeterminate so we fall back to the token file below.
      parsed = parseClaudeAuth(statusErr.stdout);
      if (parsed.authenticated === null) parsed = parseClaudeAuth(statusErr.stderr);
    }

    if (parsed.authenticated === true) {
      result.claude.authenticated = true;
      result.claude.authDetail = parsed.detail || 'authenticated';
    } else if (parsed.authenticated === false) {
      result.claude.authenticated = false;
      result.claude.authDetail = parsed.detail || 'not authenticated';
    } else if (String(process.env.CLAUDE_CODE_OAUTH_TOKEN || '').trim() || String(process.env.ANTHROPIC_API_KEY || '').trim()) {
      result.claude.authenticated = true;
      result.claude.authDetail = 'authenticated · api key';
    } else {
      readClaudeOAuthToken(); // throws if the file has no usable token
      result.claude.authenticated = true;
      result.claude.authDetail = 'authenticated';
    }
  } catch (e) {
    result.claude.authenticated = false;
    result.claude.authDetail = normalizeProbeError(e.message || e, 'not authenticated');
  }

  // Codex: installed status from `codex --version`.
  try {
    const { stdout } = await run('codex', ['--version'], { timeout: 15000 });
    result.codex.installed = true;
    result.codex.ok = true;
    result.codex.version = truncate(stdout, 60);
  } catch (e) { result.codex.error = normalizeProbeError(e); }
  // Codex auth from `codex login status`. Modern codex-cli prints the status line to
  // STDERR, so parse whichever stream carries a verdict (and the error streams on non-zero
  // exit) rather than reading stdout alone.
  if (result.codex.installed) {
    try {
      const { stdout, stderr } = await run('codex', ['login', 'status'], { timeout: 15000 });
      let parsed = parseCodexAuth(stdout);
      if (parsed.authenticated === null) parsed = parseCodexAuth(stderr);
      result.codex.authenticated = Boolean(parsed.authenticated);
      result.codex.authDetail = parsed.detail || (parsed.authenticated === false ? 'not authenticated' : '');
    } catch (e) {
      let parsed = parseCodexAuth(e.stdout);
      if (parsed.authenticated === null) parsed = parseCodexAuth(e.stderr);
      if (parsed.authenticated === null) {
        result.codex.authDetail = normalizeProbeError(e, 'not authenticated');
      } else {
        result.codex.authenticated = Boolean(parsed.authenticated);
        result.codex.authDetail = parsed.detail || 'not authenticated';
      }
    }
  }

  return result;
}
