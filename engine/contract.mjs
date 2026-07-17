// contract.mjs — the hand-off contract between Dispatch and any harness.
// Composes the per-run prompt and parses the structured control block agents must emit.

export function composePrompt({ ticket, column, harness, dossierPath, recentActivity, resume, workDir }) {
  const lines = [];

  lines.push(`# Dispatch run — ticket "${ticket.title}" — phase "${column.name}"`);
  lines.push('');
  lines.push(column.phasePrompt || `You are handling the "${column.name}" phase of this ticket.`);
  if (column.exitCriteria) lines.push(`\nExit criteria for this phase: ${column.exitCriteria}`);

  lines.push('\n## Ticket');
  lines.push(`Title: ${ticket.title}`);
  if (ticket.description) lines.push(`Description:\n${ticket.description}`);
  const runDir = workDir || ticket.workspace;
  lines.push(`Workspace repo to inspect: ${runDir}`);
  if (ticket.branchName) lines.push(`Working branch: ${ticket.branchName}`);
  if (ticket.branchless?.kind === 'workspace-not-git') {
    lines.push('Working branch: NONE — workspace is not a Git repository.');
  }
  if (runDir !== ticket.workspace) {
    lines.push('\n## ISOLATED WORKTREE');
    lines.push(`Your working directory ${runDir} is a private git worktree of ${ticket.workspace}, dedicated to this ticket. Do ALL repo work inside it — never edit, switch branches in, or run commands against the main checkout at ${ticket.workspace}; the human and other tickets use that one. Commits you make here land in the shared repository on your working branch as normal. Note: untracked files from the main checkout (.env files, node_modules, build output) do not exist in a worktree — recreate or install whatever you need here. Git submodules (if any) are initialized at their recorded commits with detached HEADs; if the ticket needs submodule work, create/switch submodule branches yourself before committing there.`);
  }

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

  if (ticket.readOnly) {
    lines.push('\n## READ-ONLY TICKET');
    lines.push('This ticket is READ-ONLY: analyse/read the repo for context only. Do NOT attempt to edit workspace files, run migrations, or commit — the goal is understanding, not changes. You may still edit the ticket dossier in the ticket data dir. Codex read-only runs may have their cwd set to the ticket data dir instead of the workspace; use the absolute workspace path above when reading the repo. You must still complete the hand-off. Try the normal dossier Work Log/Plan update first; if your sandbox denies the dossier write, do not retry. Instead include the Work Log entry body as "work_log" in your control block, and include "plan" only if this phase produced or updated the plan. Dispatch will write those fields into the dossier for you.');
  } else if (ticket.branchless?.kind === 'workspace-not-git') {
    lines.push('\n## BRANCHLESS WORKSPACE');
    lines.push('This workspace is an existing folder but not a Git repository, so Dispatch skipped branch preparation. Do not run git branch/commit commands. Make any requested file changes directly in the workspace, verify them, update the dossier Work Log, and call out in your hand-off that no commit was created because the workspace is not a Git repo. If version control is required before continuing, use "flag_human" and ask for git init or a repo workspace.');
  }

  lines.push('\n## Tooling notes');
  lines.push('- Puppeteer is available for browser automation (`npm install puppeteer` in a scratch dir) if you need to scrape, test UI, or drive a headless browser.');
  lines.push(`- SCRATCH SPACE: the ticket data dir (${dossierPath.replace(/\/DOSSIER\.md$/, '')}) is for the dossier and Dispatch's own files only. Do NOT create git worktrees, clones, node_modules, or build output there — use a temp dir (\`mktemp -d\`) or work inside your workspace. Scratch left in the data dir gets pruned.`);
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
  if (ticket.readOnly) {
    lines.push(' "human_test": "<step-by-step human test instructions, or NONE: <reason> — REQUIRED when advancing to Done>",');
    lines.push(' "work_log": "<optional fallback: Work Log entry body if direct dossier append was denied>",');
    lines.push(' "plan": "<optional fallback: full Plan section body if direct plan write was denied>"}');
  } else {
    lines.push(' "human_test": "<step-by-step human test instructions, or NONE: <reason> — REQUIRED when advancing to Done>"}');
  }
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
