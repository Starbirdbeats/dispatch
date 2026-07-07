// contract.mjs — the hand-off contract between Dispatch and any harness.
// Composes the per-run prompt and parses the structured control block agents must emit.

export function composePrompt({ ticket, column, harness, dossierPath, recentActivity, resume }) {
  const lines = [];

  lines.push(`# Dispatch run — ticket "${ticket.title}" — phase "${column.name}"`);
  lines.push('');
  lines.push(column.phasePrompt || `You are handling the "${column.name}" phase of this ticket.`);
  if (column.exitCriteria) lines.push(`\nExit criteria for this phase: ${column.exitCriteria}`);

  lines.push('\n## Ticket');
  lines.push(`Title: ${ticket.title}`);
  if (ticket.description) lines.push(`Description:\n${ticket.description}`);
  lines.push(`Workspace (your cwd): ${ticket.workspace}`);

  lines.push('\n## Shared context — READ FIRST');
  lines.push(`The ticket dossier lives at: ${dossierPath}`);
  if (resume) {
    lines.push('You have worked on this ticket before in this same session; the dossier may have new entries from other agents or the human since then. Re-read it before acting.');
  } else {
    lines.push('It contains the brief, the plan, and work logs from every phase so far (possibly written by a different agent). Read the whole file before doing anything else. Do not ask the human to re-explain anything that is in the dossier.');
  }

  if (recentActivity?.length) {
    lines.push('\n## Recent ticket activity (newest last)');
    for (const a of recentActivity) lines.push(`- [${a.by}] ${a.text}`);
  }

  lines.push('\n## Tooling notes');
  lines.push('- Puppeteer is available for browser automation (`npm install puppeteer` in a scratch dir) if you need to scrape, test UI, or drive a headless browser.');
  if (harness.type === 'claude' && harness.chrome) {
    lines.push('- The Claude-in-Chrome extension is enabled for this run; you may drive the real browser.');
  }

  lines.push('\n## Hand-off contract (MANDATORY)');
  lines.push(`1. Before finishing, APPEND a dated entry to the "## Work Log" section of the dossier (${dossierPath}): what you did, key decisions, gotchas, and what the next phase needs to know. If this phase produced a plan, write it into "## Plan".`);
  lines.push('2. End your FINAL message with exactly one fenced json block:');
  lines.push('```json');
  lines.push('{"action": "advance" | "hold" | "bounce" | "flag_human",');
  lines.push(' "target_column": "<column name — required for bounce, optional for advance>",');
  lines.push(' "comment": "<one-paragraph summary posted to the ticket>",');
  lines.push(' "human_test": "<step-by-step human test instructions, or NONE: <reason> — REQUIRED when advancing to Done>"}');
  lines.push('```');
  lines.push('- "advance": phase complete, move the ticket forward.');
  lines.push('- "hold": you did work but the phase is not complete (e.g. you need another run).');
  lines.push('- "bounce": send the ticket back to an earlier phase with specifics in "comment".');
  lines.push('- "flag_human": you are blocked on something only the human can decide.');

  return lines.join('\n');
}

// Find the last json control block in the agent's final message.
export function parseControlBlock(text) {
  if (!text) return null;
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const candidates = fenced.map((m) => m[1]);
  // Fallback: bare object containing "action"
  const bare = [...text.matchAll(/\{[^{}]*"action"[\s\S]*?\}/g)].map((m) => m[0]);
  for (const raw of [...candidates.reverse(), ...bare.reverse()]) {
    try {
      const obj = JSON.parse(raw.trim());
      if (obj && typeof obj === 'object' && ['advance', 'hold', 'bounce', 'flag_human'].includes(obj.action)) {
        return obj;
      }
    } catch { /* try next */ }
  }
  return null;
}
