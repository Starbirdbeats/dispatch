// graft.mjs — per-ticket Graft runtime configuration and isolated index worker.
//
// The Dispatch server imports only the light configuration helpers below. The
// comparatively large native tree-sitter dependency is loaded in the detached
// run wrapper's child process, so a broken optional runtime cannot crash the
// long-lived server.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const MODULE_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.dirname(path.dirname(MODULE_FILE));
const DEFAULT_TIMEOUT_SEC = 120;
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 1800;
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);

export const GRAFT_MCP_TOOLS = [
  'graft_find_code',
  'graft_file_api',
  'graft_trace_calls',
  'graft_find_all',
  'graft_repo_map',
  'graft_check_freshness',
];

export function graftEnabled(env = process.env) {
  const value = env.DISPATCH_GRAFT;
  if (value === undefined || value === null || String(value).trim() === '') return true;
  return !FALSE_VALUES.has(String(value).trim().toLowerCase());
}

export function graftTimeoutSec(env = process.env) {
  const raw = Number(env.DISPATCH_GRAFT_TIMEOUT_SEC);
  if (!Number.isFinite(raw)) return DEFAULT_TIMEOUT_SEC;
  return Math.min(MAX_TIMEOUT_SEC, Math.max(MIN_TIMEOUT_SEC, Math.floor(raw)));
}

export function resolveGraftInstall() {
  try {
    const packageFile = require.resolve('@nanonets/graft/package.json');
    const packageDir = path.dirname(packageFile);
    const cliFile = path.join(packageDir, 'dist', 'cli.js');
    if (!fs.statSync(cliFile).isFile()) return null;
    return {
      packageDir,
      cliFile,
      binDir: path.join(PROJECT_ROOT, 'node_modules', '.bin'),
    };
  } catch {
    return null;
  }
}

function canonicalPath(value) {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

function canonicalOutputPath(value) {
  try { return fs.realpathSync(value); } catch {
    return path.join(canonicalPath(path.dirname(value)), path.basename(value));
  }
}

function isInside(parent, candidate) {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

export function buildGraftRuntime({ workDir, dataDir, graphDir: graphDirOverride, env = process.env } = {}) {
  if (!graftEnabled(env) || !workDir || !dataDir) return null;
  const install = resolveGraftInstall();
  if (!install) return null;

  const root = canonicalPath(workDir);
  const graphDir = canonicalOutputPath(graphDirOverride || path.join(canonicalPath(dataDir), 'graft'));
  // Graft's full graph projection self-manages .gitignore/.ignore when its
  // output is inside the indexed tree. Dispatch promises never to mutate a
  // repository merely by indexing it, so an unusually nested DISPATCH_DATA
  // configuration must degrade to no Graft instead.
  if (isInside(root, graphDir)) return null;
  const timeoutSec = graftTimeoutSec(env);
  const mcp = {
    command: process.execPath,
    args: [install.cliFile, '--dir', graphDir, 'mcp', root],
  };

  return {
    enabled: true,
    root,
    graphDir,
    timeoutSec,
    indexerFile: MODULE_FILE,
    nodeFile: process.execPath,
    binDir: install.binDir,
    mcp,
  };
}

export function applyGraftEnv(baseEnv, graft) {
  if (!graft?.enabled) return { ...baseEnv };
  const currentPath = String(baseEnv?.PATH || '');
  const prefixedPath = currentPath
    ? `${graft.binDir}${path.delimiter}${currentPath}`
    : graft.binDir;
  return {
    ...baseEnv,
    PATH: prefixedPath,
    GRAFT_DIR: graft.graphDir,
    DISPATCH_GRAFT_INDEXER: graft.indexerFile,
    DISPATCH_GRAFT_NODE: graft.nodeFile,
    DISPATCH_GRAFT_ROOT: graft.root,
    DISPATCH_GRAFT_GRAPH_DIR: graft.graphDir,
    DISPATCH_GRAFT_TIMEOUT_SEC: String(graft.timeoutSec),
  };
}

function compactResult(result) {
  return {
    files: Number(result?.files || 0),
    parsed: Number(result?.parsed || 0),
    reused: Number(result?.reused || 0),
    nodes: Number(result?.nodes || 0),
    edges: Number(result?.edges || 0),
    languages: Array.isArray(result?.languages) ? result.languages : [],
    errors: Array.isArray(result?.errors)
      ? result.errors.slice(0, 100).map((error) => String(error).slice(0, 500))
      : [],
  };
}

async function runIndexWorker(args) {
  const [workDir, graphDir] = args;
  if (!workDir || !graphDir) {
    throw new Error('usage: node engine/graft.mjs index <workDir> <graphDir>');
  }
  const stat = fs.statSync(workDir);
  if (!stat.isDirectory()) throw new Error(`Graft workspace is not a directory: ${workDir}`);

  // Dynamic by design: see the module header. This is the only place the native
  // parsers enter a Dispatch-owned process.
  const { Graft } = await import('@nanonets/graft');
  const result = await new Graft({ contextDir: path.resolve(graphDir) })
    .graph(path.resolve(workDir), { reuse: true });
  process.stdout.write(`${JSON.stringify(compactResult(result))}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === MODULE_FILE;
if (isMain) {
  if (process.argv[2] !== 'index') {
    process.stderr.write('usage: node engine/graft.mjs index <workDir> <graphDir>\n');
    process.exitCode = 64;
  } else {
    runIndexWorker(process.argv.slice(3)).catch((err) => {
      process.stderr.write(`graft index failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
  }
}
