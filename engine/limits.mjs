export const CLAUDE_CONTEXT_WINDOW = 200_000;
export const CODEX_CONTEXT_WINDOW = 272_000;

export function clampPct(n) {
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

// Snapshot of a run's token telemetry. Context occupancy (contextTokens/pct) and the
// cumulative input/output split are independent — codex end-of-run usage has totals
// but no context reading, so either half may be absent (but never both).
export function contextSnapshot(usage) {
  if (!usage) return null;
  const contextTokens = Number(usage.contextTokens ?? NaN);
  const windowTokens = Number(usage.windowTokens ?? NaN);
  const hasContext = Number.isFinite(contextTokens) && Number.isFinite(windowTokens) && windowTokens > 0;
  const totals = {};
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens']) {
    const v = Number(usage[key] ?? NaN);
    if (Number.isFinite(v)) totals[key] = Math.max(0, Math.round(v));
  }
  const hasTotals = Number.isFinite(totals.inputTokens) || Number.isFinite(totals.outputTokens);
  if (!hasContext && !hasTotals) return null;
  const pct = hasContext ? clampPct((contextTokens / windowTokens) * 100) : null;
  return {
    contextTokens: hasContext ? Math.max(0, Math.round(contextTokens)) : null,
    windowTokens: Number.isFinite(windowTokens) && windowTokens > 0 ? Math.round(windowTokens) : null,
    model: usage.model || '',
    pct: pct == null ? null : Math.round(pct * 10) / 10,
    at: usage.at || new Date().toISOString(),
    ...totals,
  };
}
