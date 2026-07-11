import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MANAGED_RUNTIME_KEYS = new Set();

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function validateEnvKey(key) {
  const k = String(key || '').trim();
  if (!ENV_KEY_RE.test(k)) throw new Error('invalid env key');
  return k;
}

function stripInlineComment(value) {
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '#' && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trimEnd();
}

function decodeDoubleQuoted(value) {
  return value.replace(/\\([nrt"\\$])/g, (_, c) => {
    if (c === 'n') return '\n';
    if (c === 'r') return '\r';
    if (c === 't') return '\t';
    return c;
  });
}

function parseValue(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    let out = '';
    let escaped = false;
    for (let i = 1; i < value.length; i++) {
      const c = value[i];
      if (escaped) { out += `\\${c}`; escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') return decodeDoubleQuoted(out);
      out += c;
    }
    return decodeDoubleQuoted(out);
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  return stripInlineComment(raw);
}

function parseLine(line, index) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match) return null;
  return {
    key: match[1],
    value: parseValue(match[2]),
    line: index,
    raw: line,
  };
}

export function parseEnv(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const entry = parseLine(lines[i], i);
    if (entry) entries.push(entry);
  }
  return { lines, entries };
}

export function serializeEnvValue(value) {
  const v = String(value ?? '');
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(v)) return v;
  return `"${v
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')}"`;
}

function lineKey(line) {
  return parseLine(line, 0)?.key || null;
}

function ensureFinalNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

export function upsertEnvValue(text, key, value) {
  const k = validateEnvKey(key);
  const replacement = `${k}=${serializeEnvValue(value)}`;
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines.at(-1) === '') lines.pop();

  let inserted = false;
  const next = [];
  for (const line of lines) {
    if (lineKey(line) !== k) {
      next.push(line);
      continue;
    }
    if (!inserted) {
      next.push(replacement);
      inserted = true;
    }
  }
  if (!inserted) next.push(replacement);
  return ensureFinalNewline(next.join('\n'));
}

export function deleteEnvKey(text, key) {
  const k = validateEnvKey(key);
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines.at(-1) === '') lines.pop();
  return ensureFinalNewline(lines.filter((line) => lineKey(line) !== k).join('\n'));
}

export function readEnvFile(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

export function writeEnvFile(file, text) {
  atomicWrite(file, ensureFinalNewline(String(text || '')));
}

export function ensureEnvFile(file) {
  if (!fs.existsSync(file)) {
    writeEnvFile(file, '# Dispatch local secrets. Edited by Settings; never commit this file.\n');
  }
}

export function loadEnvFile(file, { override = false } = {}) {
  const { entries } = parseEnv(readEnvFile(file));
  for (const { key, value } of entries) {
    if (override || process.env[key] == null) {
      process.env[key] = value;
      MANAGED_RUNTIME_KEYS.add(key);
    }
  }
  return entries;
}

export function envEntries(file, runtime = process.env) {
  const { entries } = parseEnv(readEnvFile(file));
  const fileValues = new Map();
  for (const entry of entries) fileValues.set(entry.key, entry.value);
  const keys = new Set([...Object.keys(runtime), ...fileValues.keys()]);
  return [...keys].sort((a, b) => a.localeCompare(b)).map((key) => ({
    key,
    value: fileValues.has(key) ? fileValues.get(key) : String(runtime[key] ?? ''),
    inFile: fileValues.has(key),
    inRuntime: runtime[key] != null,
    editable: true,
  }));
}

export function upsertEnvFileValue(file, key, value) {
  const text = upsertEnvValue(readEnvFile(file), key, value);
  writeEnvFile(file, text);
  const k = validateEnvKey(key);
  process.env[k] = String(value ?? '');
  MANAGED_RUNTIME_KEYS.add(k);
  return envEntries(file);
}

export function deleteEnvFileValue(file, key) {
  const k = validateEnvKey(key);
  const text = deleteEnvKey(readEnvFile(file), k);
  writeEnvFile(file, text);
  const stillInFile = parseEnv(text).entries.some((entry) => entry.key === k);
  if (!stillInFile && MANAGED_RUNTIME_KEYS.has(k)) {
    delete process.env[k];
    MANAGED_RUNTIME_KEYS.delete(k);
  }
  return envEntries(file);
}
