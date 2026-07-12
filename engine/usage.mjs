import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../store.mjs';
import { clampPct } from './limits.mjs';

const CACHE_FILE = path.join(DATA_DIR, 'usage-cache.json');
const CACHE_VERSION = 1;

export const USAGE = {
  claude: { fiveHour: null, weekly: null, at: null, source: null },
  codex: { fiveHour: null, weekly: null, at: null, source: null },
};

function atomicWrite(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function normalizePercent(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  return clampPct(num);
}

function normalizeReset(value, atMs = Date.now()) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n < 31_536_000) return new Date(atMs + n * 1000).toISOString();
  return new Date((n < 10_000_000_000 ? n * 1000 : n)).toISOString();
}

export function normalizeUsageWindow(data, atMs = Date.now()) {
  if (!data) return null;
  const usedPct = normalizePercent(data.usedPct ?? data.usedPercent ?? data.used_percentage ?? data.used_percent ?? data.percent);
  if (usedPct == null) return null;
  return {
    usedPct: Math.round(usedPct * 10) / 10,
    resetsAt: normalizeReset(data.resetsAt ?? data.resets_at ?? data.reset ?? data.resets_in_seconds, atMs),
  };
}

export function loadUsageCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (cached.version !== CACHE_VERSION) return;
    for (const provider of ['claude', 'codex']) {
      if (!cached[provider]) continue;
      USAGE[provider] = {
        fiveHour: normalizeUsageWindow(cached[provider].fiveHour) || null,
        weekly: normalizeUsageWindow(cached[provider].weekly) || null,
        at: cached[provider].at || null,
        source: cached[provider].source || null,
        ...(cached[provider].plan ? { plan: String(cached[provider].plan) } : {}),
        ...(cached[provider].error ? { error: String(cached[provider].error) } : {}),
      };
    }
  } catch { /* empty cache is fine */ }
}

export function saveUsageCache() {
  try {
    atomicWrite(CACHE_FILE, JSON.stringify({
      version: CACHE_VERSION,
      claude: USAGE.claude,
      codex: USAGE.codex,
    }, null, 2));
  } catch { /* cache is best-effort */ }
}

export function setProviderUsage(provider, { fiveHour = null, weekly = null, at = new Date().toISOString(), source = 'unknown', error = null } = {}) {
  if (!USAGE[provider]) return false;
  const next = {
    fiveHour: normalizeUsageWindow(fiveHour) || null,
    weekly: normalizeUsageWindow(weekly) || null,
    at,
    source,
    ...(USAGE[provider].plan ? { plan: USAGE[provider].plan } : {}),  // plan comes from local auth files, not the usage APIs — survive refreshes
    ...(error ? { error: String(error).slice(0, 240) } : {}),
  };
  const before = JSON.stringify(USAGE[provider]);
  USAGE[provider] = next;
  const changed = before !== JSON.stringify(next);
  if (changed) saveUsageCache();
  return changed;
}

// Subscription tier ("max", "plus", …) read from local CLI auth files — display-only.
export function setProviderPlan(provider, plan) {
  if (!USAGE[provider]) return false;
  const next = plan ? String(plan).toLowerCase() : null;
  if ((USAGE[provider].plan || null) === next) return false;
  if (next) USAGE[provider].plan = next;
  else delete USAGE[provider].plan;
  saveUsageCache();
  return true;
}

export function setProviderWindow(provider, window, data, { at = new Date().toISOString(), source = 'unknown' } = {}) {
  if (!USAGE[provider] || !['fiveHour', 'weekly'].includes(window)) return false;
  const normalized = normalizeUsageWindow(data);
  if (!normalized) return false;
  const before = JSON.stringify(USAGE[provider]);
  USAGE[provider] = {
    ...USAGE[provider],
    [window]: normalized,
    at,
    source,
  };
  delete USAGE[provider].error;
  const changed = before !== JSON.stringify(USAGE[provider]);
  if (changed) saveUsageCache();
  return changed;
}

export function codexRateLimitWindows(rateLimits, { at = new Date().toISOString() } = {}) {
  const out = {};
  if (!rateLimits || typeof rateLimits !== 'object') return out;
  const atMs = Date.parse(at) || Date.now();
  for (const raw of Object.values(rateLimits)) {
    if (!raw || typeof raw !== 'object') continue;
    const minutes = Number(raw.window_minutes ?? raw.windowMinutes ?? raw.windowDurationMins ?? raw.window_duration_mins ?? raw.window);
    const usedPct = raw.used_percent ?? raw.used_percentage ?? raw.usedPct ?? raw.usedPercent;
    if (!Number.isFinite(minutes) || usedPct == null) continue;
    const window = minutes <= 360 ? 'fiveHour' : 'weekly';
    out[window] = {
      usedPct,
      resetsAt: raw.resets_at ?? raw.resetsAt ?? (raw.resets_in_seconds != null ? new Date(atMs + Number(raw.resets_in_seconds) * 1000).toISOString() : null),
    };
  }
  return out;
}

export function applyCodexRateLimits(rateLimits, { at = new Date().toISOString(), source = 'codex-stream' } = {}) {
  const windows = codexRateLimitWindows(rateLimits, { at });
  let changed = false;
  for (const [window, data] of Object.entries(windows)) {
    changed = setProviderWindow('codex', window, data, { at, source }) || changed;
  }
  return changed;
}
