// capacity.mjs — what this machine can actually run at once.
//
// MAX CONCURRENT RUNS is the one setting where a wrong value fails silently and
// expensively: agent runs compile real projects, so oversubscribing cores or disk doesn't
// error, it just makes every run crawl until the timeout kills it mid-build. Dispatch
// already knows the hardware — this turns that into a recommendation the settings screen
// can show, plus WHICH resource is the binding constraint (a bare number is a mystery;
// "limited by disk" tells you what to go fix).
import os from 'node:os';
import fs from 'node:fs';

// Per-run budgets, sized for a heavy Rust/native build — the worst case Dispatch runs.
const CORES_PER_RUN = 2;   // a compile will happily saturate more; 2 is the floor before thrashing
const RAM_GB_PER_RUN = 8;  // linking is the memory spike, not compiling
const DISK_GB_COLD = 50;   // one from-scratch target dir, with headroom
const DISK_GB_SHARED = 10; // with a shared cache only the first run pays the full cost

export const MAX_CONCURRENT = 8; // matches the settings input's ceiling

export function freeDiskGB(dir) {
  try {
    const s = fs.statfsSync(dir);
    return (s.bavail * s.bsize) / 1e9;
  } catch {
    return null; // unsupported platform → disk simply stops constraining the answer
  }
}

// Returns the most pessimistic of the three limits, never below 1 (Dispatch must always be
// able to run something; 0 is reserved for the explicit pause switch).
export function recommendConcurrency({ cores, ramGB, freeGB, sharedCache = false }) {
  const diskPerRun = sharedCache ? DISK_GB_SHARED : DISK_GB_COLD;
  const limits = [
    { by: 'cpu', n: Math.floor(cores / CORES_PER_RUN) },
    { by: 'ram', n: Math.floor(ramGB / RAM_GB_PER_RUN) },
  ];
  if (Number.isFinite(freeGB)) limits.push({ by: 'disk', n: Math.floor(freeGB / diskPerRun) });

  const tightest = limits.reduce((a, b) => (b.n < a.n ? b : a));
  return {
    recommended: Math.max(1, Math.min(tightest.n, MAX_CONCURRENT)),
    limitedBy: tightest.by,
    // Surfaced so the UI can say "disk is the limit" honestly even when the clamp to 1 hides
    // how far under we are — floor(7/50) is 0, and "recommended 1" alone wouldn't convey that.
    starved: tightest.n < 1,
    limits: Object.fromEntries(limits.map((l) => [l.by, l.n])),
  };
}

export function systemCapacity(dataDir, { sharedCache = false } = {}) {
  const cores = os.cpus().length;
  const ramGB = os.totalmem() / 1e9;
  const freeGB = freeDiskGB(dataDir);
  return {
    cores,
    ramGB: Math.round(ramGB),
    freeGB: freeGB == null ? null : Math.round(freeGB),
    sharedCache,
    ...recommendConcurrency({ cores, ramGB, freeGB: freeGB ?? Infinity, sharedCache }),
  };
}
