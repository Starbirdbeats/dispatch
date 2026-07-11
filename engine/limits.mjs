export const CLAUDE_CONTEXT_WINDOW = 200_000;
export const CODEX_CONTEXT_WINDOW = 272_000;

export function clampPct(n) {
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

export function contextSnapshot(usage) {
  if (!usage) return null;
  const contextTokens = Number(usage.contextTokens);
  const windowTokens = Number(usage.windowTokens);
  if (!Number.isFinite(contextTokens) || !Number.isFinite(windowTokens) || windowTokens <= 0) return null;
  const pct = clampPct((contextTokens / windowTokens) * 100);
  if (pct == null) return null;
  return {
    contextTokens: Math.max(0, Math.round(contextTokens)),
    windowTokens: Math.round(windowTokens),
    model: usage.model || '',
    pct: Math.round(pct * 10) / 10,
    at: usage.at || new Date().toISOString(),
  };
}
