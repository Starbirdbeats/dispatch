/* DISPATCH frontend — vanilla JS, no build step. */
'use strict';

const S = {
  data: null,          // /api/state payload
  modal: null,         // {type:'ticket'|'column'|'new'|'settings', id?, tab?}
  live: {},            // ticketId -> normalized run events (session-local)
  liveContext: {},     // ticketId -> latest live context snapshot
  transcript: null,    // current transcript tab view state
  commentDraft: '',
};

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- appearance prefs (device-local, not server state) ---------- */
const PREFS_KEY = 'dispatch.appearance';
const DEFAULT_PREFS = { theme: 'dark', fontPx: 20, uiScale: 1, transcriptShowTools: true };
function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
  catch { return { ...DEFAULT_PREFS }; }
}
function applyPrefs(p) {
  document.body.dataset.theme = p.theme;
  document.documentElement.style.setProperty('--base-font', `${p.fontPx}px`);
  document.documentElement.style.zoom = String(p.uiScale);
}
function savePrefs(p) {
  S.prefs = p;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {}
  applyPrefs(p);
}

/* ---------- minimal, XSS-safe markdown → HTML (no deps) ----------
   Escapes everything first, then applies a fixed set of transforms, so agent/file
   content can never inject live markup. Covers headings, lists, tables, code,
   bold/italic, links, hr, blockquotes — the shapes dossiers actually use. */
function mdInline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `XCODEX${codes.length - 1}XCODEX`; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) =>
    `<a href="${/^(https?:\/\/|\/|#)/.test(u) ? u : '#'}" target="_blank" rel="noopener">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/XCODEX(\d+)XCODEX/g, (_, i) => `<code>${codes[+i]}</code>`);
  return s;
}
function renderMarkdown(src) {
  const blocks = [];
  src = String(src).replace(/\r\n/g, '\n').replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
    blocks.push(code.replace(/\n$/, ''));
    return `XFENCEX${blocks.length - 1}XFENCEX`;
  });
  const lines = esc(src).split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let para = [];
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushPara = () => { if (para.length) { out.push(`<p>${mdInline(para.join(' '))}</p>`); para = []; } };
  const flush = () => { flushPara(); closeList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ph = line.match(/^XFENCEX(\d+)XFENCEX\s*$/);
    if (ph) { flush(); out.push(`<pre><code>${esc(blocks[+ph[1]])}</code></pre>`); continue; }
    if (!line.trim()) { flush(); continue; }

    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) { flush(); const n = h[1].length; out.push(`<h${n}>${mdInline(h[2])}</h${n}>`); continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }

    // GFM table: header row followed by a |---|---| separator
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush();
      const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      out.push('<table><thead><tr>' + head.map((c) => `<th>${mdInline(c)}</th>`).join('') + '</tr></thead><tbody>');
      i++; // skip separator
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) {
        i++;
        out.push('<tr>' + cells(lines[i]).map((c) => `<td>${mdInline(c)}</td>`).join('') + '</tr>');
      }
      out.push('</tbody></table>');
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      flushPara();
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${mdInline((ul || ol)[1])}</li>`);
      continue;
    }
    const bq = line.match(/^\s*>\s?(.*)$/);
    if (bq) { flushPara(); closeList(); out.push(`<blockquote>${mdInline(bq[1])}</blockquote>`); continue; }

    para.push(line.trim());
  }
  flush();
  return out.join('\n');
}

// Human-test text arrives as a run-on paragraph ("1) do x 2) do y ...") with inline `code`.
// Break the numbered steps onto their own lines so they render as a clean ordered list, then
// reuse the markdown renderer (headings, inline code, etc.).
function formatHumanTest(text) {
  let s = String(text || '').trim();
  if (!s) return '';
  if (/^NONE\b/i.test(s)) return `<p class="ht-none">${mdInline(esc(s))}</p>`;
  // " 2) " / " 2. " step markers → newline + "2. " (only digit-then-delimiter, so URLs/prose are safe)
  s = s.replace(/\s+(\d{1,2})[).]\s+/g, '\n$1. ').replace(/^(\d{1,2})[).]\s+/, '$1. ');
  return renderMarkdown(s);
}

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

async function loadState() {
  S.data = await api('/api/state');
  // Server restarted (new code deployed): pick up fresh JS/CSS instead of running stale app code.
  if (S.serverBoot && S.serverBoot !== S.data.serverBoot) return location.reload();
  S.serverBoot = S.data.serverBoot;
  render();
}

/* ---------- websocket ---------- */
function connectWS() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'state-changed') loadState().catch(console.error);
    if (msg.type === 'usage-update') {
      S.data.usage = msg.usage;
      renderTopbar();
    }
    if (msg.type === 'context-update') {
      S.liveContext[msg.ticketId] = msg.context;
      if (S.modal?.type === 'ticket' && S.modal.id === msg.ticketId && $('#diag-banner')) {
        const t = S.data.tickets.find((x) => x.id === msg.ticketId);
        if (t) renderDiagBanner(t);
      }
    }
    if (msg.type === 'run-event') {
      (S.live[msg.ticketId] ||= []).push(msg.event);
      if (S.live[msg.ticketId].length > 800) S.live[msg.ticketId].shift();
      const view = S.transcript?.ticketId === msg.ticketId ? S.transcript : null;
      if (view) {
        view.liveEvents.push(msg.event);
        appendTranscriptLine(msg.event);
      }
    }
  };
  ws.onclose = () => setTimeout(connectWS, 2000);
}

/* ---------- helpers ---------- */
const cols = () => [...S.data.board.columns].sort((a, b) => a.order - b.order);
const ticketsIn = (colId) => S.data.tickets.filter((t) => t.columnId === colId && !t.archived)
  .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
const archivedTickets = () => S.data.tickets.filter((t) => t.archived)
  .sort((a, b) => ((a.archivedAt || '') < (b.archivedAt || '') ? 1 : -1)); // newest first
const harnessLabel = (h) => h.type === 'human' ? 'HUMAN' : `${h.type} · ${h.model || 'default'} · ${h.effort || 'default'}`;
const BY_LABEL = { claude: 'CLAUDE CODE', codex: 'CODEX', human: 'YOU', engine: 'ENGINE' };
// ↻ button placed beside model dropdowns — fetches the latest model releases into the registry
const refreshBtn = () => '<button type="button" class="refresh-models" title="Fetch latest model releases from the provider"><span>↻</span></button>';
async function refreshModelRegistry() {
  toast('FETCHING LATEST MODELS…');
  document.querySelectorAll('.refresh-models').forEach((b) => b.classList.add('spin'));
  try {
    const r = await api('/api/models/refresh', 'POST', {});
    S.data.registry = r.registry;
    const parts = ['claude', 'codex'].map((ty) => {
      const p = r.report?.[ty];
      return p?.ok ? `${ty}: ${p.count} via ${p.source}` : `${ty}: unreachable (kept ${p?.kept || 'cache'})`;
    });
    toast(`MODELS — ${parts.join(' · ')}`, !r.report?.claude?.ok && !r.report?.codex?.ok);
    renderModal(); // re-render the open modal so the new options appear
  } catch (e) { alertErr(e); }
  finally { document.querySelectorAll('.refresh-models').forEach((b) => b.classList.remove('spin')); }
}
const effective = (t, c) => ({ ...c.harness, ...(t.overrides?.[c.id] || {}) });

/* Diagnose a ticket into a plain-language state the UI can act on.
   tone drives colour: live/ok = calm, warn = amber (self-recovering), stuck = red (needs you). */
function diagnose(t, c) {
  const running = S.data.runs.running.includes(t.id);
  const queued = S.data.runs.queued.includes(t.id);
  const sr = t.stuckReason;
  if (running) {
    const started = t.currentRun?.startedAt ? Date.parse(t.currentRun.startedAt) : null;
    return { kind: 'running', tone: 'live', label: 'RUNNING', stuck: false,
      headline: `${t.currentRun?.harness || 'agent'} is working in ${c.name}`,
      detail: started ? `Live for ${fmtDur(Date.now() - started)}. Watch the Transcript tab.` : 'Live. Watch the Transcript tab.',
      startedAt: started };
  }
  if (queued) return { kind: 'queued', tone: 'ok', label: 'QUEUED', stuck: false, headline: 'Waiting for a run slot', detail: 'Another run is using the concurrency slot; this starts next.' };
  if (t.pendingWake) return { kind: 'pending-wake', tone: 'ok', label: 'PICKUP SCHEDULED', stuck: false, headline: 'An agent will pick up your comment shortly', detail: 'Counting down in the comment box below.', wakeAt: t.pendingWake.at };
  if (t.retryAt) return { kind: 'rate-limit', tone: 'warn', label: 'AUTO-RETRY', stuck: false, headline: 'Rate-limited — will retry automatically', detail: sr?.detail || `Retry scheduled for ${new Date(t.retryAt).toLocaleString()}.`, retryAt: t.retryAt };

  if (t.status === 'awaiting-human') return { kind: sr?.kind || 'awaiting-human', tone: 'stuck', label: 'NEEDS YOU', stuck: true,
    headline: STUCK_HEADLINES[sr?.kind] || 'Parked — needs a human decision',
    detail: sr?.detail || 'The engine stopped here and is waiting for you.' };
  if (t.status === 'error') return { kind: sr?.kind || 'error', tone: 'stuck', label: 'ERROR', stuck: true,
    headline: STUCK_HEADLINES[sr?.kind] || 'The last run failed',
    detail: sr?.detail || 'The run ended with an error.' };

  if (c.role === 'agent' && t.status === 'idle') {
    if (sr?.kind === 'hold') return { kind: 'hold', tone: 'warn', label: 'HELD', stuck: false,
      headline: 'Agent held — did work but not done', detail: `${sr.detail} It will retry automatically.` };
    const stallMin = S.data.board?.settings?.stallAfterMin ?? 10;
    return { kind: 'idle-agent', tone: 'warn', label: 'IDLE', stuck: false,
      headline: `Idle in ${c.name}`,
      detail: stallMin > 0 ? `No live run. The watchdog will resume it within ${stallMin} min, or you can run it now.` : 'No live run and the watchdog is off — run it manually.' };
  }
  if (c.role === 'intake') return { kind: 'backlog', tone: 'ok', label: 'BACKLOG', stuck: false, headline: 'Waiting in intake', detail: 'Auto-dispatch will start the pipeline, or hit START PIPELINE.' };
  return { kind: 'done', tone: 'ok', label: 'DONE', stuck: false, headline: 'Complete', detail: t.humanTest ? 'See the human-test steps in Overview.' : '' };
}
const STUCK_HEADLINES = {
  'hold-limit': 'Stuck: the phase keeps finishing without advancing',
  'no-control-block': 'Stuck: the agent didn’t say what to do next',
  'bounce-limit': 'Stuck: the phases keep bouncing it back and forth',
  'no-next-column': 'Stuck: nowhere to advance to',
  'flag-human': 'The agent asked for your input',
  'timeout': 'The run timed out',
  'run-failed': 'The run crashed',
  'provider-disabled': 'Setup has this provider disabled',
};
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
// human-readable local timestamp for completion display
function fmtTs(iso) { try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso || ''; } }
const activeElapsed = (t) => (t.activeMs || 0) + (t.activeSince ? Date.now() - t.activeSince : 0);
const activeClockSpan = (t) => `<span data-active-base="${t.activeMs || 0}" data-active-since="${t.activeSince || ''}">${esc(fmtDur(activeElapsed(t)))}</span>`;
const isClockPaused = (t) => Boolean(t.startedAt) && !t.completedAt && !t.activeSince;

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(n)));
}

function pctText(n) {
  if (!Number.isFinite(Number(n))) return '—';
  const v = Math.round(Number(n) * 10) / 10;
  return Number.isInteger(v) ? `${v}%` : `${v.toFixed(1)}%`;
}

function meterTone(remainingPct) {
  if (!Number.isFinite(Number(remainingPct))) return 'muted';
  if (remainingPct < 10) return 'stuck';
  if (remainingPct < 25) return 'warn';
  return 'live';
}

function meterHTML(fillPct, remainingPct) {
  const fill = Number.isFinite(Number(fillPct)) ? clamp(fillPct) : 0;
  return `<span class="meter tone-${meterTone(remainingPct)}" style="--pct:${fill}%"><span></span></span>`;
}

function fmtTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}m`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(v));
}

function contextStats(ctx) {
  if (!ctx) return null;
  const pct = Number.isFinite(Number(ctx.pct))
    ? clamp(ctx.pct)
    : (ctx.windowTokens ? clamp((Number(ctx.contextTokens) / Number(ctx.windowTokens)) * 100) : null);
  if (pct == null || !Number.isFinite(pct)) return null;
  return { usedPct: pct, remainingPct: clamp(100 - pct) };
}

function contextLineHTML(type, ctx, { live = false } = {}) {
  const stats = contextStats(ctx);
  if (!stats) return '';
  const title = [ctx.model, ctx.at ? `updated ${fmtTs(ctx.at)}` : ''].filter(Boolean).join(' · ');
  return `<div class="context-line" title="${esc(title)}">
    <span class="context-name">${esc(type)}</span>
    ${meterHTML(stats.usedPct, stats.remainingPct)}
    <span class="context-num">${fmtTokens(ctx.contextTokens)} / ${fmtTokens(ctx.windowTokens)} · ${live ? `${pctText(stats.usedPct)} full · ` : ''}${pctText(stats.remainingPct)} left</span>
  </div>`;
}

function contextOverviewHTML(t) {
  const lines = ['claude', 'codex']
    .map((type) => t.context?.[type] ? contextLineHTML(type, t.context[type]) : '')
    .filter(Boolean);
  return lines.length ? `<div class="context-list">${lines.join('')}</div>` : '<span class="muted">no runs yet</span>';
}

function liveContextHTML(t) {
  const runningType = t.currentRun?.harness;
  if (!runningType) return '';
  const ctx = S.liveContext[t.id] || t.context?.[runningType];
  if (!ctx) return '';
  return `<div class="diag-context">${contextLineHTML(runningType, ctx, { live: true })}</div>`;
}

function usageWindowHTML(label, win, provider) {
  if (!win || !Number.isFinite(Number(win.usedPct))) {
    return `<span class="usage-window missing"><span class="usage-key">${label}</span><b>—</b></span>`;
  }
  const remaining = clamp(100 - Number(win.usedPct));
  const title = [
    `${provider} ${label}: ${pctText(remaining)} remaining`,
    `${pctText(win.usedPct)} used`,
    win.resetsAt ? `resets ${fmtTs(win.resetsAt)}` : '',
  ].filter(Boolean).join(' · ');
  return `<span class="usage-window tone-${meterTone(remaining)}" title="${esc(title)}">
    <span class="usage-key">${label}</span>${meterHTML(remaining, remaining)}<b>${pctText(remaining)}</b>
  </span>`;
}

function usageProviderHTML(provider) {
  const u = S.data.usage?.[provider] || {};
  const title = [u.source, u.at ? `updated ${fmtTs(u.at)}` : '', u.error ? `error: ${u.error}` : ''].filter(Boolean).join(' · ');
  return `<div class="usage-provider" title="${esc(title)}">
    <span class="usage-name">${provider}</span>
    ${usageWindowHTML('5H', u.fiveHour, provider)}
    ${usageWindowHTML('7D', u.weekly, provider)}
  </div>`;
}

const PROVIDER_ORDER = ['claude', 'codex'];

function providerStatusLabel(type) {
  if (type === 'claude') return 'Claude Code';
  if (type === 'codex') return 'Codex';
  return type;
}

function setupPresetLabel(preset) {
  return {
    both: 'Both',
    'claude only': 'Claude only',
    claude: 'Claude only',
    'codex only': 'Codex only',
    codex: 'Codex only',
  }[preset] || 'Custom';
}

function setupInfo() {
  return S.data?.setup || { providers: {}, enabledTypes: PROVIDER_ORDER, completedAt: null, lastPreset: 'manual' };
}

function setupEnabledTypes() {
  const list = Array.isArray(setupInfo().enabledTypes) ? setupInfo().enabledTypes : [];
  const out = list.filter((type) => PROVIDER_ORDER.includes(type));
  return out.length ? out : PROVIDER_ORDER.slice();
}

function isProviderEnabled(type) {
  if (type === 'human' || type === '') return true;
  return setupInfo().providers?.[type]?.enabled !== false;
}

function setupNotice() {
  const s = setupInfo();
  const enabled = PROVIDER_ORDER.filter((type) => setupInfo().providers?.[type]?.enabled !== false);
  const hasEnabled = enabled.length > 0;
  const hasAuth = enabled.some((type) => Boolean(s.providers?.[type]?.authenticated));
  const hasInstall = enabled.some((type) => Boolean(s.providers?.[type]?.installed));
  const messages = [];
  if (!s.completedAt) messages.push('setup not completed');
  if (!hasEnabled) messages.push('no provider enabled');
  if (hasEnabled && !hasInstall) messages.push('no provider installed');
  if (hasEnabled && !hasAuth && hasInstall) messages.push('no authenticated provider');
  return messages;
}

function providerStatusText(type) {
  const state = setupInfo().providers?.[type] || {};
  if (state.authenticated) return `authenticated${state.authDetail ? ` · ${state.authDetail}` : ''}`;
  if (state.installed) return `installed${state.error ? ` · ${state.authDetail || state.error}` : ''} · not authenticated`;
  return state.error ? `offline (${state.error})` : 'not installed';
}

function setupStatusClass(type) {
  const state = setupInfo().providers?.[type] || {};
  if (state.authenticated) return 'ok';
  if (state.installed) return 'warn';
  return 'bad';
}

function providerTypeOptions(selected, { includeHuman = false, includeCurrent = true, disabledOk = false, showWarnings = false } = {}) {
  const enabled = new Set(setupEnabledTypes());
  const options = [];
  const seen = new Set();

  const emit = (type) => {
    if (seen.has(type)) return;
    seen.add(type);
    const isHuman = type === 'human';
    const enabledType = isHuman || enabled.has(type);
    const isSelected = type === selected;
    if (!enabledType && !disabledOk && !isSelected) return;
    const disabled = !isHuman && !enabledType;
    const disabledLabel = disabled && showWarnings ? ' (disabled in setup)' : '';
    const label = isHuman ? 'HUMAN' : type.toUpperCase() + disabledLabel;
    const optionSelected = type === selected ? ' selected' : '';
    const optionDisabled = disabled && !disabledOk ? ' disabled' : '';
    options.push(`<option value="${type}"${optionSelected}${optionDisabled}>${label}</option>`);
  };

  if (includeHuman) emit('human');
  for (const type of PROVIDER_ORDER) emit(type);

  // Always keep selected type visible, even if it is disabled.
  if (selected && !seen.has(selected) && !includeCurrent) {
    const label = selected === 'human' ? 'HUMAN' : `${selected.toUpperCase()} (disabled in setup)`;
    options.unshift(`<option value="${selected}" selected>${label}</option>`);
  }

  return options.join('');
}

function setupCardInfo(type) {
  const state = setupInfo().providers?.[type] || {};
  const installed = state.installed ? 'installed' : 'not installed';
  return {
    enabled: state.enabled !== false,
    installed,
    status: setupStatusClass(type),
    text: providerStatusText(type),
    authDetail: state.authDetail || '',
    version: state.version || '',
    error: state.error || '',
  };
}

function providerCommands(type) {
  if (type === 'claude') {
    return [
      'claude --version',
      'claude login',
    ];
  }
  return [
    'codex --version',
    'codex login',
  ];
}

function setupCardsHTML() {
  return PROVIDER_ORDER.map((type) => {
    const state = setupInfo().providers?.[type] || {};
    const info = setupCardInfo(type);
    const status = setupStatusClass(type);
    const stateClass = info.enabled ? 'ok' : 'warn';
    return `<div class="setup-card">
      <div class="setup-card-head">
        <div class="setup-card-title">${providerStatusLabel(type)} ${info.enabled ? 'ENABLED' : 'DISABLED'}</div>
        <div class="setup-card-status ${stateClass}">${esc(info.installed ? 'installed' : 'offline')}</div>
      </div>
      <div class="setup-prompt">${esc(providerStatusText(type))}</div>
      <label class="check-row inline"><input id="s-${type}-enabled" type="checkbox" ${info.enabled ? 'checked' : ''}><span>use provider in automation</span></label>
      <label class="check-row inline"><input id="s-${type}-authed" type="checkbox" ${state.authenticated ? 'checked' : ''} disabled><span>authenticated</span></label>
      <div class="setup-auth-note">
        ${esc(state.version || 'not detected')}${info.text ? ` · ${esc(info.text)}` : ''}
      </div>
      <div class="cmd">${providerCommands(type).map((cmd) => `<span>${esc(cmd)}</span>`).join('<br>')}</div>
      <div class="setup-actions">
        <button class="btn" data-probe="${type}">[ RE-CHECK ]</button>
        <button class="btn" data-copy="${type}">[ COPY PRIMARY CMD ]</button>
      </div>
    </div>`;
  }).join('');
}

function usageStripHTML() {
  return `${usageProviderHTML('claude')}${usageProviderHTML('codex')}`;
}

// kv rows for the lifecycle clock: live ACTIVE elapsed, or frozen COMPLETED + TOOK.
function timingRowHTML(t) {
  if (t.completedAt) {
    return `<div class="k">COMPLETED</div><div>${esc(fmtTs(t.completedAt))}</div>` +
      (t.durationMs != null ? `<div class="k">TOOK</div><div>${esc(fmtDur(t.durationMs))}</div>` : '');
  }
  if (t.startedAt) {
    return `<div class="k">ACTIVE FOR</div><div>${activeClockSpan(t)} <span class="since">${isClockPaused(t) ? 'paused · ' : ''}since ${esc(fmtTs(t.startedAt))}</span></div>`;
  }
  return '';
}

/* ---------- attachments ---------- */
const MAX_ATTACH_MB = 16;
const fmtBytes = (n) => !Number.isFinite(n) ? ''
  : n < 1024 ? `${n} B`
  : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB`
  : `${(n / 1024 / 1024).toFixed(1)} MB`;
// Read a File into raw base64 (strip the "data:...;base64," prefix the API doesn't want).
const fileToB64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(new Error('read failed'));
  r.readAsDataURL(file);
});
// Turn a FileList into upload records, skipping anything over the cap (with a toast).
async function readUploads(fileList) {
  const out = [];
  for (const file of [...fileList]) {
    if (file.size > MAX_ATTACH_MB * 1024 * 1024) { toast(`${file.name} > ${MAX_ATTACH_MB}MB — skipped`, true); continue; }
    try { out.push({ name: file.name, type: file.type, size: file.size, dataB64: await fileToB64(file) }); }
    catch { toast(`failed to read ${file.name}`, true); }
  }
  return out;
}
// Wire a drop-zone + hidden input + browse button to a handler. Ids are caller-supplied.
function wireDropzone(dropId, inputId, browseId, onFiles) {
  const drop = $(`#${dropId}`), input = $(`#${inputId}`);
  if (!drop || !input) return;
  $(`#${browseId}`).onclick = () => input.click();
  input.onchange = () => { onFiles(input.files); input.value = ''; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); onFiles(e.dataTransfer.files); };
}
const dropzoneHTML = (dropId, inputId, browseId) =>
  `<div class="att-drop" id="${dropId}"><span>DROP FILES OR</span><button type="button" class="btn" id="${browseId}">[ BROWSE ]</button><input type="file" id="${inputId}" multiple hidden></div>`;

/* ---------- render ---------- */
function render() {
  renderTopbar();
  renderBoard();
  if (S.modal?.type === 'ticket') {
    // Live-refresh only the non-form tabs; overview holds user edits.
    const lt = S.data.tickets.find((x) => x.id === S.modal.id);
    if (S.modal.tab === 'activity') renderModal();
    else if (S.modal.tab === 'dossier' && lt) renderDossier(lt, { live: true });
    else updateTicketModalHead();
    // the diagnosis banner is informational — safe to refresh on every state change
    if (lt && $('#diag-banner')) renderDiagBanner(lt);
  }
}

function renderTopbar() {
  const h = S.data.health;
  $('#health').innerHTML =
    `<span class="${h.claude?.ok ? 'ok' : 'bad'}">CLAUDE ${h.claude?.ok ? (h.claude.version || 'OK') : 'OFFLINE'}</span>` +
    ` &nbsp;///&nbsp; <span class="${h.codex?.ok ? 'ok' : 'bad'}">CODEX ${h.codex?.ok ? (h.codex.version || 'OK') : 'OFFLINE'}</span>`;
  $('#usage').innerHTML = usageStripHTML();
  const r = S.data.runs;
  const cap = S.data.board.settings.maxConcurrent ?? 2;
  const paused = cap <= 0;
  $('#queueinfo').innerHTML = paused
    ? `<span class="paused-flag">⏸ PAUSED</span> / RUNNING <b>${r.running.length}</b> / QUEUED <b>${r.queued.length}</b>`
    : `RUNNING <b>${r.running.length}</b> / QUEUED <b>${r.queued.length}</b> / CAP <b>${cap}</b>`;
  const pauseBtn = $('#btn-pause');
  if (pauseBtn) {
    pauseBtn.textContent = paused ? '[ ▶ RESUME ]' : '[ ⏸ PAUSE ]';
    pauseBtn.classList.toggle('btn-accent', paused);
  }
  const archived = S.data.tickets.filter((t) => t.archived).length;
  $('#btn-archive').textContent = archived ? `[ ARCHIVE ${String(archived).padStart(2, '0')} ]` : '[ ARCHIVE ]';

  const notice = $('#setup-notice');
  if (notice) {
    const reasons = setupNotice();
    notice.innerHTML = reasons.length
      ? `<span class="warn">SETUP REQUIRED — ${reasons.join(' • ')}. <button class="btn btn-accent" id="s-open-setup">[ OPEN SETUP ]</button></span>`
      : '<span class="muted">SETUP READY</span>';
  }
  const openNotice = $('#s-open-setup');
  if (openNotice) openNotice.onclick = () => { S.modal = { type: 'settings' }; renderModal(); };
}

function renderBoard() {
  const board = $('#board');
  const savedX = board.scrollLeft;
  const savedY = new Map([...board.querySelectorAll('.column')]
    .map((el) => [el.dataset.colId, $('.col-body', el)?.scrollTop || 0]));
  board.innerHTML = '';
  for (const c of cols()) {
    const activeType = c.harness?.type;
    const disabledType = activeType !== 'human' && !isProviderEnabled(activeType);
    const col = document.createElement('section');
    col.className = 'column';
    col.dataset.colId = c.id;
    const tickets = ticketsIn(c.id);
    col.innerHTML = `
      <div class="col-head">
        <div class="col-title"><h2>${esc(c.name)}</h2><span class="count">${String(tickets.length).padStart(2, '0')}</span></div>
        <div class="col-harness">
          <span>[ ${esc(harnessLabel(c.harness))} ]${c.autoRun ? ' <span class="auto">AUTO</span>' : ''}</span>
          ${disabledType ? '<span class="col-warn">PROVIDER DISABLED IN SETUP</span>' : ''}
          <button class="cfg" data-cfg="${c.id}">CFG &gt;&gt;</button>
        </div>
        ${c.role === 'intake' && S.data.scheduler?.autoDispatch
          ? `<div class="col-sweep">AUTO SWEEP <span data-sweep>T-—:——</span></div>` : ''}
      </div>
      <div class="col-body"></div>`;
    const body = $('.col-body', col);
    for (const t of tickets) body.appendChild(cardEl(t, c));
    // drag & drop
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('dragover'); });
    col.addEventListener('dragleave', () => col.classList.remove('dragover'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('dragover');
      const id = e.dataTransfer.getData('text/ticket');
      if (id) await api(`/api/tickets/${id}/move`, 'POST', { columnId: c.id }).catch(alertErr);
    });
    $('.cfg', col).onclick = () => { S.modal = { type: 'column', id: c.id }; renderModal(); };
    board.appendChild(col);
  }
  board.scrollLeft = savedX;
  for (const colEl of board.querySelectorAll('.column')) {
    const y = savedY.get(colEl.dataset.colId);
    if (y) $('.col-body', colEl).scrollTop = y;
  }
}

function cardEl(t, c) {
  const el = document.createElement('article');
  const running = S.data.runs.running.includes(t.id);
  const status = running ? 'running' : (S.data.runs.queued.includes(t.id) ? 'queued' : (c.role === 'terminal' ? 'done' : t.status));
  const eff = effective(t, c);
  const disabledHarness = eff.type !== 'human' && !isProviderEnabled(eff.type);
  el.className = `card status-${status}`;
  el.draggable = true;
  const last = [...t.activity].reverse().find((a) => a.kind !== 'run');
  const dx = diagnose(t, c);
  el.innerHTML = `
    <div class="t"><span class="led ${status}"></span><span class="title">${esc(t.title)}</span>${t.readOnly ? '<span class="ro-tag" title="Read-only ticket">RO</span>' : ''}${c.role === 'terminal' ? `<button class="arch" title="Archive ticket">[ ARCH ]</button>` : ''}</div>
    <div class="meta"><span>${esc(t.workspace.split('/').pop())}</span>
      <span class="meta-badges">${disabledHarness ? '<span class="badge tone-stuck">PROVIDER DISABLED</span>' : ''}<span class="badge tone-${dx.tone}">${dx.tone === 'stuck' ? '⚠ ' : ''}${esc(dx.label)}</span></span>
    </div>
    ${t.completedAt && t.durationMs != null
      ? `<div class="timing done">✓ took ${esc(fmtDur(t.durationMs))} · ${esc(fmtTs(t.completedAt))}</div>`
      : (t.startedAt ? `<div class="timing">${isClockPaused(t) ? '⏸ paused' : '⏱ active'} ${activeClockSpan(t)}</div>` : '')}
    ${t.scheduledAt ? `<div class="last">SCHED ${esc(t.scheduledAt.replace('T', ' '))}</div>` : ''}
    ${last ? `<div class="last">&gt; ${esc(last.text)}</div>` : ''}`;
  el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/ticket', t.id); el.classList.add('dragging'); });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  const archBtn = $('.arch', el);
  if (archBtn) archBtn.onclick = (e) => {
    e.stopPropagation(); // don't open the ticket modal
    api(`/api/tickets/${t.id}/archive`, 'POST', {}).then(() => toast('ARCHIVED')).catch(alertErr);
  };
  el.onclick = () => { S.modal = { type: 'ticket', id: t.id, tab: 'overview' }; renderModal(); };
  return el;
}

/* ---------- modals ---------- */
function closeModal() { S.modal = null; S.transcript = null; $('#modal-root').innerHTML = ''; }

let toastTimer = null;
function toast(text, isError = false) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.className = isError ? 'err show' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
function alertErr(e) { toast(`ERROR: ${e.message}`, true); }

function shell(title, bodyHTML, footHTML = '') {
  $('#modal-root').innerHTML = `
    <div class="overlay" id="overlay">
      <div class="panel">
        <div class="panel-head"><h3>${title}</h3><button class="x" id="modal-close">[ ESC ]</button></div>
        ${bodyHTML}
        ${footHTML ? `<div class="panel-foot">${footHTML}</div>` : ''}
      </div>
    </div>`;
  $('#modal-close').onclick = closeModal;
  $('#overlay').onclick = (e) => { if (e.target.id === 'overlay') closeModal(); };
}

function renderModal() {
  if (!S.modal) return;
  if (S.modal.type === 'ticket') renderTicketModal();
  if (S.modal.type === 'column') renderColumnModal();
  if (S.modal.type === 'new') renderNewModal();
  if (S.modal.type === 'settings') renderSettingsModal();
  if (S.modal.type === 'archive') renderArchiveModal();
}

function updateTicketModalHead() {
  const t = S.data.tickets.find((x) => x.id === S.modal?.id);
  const h = $('#ticket-status');
  if (t && h) h.textContent = t.status.toUpperCase();
}

function renderDossier(t, { live = false } = {}) {
  const host = $('#tab-body');
  if (!host) return;
  if (!live) host.innerHTML = '<div class="dossier" id="dossier-body">loading…</div>';
  fetch(`/api/tickets/${t.id}/dossier`).then((r) => r.text()).then((txt) => {
    const el = $('#dossier-body');
    if (!el) return;
    const y = el.scrollTop;
    el.innerHTML = renderMarkdown(txt);
    el.scrollTop = y;
  });
}

function transcriptShowTools() {
  return S.prefs?.transcriptShowTools !== false;
}

function transcriptVisible(ev) {
  return transcriptShowTools() || ev?.kind !== 'tool';
}

function transcriptEmptyText(view) {
  if (!view?.loaded) return 'LOADING TRANSCRIPT…';
  return transcriptShowTools()
    ? 'NO TRANSCRIPT ENTRIES YET'
    : 'NO MODEL TEXT IN THIS RUN WITH TOOLS HIDDEN';
}

function transcriptCurrentView(ticketId) {
  return S.transcript?.ticketId === ticketId ? S.transcript : null;
}

function setTranscriptView(view) {
  S.transcript = view;
  return view;
}

function transcriptRenderCurrent() {
  const view = S.transcript;
  const box = $('#transcript');
  if (!view || !box || view.ticketId !== S.modal?.id) return;
  const pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const prevTop = box.scrollTop;
  const events = [...(view.baseEvents || []), ...(view.liveEvents || [])].filter(transcriptVisible);
  box.innerHTML = '';
  if (events.length) {
    for (const ev of events) appendTranscriptLine(ev, { box, force: true, preserveScroll: false });
  } else {
    box.innerHTML = `<div class="transcript-empty">${esc(transcriptEmptyText(view))}</div>`;
  }
  if (pinned) box.scrollTop = box.scrollHeight;
  else box.scrollTop = Math.min(prevTop, Math.max(0, box.scrollHeight - box.clientHeight));
}

function transcriptRecord(raw) {
  let obj;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (obj.meta) return { kind: 'system', text: `spawn: ${obj.meta.cmd} (${obj.meta.column})` };
  if (obj.stderr) return { kind: 'error', text: obj.stderr.trim() };
  if (obj.ev) return obj.ev;
  return null;
}

/* ---- ticket modal ---- */
function renderTicketModal() {
  const t = S.data.tickets.find((x) => x.id === S.modal.id);
  if (!t) return closeModal();
  const tab = S.modal.tab || 'overview';
  const tabs = ['overview', 'activity', 'transcript', 'dossier'];
  const running = S.data.runs.running.includes(t.id);

  shell(
    `${esc(t.title)} <span id="ticket-status" style="color:var(--fg-faint);font-size:10px"> ${esc(t.status.toUpperCase())}</span>`,
    `<div class="tabs">${tabs.map((x) => `<button data-tab="${x}" class="${x === tab ? 'active' : ''}">${x}</button>`).join('')}</div>
     <div id="diag-banner"></div>
     <div class="panel-body" id="tab-body"></div>`,
    `<select id="move-to" style="width:auto">${cols().map((c) => `<option value="${c.id}" ${c.id === t.columnId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
     <button class="btn" id="btn-move">[ MOVE ]</button>
     <button class="btn" id="btn-run" ${running ? 'disabled' : ''}>[ ${effective(t, cols().find((c) => c.id === t.columnId) || {}).type === 'human' ? 'START PIPELINE' : 'RUN NOW'} ]</button>
     <button class="btn btn-danger" id="btn-stop" ${running || S.data.runs.queued.includes(t.id) ? '' : 'disabled'}>[ STOP ]</button>
     <button class="btn btn-danger" id="btn-del">[ DELETE ]</button>`
  );

  for (const b of document.querySelectorAll('[data-tab]')) {
    b.onclick = () => { S.modal.tab = b.dataset.tab; renderTicketModal(); };
  }
  $('#btn-move').onclick = () => api(`/api/tickets/${t.id}/move`, 'POST', { columnId: $('#move-to').value }).then(() => { toast('MOVED'); closeAndReload(); }).catch(alertErr);
  $('#btn-run').onclick = () => api(`/api/tickets/${t.id}/run`, 'POST', {}).then((r) => {
    if (r.queued) toast(r.startedPhase ? `PIPELINE STARTED → ${r.startedPhase}` : 'RUN QUEUED');
    else toast(`NOT QUEUED: ${r.reason || 'unknown'}`, true);
  }).catch(alertErr);
  $('#btn-stop').onclick = () => api(`/api/tickets/${t.id}/stop`, 'POST', {}).then(() => toast('STOP SIGNAL SENT')).catch(alertErr);
  $('#btn-del').onclick = () => { if (confirm('Delete ticket + dossier + transcripts?')) api(`/api/tickets/${t.id}`, 'DELETE').then(closeModal).catch(alertErr); };

  renderDiagBanner(t);

  const body = $('#tab-body');
  if (tab === 'overview') renderOverview(body, t);
  if (tab === 'activity') renderActivity(body, t);
  if (tab === 'transcript') renderTranscript(body, t);
  if (tab === 'dossier') renderDossier(t);
}

function closeAndReload() { closeModal(); loadState(); }

// Diagnosis banner at the top of the ticket modal: state + how it got there + unstick options.
function renderDiagBanner(t) {
  const el = $('#diag-banner');
  if (!el) return;
  const c = cols().find((x) => x.id === t.columnId) || {};
  const dx = diagnose(t, c);
  const prevAgent = [...cols()].reverse().find((x) => x.role === 'agent' && x.order < (c.order ?? 0));
  const nextCol = cols().find((x) => x.order > (c.order ?? -1));

  // action buttons only where they make sense
  const acts = [];
  if (dx.stuck || dx.kind === 'hold' || dx.kind === 'idle-agent') {
    acts.push(`<button class="btn" data-dx="run">[ ${dx.stuck ? 'RETRY THIS PHASE' : 'RUN NOW'} ]</button>`);
    if (nextCol) acts.push(`<button class="btn" data-dx="advance" data-col="${nextCol.id}">[ FORCE → ${esc(nextCol.name.toUpperCase())} ]</button>`);
    if (prevAgent) acts.push(`<button class="btn" data-dx="advance" data-col="${prevAgent.id}">[ ↩ ${esc(prevAgent.name.toUpperCase())} ]</button>`);
  }
  const liveClock = dx.kind === 'running' && dx.startedAt ? ` <span data-liveclock="${dx.startedAt}">${fmtDur(Date.now() - dx.startedAt)}</span>` : '';
  const countdown = dx.wakeAt ? ` <span data-wakeclock="${dx.wakeAt}"></span>` : (dx.retryAt ? ` <span data-retryclock="${dx.retryAt}"></span>` : '');

  el.className = `diag tone-${dx.tone}`;
  el.innerHTML = `
    <div class="diag-main">
      <span class="diag-label">${dx.tone === 'stuck' ? '⚠ ' : ''}${esc(dx.label)}${liveClock}${countdown}</span>
      <span class="diag-head">${esc(dx.headline)}</span>
    </div>
    ${dx.detail ? `<div class="diag-detail">${esc(dx.detail)}</div>` : ''}
    ${dx.kind === 'running' ? liveContextHTML(t) : ''}
    ${acts.length ? `<div class="diag-acts">${acts.join('')}${dx.stuck ? `<span class="diag-hint">or answer in the comment box below — that also wakes an agent</span>` : ''}</div>` : ''}`;

  for (const b of el.querySelectorAll('[data-dx]')) {
    b.onclick = () => {
      const kind = b.dataset.dx;
      if (kind === 'run') {
        api(`/api/tickets/${t.id}/run`, 'POST', {}).then((r) => toast(r.queued ? 'RUN QUEUED' : `NOT QUEUED: ${r.reason || '?'}`, !r.queued)).catch(alertErr);
      } else if (kind === 'advance') {
        api(`/api/tickets/${t.id}/move`, 'POST', { columnId: b.dataset.col }).then(() => { toast('MOVED'); }).catch(alertErr);
      }
    };
  }
}

// Build a <select> for model/effort/permissions scoped to a harness type, with the
// current value always present and a custom escape hatch for models.
// For kind='effort', pass modelId to filter to that model's supported levels (per the live
// registry); its provider default is marked. Empty efforts array = model takes no effort param.
function harnessOptions(kind, type, current, defaultLabel, modelId) {
  const reg = S.data.registry[type];
  let items = [];
  if (reg) {
    if (kind === 'model') items = reg.models.map((m) => ({ v: m.id, l: m.label + (m.stale ? ' (retired)' : '') }));
    if (kind === 'effort') {
      const m = modelId ? reg.models.find((x) => x.id === modelId) : null;
      const efforts = (m && Array.isArray(m.efforts) && m.efforts.length) ? m.efforts
        : (m && Array.isArray(m.efforts)) ? [] // explicitly none — model ignores effort
        : reg.efforts;
      items = efforts.map((e) => ({ v: e, l: e + (m?.defaultEffort === e ? ' · model default' : '') }));
    }
    if (kind === 'permissions') items = reg.permissions.map((p) => ({ v: p, l: p }));
  }
  if (current && !items.some((i) => i.v === current)) items.push({ v: current, l: `${current} (custom)` });
  const opts = [`<option value="">${esc(defaultLabel)}</option>`]
    .concat(items.map((i) => `<option value="${esc(i.v)}" ${i.v === current ? 'selected' : ''}>${esc(i.l)}</option>`));
  if (kind === 'model') opts.push(`<option value="__custom">custom…</option>`);
  return opts.join('');
}

function registryModels(type) {
  return S.data.registry[type]?.models || [];
}

function modelSupportsEffort(type, modelId, effort) {
  if (!effort) return true;
  const reg = S.data.registry[type];
  const m = modelId ? reg?.models?.find((x) => x.id === modelId) : null;
  const efforts = (m && Array.isArray(m.efforts) && m.efforts.length) ? m.efforts
    : (m && Array.isArray(m.efforts)) ? []
    : (reg?.efforts || []);
  return efforts.includes(effort);
}

function firstEffortFor(type, modelId) {
  const reg = S.data.registry[type];
  const m = modelId ? reg?.models?.find((x) => x.id === modelId) : null;
  const efforts = (m && Array.isArray(m.efforts) && m.efforts.length) ? m.efforts
    : (m && Array.isArray(m.efforts)) ? []
    : (reg?.efforts || []);
  if (m?.defaultEffort && efforts.includes(m.defaultEffort)) return m.defaultEffort;
  return efforts[0] || '';
}

function normalizeHarnessChoice(choice, fallback = {}) {
  const type = choice.type || fallback.type || 'claude';
  if (type === 'human') return { ...choice, type, model: '', effort: '', permissions: '' };

  const models = registryModels(type);
  const fallbackModel = models.some((m) => m.id === fallback.model) ? fallback.model : '';
  const chosenModel = models.some((m) => m.id === choice.model) ? choice.model : '';
  const model = chosenModel || fallbackModel || models[0]?.id || '';

  const fallbackEffort = modelSupportsEffort(type, model, fallback.effort) ? fallback.effort : '';
  const effort = modelSupportsEffort(type, model, choice.effort) ? (choice.effort || fallbackEffort) : (fallbackEffort || firstEffortFor(type, model));

  const perms = S.data.registry[type]?.permissions || [];
  const fallbackPerm = perms.includes(fallback.permissions) ? fallback.permissions : '';
  const permissions = perms.includes(choice.permissions) ? (choice.permissions || fallbackPerm) : (fallbackPerm || perms[0] || '');

  return { ...choice, type, model, effort, permissions };
}

function normalizeOverrideForColumn(o, c) {
  const type = o.type || c.harness.type;
  const normalized = normalizeHarnessChoice(
    { type, model: o.model || '', effort: o.effort || '', permissions: o.permissions || '' },
    c.harness,
  );
  return {
    type,
    model: o.model ? normalized.model : (normalized.model !== c.harness.model ? normalized.model : ''),
    effort: o.effort ? normalized.effort : (normalized.effort !== c.harness.effort ? normalized.effort : ''),
    permissions: o.permissions ? normalized.permissions : (normalized.permissions !== c.harness.permissions ? normalized.permissions : ''),
  };
}

function setOverrideDraft(draft, colId, next) {
  const cleaned = Object.fromEntries(Object.entries(next).filter(([, v]) => v));
  if (Object.keys(cleaned).length) draft[colId] = cleaned;
  else delete draft[colId];
}

function handleCustomModel(sel) {
  if (sel.value !== '__custom') return true;
  const v = prompt('Model id (free text — anything the CLI accepts):');
  if (v?.trim()) {
    const o = document.createElement('option');
    o.value = o.textContent = v.trim();
    sel.appendChild(o);
    sel.value = v.trim();
    return true;
  }
  sel.value = '';
  return false;
}

const workspacePicker = (id, value) => `
  <div class="workspace-picker" data-wp="${esc(id)}">
    <input id="${esc(id)}" value="${esc(value)}" autocomplete="off">
    <div class="workspace-nav">
      <button type="button" class="btn wp-up" title="Parent folder">[ UP ]</button>
      <button type="button" class="btn wp-home" title="Home folder">[ HOME ]</button>
      <button type="button" class="btn wp-refresh" title="Refresh folders">[ ↻ ]</button>
    </div>
    <select class="wp-dirs" aria-label="Folders under workspace path"><option value="">loading folders…</option></select>
  </div>`;

async function refreshWorkspacePicker(box, preferPath) {
  const input = $('input', box);
  const select = $('.wp-dirs', box);
  const path = preferPath || input.value.trim() || S.data.board.settings.defaultWorkspace || '/';
  select.innerHTML = '<option value="">loading folders…</option>';
  try {
    const r = await api(`/api/fs/dirs?path=${encodeURIComponent(path)}`);
    box.dataset.path = r.path;
    box.dataset.parent = r.parent;
    box.dataset.home = r.home;
    input.value = r.path;
    select.innerHTML = [
      `<option value="">${esc(r.dirs.length ? `choose folder inside ${r.path}` : `no folders inside ${r.path}`)}</option>`,
      ...r.dirs.map((d) => `<option value="${esc(d.path)}">${esc(d.name)}/</option>`),
    ].join('');
  } catch (e) {
    select.innerHTML = `<option value="">${esc(e.message || 'cannot read folder')}</option>`;
  }
}

function wireWorkspacePicker(id) {
  const input = $(`#${id}`);
  const box = input?.closest('.workspace-picker');
  if (!box) return;
  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => refreshWorkspacePicker(box), 250);
  };
  refreshWorkspacePicker(box);
  input.onchange = schedule;
  input.oninput = schedule;
  $('.wp-dirs', box).onchange = (e) => {
    if (!e.target.value) return;
    input.value = e.target.value;
    refreshWorkspacePicker(box, e.target.value);
  };
  $('.wp-up', box).onclick = () => refreshWorkspacePicker(box, box.dataset.parent || input.value);
  $('.wp-home', box).onclick = () => refreshWorkspacePicker(box, box.dataset.home || '~');
  $('.wp-refresh', box).onclick = () => refreshWorkspacePicker(box);
}

function renderOverview(body, t) {
  if (S.ovDraft?.id !== t.id) S.ovDraft = { id: t.id, ov: structuredClone(t.overrides || {}) };
  const draft = S.ovDraft.ov;
  const agentCols = cols().filter((c) => c.role === 'agent');
  body.innerHTML = `
    <div class="kv">
      <div class="k">ID</div><div>${t.id}</div>
      <div class="k">WORKSPACE</div><div>${workspacePicker('f-ws', t.workspace)}</div>
      <div class="k">SCHEDULED</div><div><input id="f-sched" type="datetime-local" value="${esc(t.scheduledAt || '')}"></div>
      <div class="k">MODE</div><div>
        <label class="check-row inline"><input type="checkbox" id="f-readonly" ${t.readOnly ? 'checked' : ''}> <span>read-only (agents can't modify the repo)</span></label>
        ${t.skip?.length ? `<div class="skip-note">skipping: ${t.skip.map((cid) => esc(cols().find((c) => c.id === cid)?.name || cid)).join(', ')}</div>` : ''}
      </div>
      ${timingRowHTML(t)}
      <div class="k">SESSIONS</div><div>claude: ${t.sessions.claude || '—'}<br>codex: ${t.sessions.codex || '—'}</div>
      <div class="k">CONTEXT</div><div>${contextOverviewHTML(t)}</div>
    </div>
    <label class="f">HOW TO HUMAN-TEST</label>
    ${t.humanTest ? `<div class="human-test">${formatHumanTest(t.humanTest)}</div>` : '<div class="human-test empty">not provided yet — the Review phase fills this before Done</div>'}
    <label class="f">DESCRIPTION</label>
    <textarea id="f-desc">${esc(t.description)}</textarea>
    <label class="f">ATTACHMENTS (referenced in the dossier for the agents — max ${MAX_ATTACH_MB}MB each)</label>
    ${dropzoneHTML('ov-att-drop', 'ov-att-input', 'ov-att-browse')}
    <div class="att-list" id="ov-att-list"></div>
    <label class="f">PER-COLUMN HARNESS OVERRIDES ("default" = column config)</label>
    <div class="overrides-wrap"><div class="overrides-grid">
      <div class="h">PHASE</div><div class="h">HARNESS</div><div class="h">MODEL</div><div class="h">EFFORT</div><div class="h">PERMS</div>
      ${agentCols.map((c) => {
        const o = draft[c.id] || {};
        const n = normalizeOverrideForColumn(o, c);
        if (n.model !== (o.model || '') || n.effort !== (o.effort || '') || n.permissions !== (o.permissions || '')) {
          setOverrideDraft(draft, c.id, { ...o, model: n.model, effort: n.effort, permissions: n.permissions });
        }
        const effType = n.type;
        const rowType = o.type || c.harness.type;
        const sameHarnessType = !o.type || o.type === c.harness.type;
        const defaultModelLabel = sameHarnessType ? `default (${c.harness.model || '—'})` : 'default';
        const defaultEffortLabel = sameHarnessType ? `default (${c.harness.effort || '—'})` : 'default';
        const defaultPermsLabel = sameHarnessType ? `default (${c.harness.permissions || '—'})` : 'default';
        const disabledWarning = effType !== 'human' && !isProviderEnabled(effType) && o.type
          ? '<div class="setup-pill warn">disabled in setup</div>'
          : '';
        return `<div>${esc(c.name)}</div>
          <div><select data-ov="${c.id}:type">${providerTypeOptions(o.type, { includeHuman: false, includeCurrent: true })}
            <option value="">default (${esc(c.harness.type)})</option>
          </select>${disabledWarning}</div>
          <div class="model-cell"><select data-ov="${c.id}:model">${harnessOptions('model', effType, n.model || '', defaultModelLabel)}</select>${refreshBtn()}</div>
          <div><select data-ov="${c.id}:effort">${harnessOptions('effort', effType, n.effort || '', defaultEffortLabel, n.model || (sameHarnessType ? c.harness.model : ''))}</select></div>
          <div><select data-ov="${c.id}:permissions">${harnessOptions('permissions', effType, n.permissions || '', defaultPermsLabel)}</select></div>`;
      }).join('')}
    </div></div>
    <div class="hint">claude efforts go up to max; codex up to xhigh. "custom…" under model takes any id the CLI accepts.</div>
    <div style="margin-top:14px"><button class="btn" id="btn-save-ticket">[ SAVE CHANGES ]</button></div>`;

  for (const sel of body.querySelectorAll('[data-ov]')) {
    sel.onchange = () => {
      if (sel.dataset.ov.endsWith(':model') && !handleCustomModel(sel)) return;
      const [colId, key] = sel.dataset.ov.split(':');
      const v = sel.value.trim();
      if (v) (draft[colId] ||= {})[key] = v;
      else if (draft[colId]) { delete draft[colId][key]; if (!Object.keys(draft[colId]).length) delete draft[colId]; }
      // type changes which models/efforts/perms apply; model changes which efforts apply
      if (key === 'type' || key === 'model') {
        const c = cols().find((x) => x.id === colId);
        if (c) {
          const o = draft[colId] || {};
          const n = normalizeOverrideForColumn(o, c);
          setOverrideDraft(draft, colId, { ...o, ...(o.type ? { type: o.type } : {}), model: n.model, effort: n.effort, permissions: n.permissions });
        }
        renderOverview(body, t);
      }
    };
  }
  wireWorkspacePicker('f-ws');

  $('#btn-save-ticket').onclick = async () => {
    await api(`/api/tickets/${t.id}`, 'PATCH', {
      workspace: $('#f-ws').value.trim(),
      description: $('#f-desc').value,
      scheduledAt: $('#f-sched').value || null,
      readOnly: $('#f-readonly').checked,
      overrides: draft,
    }).then(() => toast('TICKET SAVED')).catch(alertErr);
  };

  // Attachments upload/remove independently of SAVE CHANGES so draft edits above are never lost.
  wireDropzone('ov-att-drop', 'ov-att-input', 'ov-att-browse', (files) => uploadTicketFiles(t, files));
  renderTicketAttachments(t);
}

// Persisted attachments on an existing ticket: view (inline), download (?dl=1), remove.
function renderTicketAttachments(t) {
  const box = $('#ov-att-list');
  if (!box) return;
  const atts = (S.data.tickets.find((x) => x.id === t.id) || t).attachments || [];
  box.innerHTML = atts.length ? atts.map((a) => `
    <div class="att-item">
      <a class="att-name" href="/api/tickets/${t.id}/attachments/${a.id}" target="_blank" rel="noopener">${esc(a.name)}</a>
      <span class="att-size">${fmtBytes(a.size)}</span>
      <a class="att-dl" href="/api/tickets/${t.id}/attachments/${a.id}?dl=1" title="Download">[ &darr; ]</a>
      <button type="button" class="att-x" data-rm="${a.id}" title="Remove">[ x ]</button>
    </div>`).join('') : '<div class="att-empty">no files attached</div>';
  for (const b of box.querySelectorAll('[data-rm]')) {
    b.onclick = () => {
      if (!confirm('Remove this attachment?')) return;
      api(`/api/tickets/${t.id}/attachments/${b.dataset.rm}`, 'DELETE').then(() => {
        const cur = S.data.tickets.find((x) => x.id === t.id);
        if (cur) cur.attachments = (cur.attachments || []).filter((a) => a.id !== b.dataset.rm);
        renderTicketAttachments(t);
        toast('ATTACHMENT REMOVED');
      }).catch(alertErr);
    };
  }
}

async function uploadTicketFiles(t, fileList) {
  const files = await readUploads(fileList);
  if (!files.length) return;
  await api(`/api/tickets/${t.id}/attachments`, 'POST', { attachments: files }).then((r) => {
    const cur = S.data.tickets.find((x) => x.id === t.id);
    if (cur) cur.attachments = r.attachments;
    renderTicketAttachments(t);
    toast(`ATTACHED ${files.length} FILE${files.length > 1 ? 'S' : ''}`);
  }).catch(alertErr);
}

function renderActivity(body, t) {
  const c = cols().find((x) => x.id === t.columnId) || {};
  const running = S.data.runs.running.includes(t.id) || S.data.runs.queued.includes(t.id);
  const canWake = c.role === 'agent' && !running;
  // harness the pickup will use: current one-shot > column default; dropdowns let you steer it
  const base = { ...effective(t, c), ...(t.oneShotHarness || {}) };
  const hType = base.type === 'human' ? 'claude' : (base.type || 'claude');
  const wakeChoice = normalizeHarnessChoice({ type: hType, model: base.model || '', effort: base.effort || '' }, {});

  // chronological: oldest at top, newest at the bottom next to the input box
  body.innerHTML = `
    <div class="activity">${t.activity.map((a) => `
      <div class="item kind-${a.kind} by-${a.by}">
        <div class="who"><span class="author by-${a.by}">${esc(BY_LABEL[a.by] || a.by)} · ${esc(a.kind)}</span><span>${esc(a.ts.replace('T', ' ').slice(0, 19))}</span></div>
        <div class="txt">${esc(a.text)}</div>
      </div>`).join('') || '<div class="item"><div class="txt">no activity yet</div></div>'}
    </div>

    <div id="wake-panel"></div>

    <div class="commentbox">
      <textarea id="f-comment" placeholder="${canWake ? 'comment — an agent will pick this up in ~60s' : 'comment — the current run will see this on its next turn'}">${esc(S.commentDraft)}</textarea>
      <button class="btn" id="btn-comment">[ POST ]</button>
    </div>
    ${canWake ? `<div class="wake-harness">
      <span class="wake-lbl">picked up by</span>
      <select id="cw-type">${providerTypeOptions(hType, { includeHuman: false, disabledOk: false, showWarnings: true })}</select>
      <select id="cw-model">${harnessOptions('model', hType, wakeChoice.model || '', 'default')}</select>${refreshBtn()}
      <select id="cw-effort">${harnessOptions('effort', hType, wakeChoice.effort || '', 'default', wakeChoice.model)}</select>
    </div>` : ''}`;

  $('#f-comment').oninput = (e) => { S.commentDraft = e.target.value; };
  if (canWake) {
    const syncWakeHarness = () => {
      const h = normalizeHarnessChoice({ type: $('#cw-type').value, model: $('#cw-model').value, effort: $('#cw-effort').value }, {});
      $('#cw-model').innerHTML = harnessOptions('model', h.type, h.model, 'default');
      $('#cw-effort').innerHTML = harnessOptions('effort', h.type, h.effort, 'default', h.model);
    };
    $('#cw-type').onchange = syncWakeHarness;
    $('#cw-model').onchange = () => {
      if (!handleCustomModel($('#cw-model'))) return;
      syncWakeHarness();
    };
  }
  $('#btn-comment').onclick = async () => {
    const text = $('#f-comment').value.trim();
    if (!text) return;
    const wakeHarness = canWake ? {
      type: $('#cw-type').value,
      model: $('#cw-model').value === '__custom' ? '' : $('#cw-model').value,
      effort: $('#cw-effort').value,
    } : null;
    S.commentDraft = '';
    await api(`/api/tickets/${t.id}/comment`, 'POST', { text, wakeHarness })
      .then((r) => toast(r.scheduled ? 'COMMENT POSTED — AGENT PICKUP SCHEDULED' : (r.running ? 'COMMENT POSTED — CURRENT RUN WILL SEE IT' : 'COMMENT POSTED')))
      .catch(alertErr);
  };

  renderWakePanel(t);

  // Auto-scroll to newest (bottom). Stay pinned to the bottom unless the user scrolled up
  // to read history — then leave them where they are until a new item arrives.
  const prev = S.actScroll || {};
  const sameTicket = prev.id === t.id;
  const grew = sameTicket && t.activity.length > (prev.count || 0);
  const pinned = !sameTicket ? true : (prev.pinned !== false) || grew;
  if (pinned) body.scrollTop = body.scrollHeight;
  body.onscroll = () => {
    if (!S.actScroll) return;
    S.actScroll.pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  };
  S.actScroll = { id: t.id, count: t.activity.length, pinned };
}

// The countdown + pick-now/cancel controls shown when a comment wake is pending.
function renderWakePanel(t) {
  const el = $('#wake-panel');
  if (!el) return;
  const live = S.data.tickets.find((x) => x.id === t.id) || t;
  if (!live.pendingWake) { el.innerHTML = ''; return; }
  const h = live.pendingWake.harness;
  el.innerHTML = `
    <div class="wake-count">
      <span class="wake-t" data-wakeclock="${live.pendingWake.at}">T-0:60</span>
      <span class="wake-who">→ ${esc(h ? `${h.type || 'default'} · ${h.model || 'default'} · ${h.effort || 'default'}` : 'column default')} picks up your comment</span>
      <button class="btn" id="wake-now">[ PICK UP NOW ]</button>
      <button class="btn btn-danger" id="wake-cancel">[ CANCEL ]</button>
    </div>`;
  $('#wake-now').onclick = () => api(`/api/tickets/${t.id}/wake-now`, 'POST', {}).then(() => toast('PICKING UP NOW')).catch(alertErr);
  $('#wake-cancel').onclick = () => api(`/api/tickets/${t.id}/cancel-wake`, 'POST', {}).then(() => toast('WAKE CANCELLED')).catch(alertErr);
}

function renderTranscript(body, t) {
  const showTools = transcriptShowTools();
  body.innerHTML = `
    <div class="transcript-shell">
      <div class="transcript-bar">
        <label class="check-row inline transcript-toggle"><input type="checkbox" id="tr-tools" ${showTools ? 'checked' : ''}><span>show tool events</span></label>
        <div class="hint" id="tr-hint">loading transcript…</div>
      </div>
      <div class="transcript" id="transcript"></div>
    </div>`;

  setTranscriptView({
    ticketId: t.id,
    file: '',
    loaded: false,
    baseEvents: [],
    liveEvents: [...(S.live[t.id] || [])],
  });

  $('#tr-tools').onchange = (e) => {
    savePrefs({ ...S.prefs, transcriptShowTools: e.target.checked });
    transcriptRenderCurrent();
  };
  transcriptRenderCurrent();

  fetch(`/api/tickets/${t.id}/transcript`).then((r) => r.json()).then(({ file, lines }) => {
    const current = transcriptCurrentView(t.id);
    if (!current) return;
    current.file = file || '';
    current.baseEvents = (lines || []).map(transcriptRecord).filter(Boolean);
    current.loaded = true;
    $('#tr-hint').textContent = file ? `FILE: ${file}` : 'NO RUNS YET';
    transcriptRenderCurrent();
  });
}

function appendTranscriptLine(ev, { box = $('#transcript'), preserveScroll = true, force = false } = {}) {
  if (!box || !ev?.text || (!force && !transcriptVisible(ev))) return false;
  const pinned = preserveScroll && box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const div = document.createElement('div');
  div.className = `ln k-${ev.kind || 'text'}`;
  div.innerHTML = `<span class="tag">${esc(ev.kind || 'text')}</span>${esc(ev.text)}`;
  box.appendChild(div);
  if (pinned) box.scrollTop = box.scrollHeight;
  return true;
}

/* ---- column config modal ---- */
function renderColumnModal(draftOverride) {
  const c = S.data.board.columns.find((x) => x.id === S.modal.id);
  if (!c) return closeModal();
  const rawH = draftOverride || c.harness;
  const type = rawH.type || 'human';
  const h = type === 'human' ? rawH : normalizeHarnessChoice(rawH, {});
  const phaseTypeWarning = h.type !== 'human' && !isProviderEnabled(h.type)
    ? '<div class="setup-pill warn" style="margin:6px 0">PROVIDER disabled in setup</div>'
    : '';
  shell(`PHASE CONFIG /// ${esc(c.name)}`, `
    <div class="panel-body">
      <label class="f">NAME</label><input id="c-name" value="${esc(draftOverride?._name ?? c.name)}">
      <label class="f">ROLE</label>
      <select id="c-role">${['intake', 'agent', 'human-gate', 'terminal'].map((r) => `<option ${r === (draftOverride?._role ?? c.role) ? 'selected' : ''}>${r}</option>`).join('')}</select>
      <label class="f">HARNESS</label>
      <select id="c-type">${providerTypeOptions(type, { includeHuman: true, disabledOk: false, showWarnings: true })}</select>${phaseTypeWarning}
      <label class="f">MODEL</label>
      <div class="model-cell"><select id="c-model" ${type === 'human' ? 'disabled' : ''}>${harnessOptions('model', type, h.model || '', '—')}</select>${refreshBtn()}</div>
      <label class="f">EFFORT</label>
      <select id="c-effort" ${type === 'human' ? 'disabled' : ''}>${harnessOptions('effort', type, h.effort || '', '— (CLI default)', h.model)}</select>
      <label class="f">PERMISSIONS</label>
      <select id="c-perms" ${type === 'human' ? 'disabled' : ''}>${harnessOptions('permissions', type, h.permissions || '', '— (harness default)')}</select>
      <label class="f">ALLOWED TOOLS (claude only, e.g. "Bash(git *) Read Glob")</label>
      <input id="c-tools" value="${esc(h.allowedTools || '')}">
      <label class="f">CHROME EXTENSION (claude only)</label>
      <select id="c-chrome"><option value="">off</option><option value="1" ${h.chrome ? 'selected' : ''}>on</option></select>
      <label class="f">SANDBOX NETWORK ACCESS (codex only — needed for npm, ssh to MSI)</label>
      <select id="c-net"><option value="">off</option><option value="1" ${h.network ? 'selected' : ''}>on</option></select>
      <label class="f">AUTO-RUN WHEN A TICKET ARRIVES</label>
      <select id="c-auto"><option value="">off</option><option value="1" ${(draftOverride?._autoRun ?? c.autoRun) ? 'selected' : ''}>on</option></select>
      <label class="f">PHASE PROMPT</label>
      <textarea id="c-prompt" style="min-height:110px">${esc(draftOverride?._prompt ?? c.phasePrompt)}</textarea>
      <label class="f">EXIT CRITERIA</label>
      <textarea id="c-exit">${esc(draftOverride?._exit ?? c.exitCriteria)}</textarea>
    </div>`,
    `<button class="btn btn-danger" id="c-del">[ DELETE PHASE ]</button>
     <button class="btn btn-accent" id="c-save">[ SAVE ]</button>`);

  const collectDraft = () => ({
    type: $('#c-type').value,
    model: $('#c-model').value === '__custom' ? '' : $('#c-model').value,
    effort: $('#c-effort').value,
    permissions: $('#c-perms').value,
    allowedTools: $('#c-tools').value.trim(),
    chrome: Boolean($('#c-chrome').value),
    network: Boolean($('#c-net').value),
    _name: $('#c-name').value,
    _role: $('#c-role').value,
    _autoRun: Boolean($('#c-auto').value),
    _prompt: $('#c-prompt').value,
    _exit: $('#c-exit').value,
  });
  // switching harness re-renders with the matching model/effort/permission lists
  $('#c-type').onchange = () => {
    const d = collectDraft();
    Object.assign(d, normalizeHarnessChoice({ type: d.type }, {}));
    renderColumnModal(d);
  };
  $('#c-model').onchange = () => { if (handleCustomModel($('#c-model'))) renderColumnModal(collectDraft()); }; // model change re-filters efforts

  $('#c-save').onclick = () => api(`/api/columns/${c.id}`, 'PATCH', {
    name: $('#c-name').value.trim(),
    role: $('#c-role').value,
    autoRun: Boolean($('#c-auto').value),
    phasePrompt: $('#c-prompt').value,
    exitCriteria: $('#c-exit').value,
    harness: {
      type: $('#c-type').value,
      model: $('#c-model').value.trim(),
      effort: $('#c-effort').value.trim(),
      permissions: $('#c-perms').value.trim(),
      network: Boolean($('#c-net').value),
      allowedTools: $('#c-tools').value.trim(),
      chrome: Boolean($('#c-chrome').value),
    },
  }).then(() => { toast('PHASE SAVED'); closeAndReload(); }).catch(alertErr);
  $('#c-del').onclick = () => { if (confirm('Delete this phase?')) api(`/api/columns/${c.id}`, 'DELETE').then(closeAndReload).catch(alertErr); };
}

/* ---- new ticket modal ---- */
function renderNewModal() {
  shell('NEW TICKET', `
    <div class="panel-body">
      <label class="f">TITLE</label><input id="n-title" autofocus>
      <label class="f">DESCRIPTION / BRIEF</label><textarea id="n-desc" style="min-height:120px"></textarea>
      <label class="f">WORKSPACE (absolute path — the repo agents will work in)</label>
      ${workspacePicker('n-ws', S.data.board.settings.defaultWorkspace)}
      <label class="f">START IN</label>
      <select id="n-col">${cols().map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
      <label class="f">SCHEDULE FOR (optional — leave blank for the next backlog sweep)</label>
      <input id="n-sched" type="datetime-local">
      <label class="check-row"><input type="checkbox" id="n-readonly"> <span>READ-ONLY — agents may only read the repo for context (no edits, no commits)</span></label>
      <div id="n-skip-wrap" class="skip-wrap" hidden>
        <div class="skip-lbl">skip these phases (nothing to build/verify on a read-only ticket):</div>
        ${cols().filter((c) => c.role === 'agent').map((c) => `<label class="check-row sub"><input type="checkbox" class="n-skip" value="${c.id}" ${/build/i.test(c.name) ? 'checked' : ''}> <span>${esc(c.name)}</span></label>`).join('')}
      </div>
      <label class="f">ATTACHMENTS (listed in the dossier for the agents to read — max ${MAX_ATTACH_MB}MB each)</label>
      ${dropzoneHTML('n-att-drop', 'n-att-input', 'n-att-browse')}
      <div class="att-list" id="n-att-list"></div>
      <div class="hint">unscheduled backlog tickets start immediately if a run slot is free, otherwise on the next sweep (every ${S.data.board.settings.autoDispatchEveryMin || 5} min). a scheduled ticket waits for its timestamp.</div>
    </div>`,
    `<button class="btn btn-accent" id="n-create">[ CREATE ]</button>`);
  wireDropzone('n-att-drop', 'n-att-input', 'n-att-browse', async (files) => {
    S.newAttachments = (S.newAttachments || []).concat(await readUploads(files));
    renderStagedAttachments();
  });
  wireWorkspacePicker('n-ws');
  $('#n-readonly').onchange = (e) => { $('#n-skip-wrap').hidden = !e.target.checked; };
  renderStagedAttachments();
  $('#n-create').onclick = () => {
    const readOnly = $('#n-readonly').checked;
    const skip = readOnly ? [...document.querySelectorAll('.n-skip:checked')].map((el) => el.value) : [];
    api('/api/tickets', 'POST', {
      title: $('#n-title').value,
      description: $('#n-desc').value,
      workspace: $('#n-ws').value.trim(),
      columnId: $('#n-col').value,
      scheduledAt: $('#n-sched').value || null,
      readOnly, skip,
      attachments: (S.newAttachments || []).map(({ name, type, size, dataB64 }) => ({ name, type, size, dataB64 })),
    }).then((r) => { S.newAttachments = []; toast(r.started ? `CREATED — STARTED → ${r.started.toUpperCase()}` : 'TICKET CREATED'); closeAndReload(); }).catch(alertErr);
  };
}

// Staged (not-yet-uploaded) files for the New Ticket modal — held in memory until CREATE.
function renderStagedAttachments() {
  const box = $('#n-att-list');
  if (!box) return;
  const atts = S.newAttachments || [];
  box.innerHTML = atts.map((a, i) => `
    <div class="att-item">
      <span class="att-name">${esc(a.name)}</span>
      <span class="att-size">${fmtBytes(a.size)}</span>
      <button type="button" class="att-x" data-rm="${i}" title="Remove">[ x ]</button>
    </div>`).join('');
  for (const b of box.querySelectorAll('[data-rm]')) {
    b.onclick = () => { S.newAttachments.splice(Number(b.dataset.rm), 1); renderStagedAttachments(); };
  }
}

/* ---- archive modal ---- */
function renderArchiveModal() {
  const items = archivedTickets();
  const rows = items.map((t) => `
    <div class="arch-item" data-open="${t.id}">
      <div class="arch-main">
        <div class="arch-title">${esc(t.title)}</div>
        <div class="arch-meta"><span>${esc(t.workspace.split('/').pop())}</span>${t.archivedAt ? `<span>ARCHIVED ${esc(t.archivedAt.replace('T', ' ').slice(0, 16))}</span>` : ''}</div>
      </div>
      <button class="btn arch-restore" data-restore="${t.id}">[ RESTORE ]</button>
    </div>`).join('');
  shell(
    `ARCHIVE <span style="color:var(--fg-faint);font-size:10px">${String(items.length).padStart(2, '0')} TICKETS</span>`,
    `<div class="panel-body">${items.length
      ? `<div class="arch-list">${rows}</div>`
      : '<div class="arch-empty">ARCHIVE EMPTY — archive a done ticket and it lands here</div>'}</div>`
  );
  for (const el of document.querySelectorAll('[data-open]')) {
    el.onclick = () => { S.modal = { type: 'ticket', id: el.dataset.open, tab: 'overview' }; renderModal(); };
  }
  for (const el of document.querySelectorAll('[data-restore]')) {
    el.onclick = (e) => {
      e.stopPropagation(); // don't open the ticket modal underneath
      api(`/api/tickets/${el.dataset.restore}/unarchive`, 'POST', {})
        .then(() => { toast('RESTORED'); loadState().then(() => { if (S.modal?.type === 'archive') renderArchiveModal(); }); })
        .catch(alertErr);
    };
  }
}

function secretSource(entry) {
  if (entry.inFile && entry.inRuntime) return '.env + runtime';
  if (entry.inFile) return '.env';
  return 'runtime';
}

function secretRows(entries = []) {
  if (!entries.length) return '<div class="secret-empty">NO ENVIRONMENT ENTRIES FOUND</div>';
  return `<div class="secrets-grid">
    <div class="h">KEY</div><div class="h">VALUE</div><div class="h">SOURCE</div><div class="h">ACTIONS</div>
    ${entries.map((entry) => `<div class="secret-key">${esc(entry.key)}</div>
      <div><input class="secret-value" type="password" value="${esc(entry.value)}" autocomplete="off" spellcheck="false"></div>
      <div><span class="secret-source">${esc(secretSource(entry))}</span></div>
      <div class="secret-actions" data-key="${esc(entry.key)}">
        <button type="button" class="btn" data-secret-reveal>[ SHOW ]</button>
        <button type="button" class="btn" data-secret-save>[ SAVE ]</button>
        <button type="button" class="btn btn-danger" data-secret-delete ${entry.inFile ? '' : 'disabled title="runtime-only; save first to manage it in .env"'}>[ DELETE ]</button>
      </div>`).join('')}
  </div>`;
}

function renderSecretsPanel(data) {
  const box = $('#s-secrets-panel');
  if (!box) return;
  box.innerHTML = `
    <div class="secret-new">
      <input id="s-secret-key" placeholder="NEW_SECRET_KEY" autocomplete="off" spellcheck="false">
      <input id="s-secret-value" type="password" placeholder="value" autocomplete="off" spellcheck="false">
      <button type="button" class="btn" id="s-secret-new-reveal">[ SHOW ]</button>
      <button type="button" class="btn btn-accent" id="s-secret-add">[ ADD ]</button>
    </div>
    <div class="hint">FILE: <code>${esc(data.path || '.env')}</code>. Runtime-only keys are visible but delete is disabled until saved into .env.</div>
    ${secretRows(data.entries || [])}`;
  wireSecretsPanel();
}

function wireSecretsPanel() {
  const toggle = (input, button) => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    button.textContent = showing ? '[ SHOW ]' : '[ HIDE ]';
  };
  const newValue = $('#s-secret-value');
  $('#s-secret-new-reveal').onclick = () => toggle(newValue, $('#s-secret-new-reveal'));
  $('#s-secret-add').onclick = async () => {
    const key = $('#s-secret-key').value.trim();
    const value = $('#s-secret-value').value;
    try {
      renderSecretsPanel(await api('/api/secrets', 'POST', { key, value }));
      toast('SECRET SAVED');
    } catch (e) { alertErr(e); }
  };
  for (const btn of document.querySelectorAll('[data-secret-reveal]')) {
    btn.onclick = () => toggle(btn.closest('.secret-actions').previousElementSibling.previousElementSibling.querySelector('.secret-value'), btn);
  }
  for (const btn of document.querySelectorAll('[data-secret-save]')) {
    btn.onclick = async () => {
      const actions = btn.closest('.secret-actions');
      const key = actions.dataset.key;
      const value = actions.previousElementSibling.previousElementSibling.querySelector('.secret-value').value;
      try {
        renderSecretsPanel(await api('/api/secrets', 'POST', { key, value }));
        toast('SECRET SAVED');
      } catch (e) { alertErr(e); }
    };
  }
  for (const btn of document.querySelectorAll('[data-secret-delete]')) {
    btn.onclick = async () => {
      const key = btn.closest('.secret-actions').dataset.key;
      if (!confirm(`Delete ${key} from .env? Runtime-provided values may remain visible.`)) return;
      try {
        renderSecretsPanel(await api(`/api/secrets/${encodeURIComponent(key)}`, 'DELETE'));
        toast('SECRET DELETED');
      } catch (e) { alertErr(e); }
    };
  }
}

async function loadSecretsSettings() {
  const box = $('#s-secrets-panel');
  if (!box) return;
  box.innerHTML = '<div class="secret-empty">LOADING ENVIRONMENT…</div>';
  try { renderSecretsPanel(await api('/api/secrets')); }
  catch (e) { box.innerHTML = `<div class="secret-empty bad">${esc(e.message)}</div>`; }
}

async function loadSystemPromptSettings() {
  const textarea = $('#s-system-prompt');
  const meta = $('#s-system-meta');
  if (!textarea || !meta) return;
  textarea.value = 'loading…';
  textarea.disabled = true;
  try {
    const data = await api('/api/system-prompt');
    textarea.value = data.content || '';
    textarea.disabled = false;
    meta.innerHTML = `FILE: <code>${esc(data.path)}</code>`;
  } catch (e) {
    textarea.value = '';
    meta.textContent = e.message;
  }
}

/* ---- settings modal ---- */
function renderSettingsModal() {
  const s = S.data.board.settings;
  const agentCols = cols().filter((c) => c.role === 'agent');
  const p = S.prefs;
  shell('SETTINGS', `
    <div class="panel-body">
      <div class="section-head">APPEARANCE <span>(this device only)</span></div>
      <label class="f">THEME</label>
      <div class="theme-row">
        ${['dark', 'light', 'sepia'].map((th) => `<button class="theme-swatch th-${th} ${p.theme === th ? 'sel' : ''}" data-theme-pick="${th}">${th}</button>`).join('')}
      </div>
      <label class="f">FONT SIZE <output id="s-font-val">${p.fontPx}px</output></label>
      <input id="s-font" type="range" min="12" max="32" step="1" value="${p.fontPx}">
      <label class="f">UI SIZE <output id="s-ui-val">${Math.round(p.uiScale * 100)}%</output></label>
      <input id="s-ui" type="range" min="0.7" max="1.6" step="0.05" value="${p.uiScale}">
      <button class="btn" id="s-appear-reset" style="margin-top:8px">[ RESET APPEARANCE ]</button>
      <hr class="sep">

      <div class="section-head">SETUP</div>
      <div class="setup-cards">${setupCardsHTML()}</div>
      <label class="f">PROVIDER PRESETS</label>
      <select id="s-preset">
        <option value="both" ${((s.setup?.lastPreset || 'both') === 'both' || (s.setup?.lastPreset || 'both') === 'manual') ? 'selected' : ''}>Both (planning: Claude, build: Codex)</option>
        <option value="claude" ${s.setup?.lastPreset === 'claude' || s.setup?.lastPreset === 'claude only' ? 'selected' : ''}>Claude only</option>
        <option value="codex" ${s.setup?.lastPreset === 'codex' || s.setup?.lastPreset === 'codex only' ? 'selected' : ''}>Codex only</option>
      </select>
      <button class="btn" id="s-preset-apply">[ APPLY PRESET ]</button>
      <button class="btn" id="s-setup-complete">[ MARK SETUP COMPLETE ]</button>
      <div class="hint">Apply a preset to update Planning/Build/Review harnesses without editing JSON. You can still fine-tune each phase in CFG.</div>
      <div class="hint">Choose provider toggles here before running the pipeline. Disabled providers are preserved on existing columns but won’t be auto-run.</div>

      <div class="section-head">ENGINE</div>
      <label class="f">MAX CONCURRENT RUNS <output>${(s.maxConcurrent ?? 2) <= 0 ? 'paused' : ''}</output></label><input id="s-cap" type="number" min="0" max="8" value="${s.maxConcurrent ?? 2}">
      <div class="hint" style="margin-top:4px">0 = pause the engine (nothing new runs; queued work waits until you raise it).</div>
      <label class="f">RUN TIMEOUT (MINUTES)</label><input id="s-to" type="number" min="1" value="${s.runTimeoutMin}">
      <label class="f">DEFAULT WORKSPACE</label>${workspacePicker('s-ws', s.defaultWorkspace)}
      <label class="f">STALL WATCHDOG (MINUTES — resume orphaned tickets after this dwell; 0 = off)</label>
      <input id="s-stall" type="number" min="0" value="${s.stallAfterMin ?? 10}">
      <label class="f">AUTO-DISPATCH BACKLOG</label>
      <select id="s-auto"><option value="">off</option><option value="1" ${s.autoDispatch !== false ? 'selected' : ''}>on</option></select>
      <label class="f">SWEEP INTERVAL (MINUTES)</label><input id="s-every" type="number" min="1" value="${s.autoDispatchEveryMin || 5}">

      <label class="f">PHASE DEFAULTS — MODEL &amp; EFFORT PER COLUMN</label>
      <div class="overrides-wrap"><div class="overrides-grid" style="grid-template-columns:110px 90px 1fr 1fr">
        <div class="h">PHASE</div><div class="h">HARNESS</div><div class="h">MODEL</div><div class="h">EFFORT</div>
        ${agentCols.map((c) => `
          <div>${esc(c.name)}</div>
          <div>${esc(c.harness.type)}</div>
          <div class="model-cell"><select data-pd="${c.id}:model">${harnessOptions('model', c.harness.type, c.harness.model || '', '—')}</select>${refreshBtn()}</div>
          <div><select data-pd="${c.id}:effort">${harnessOptions('effort', c.harness.type, c.harness.effort || '', '— (CLI default)', c.harness.model)}</select></div>`).join('')}
      </div></div>
      <div class="hint">changing a harness TYPE (claude ⇄ codex) still needs that column's own CFG panel — this list only sets model/effort defaults.</div>
      <div class="hint" id="s-models-meta">${['claude', 'codex'].map((ty) => {
        const m = S.data.registry[ty]?.meta || {};
        const age = m.fetchedAt ? fmtDur(Date.now() - Date.parse(m.fetchedAt)) + ' ago' : 'never';
        return `${ty}: ${esc(m.source || 'seed')} · ${age}`;
      }).join(' &nbsp;///&nbsp; ')} — models auto-refresh daily; ↻ forces it now.</div>

      <hr class="sep">
      <div class="section-head">DISK</div>
      <label class="f">RUN JOURNALS KEPT PER TICKET (older ones pruned)</label>
      <input id="s-keepruns" type="number" min="1" max="50" value="${s.keepRunsPerTicket ?? 5}">
      <div class="disk-row">
        <span>DATA DIR: <b id="s-usage">…</b></span>
        <button class="btn" id="s-prune">[ RECLAIM DISK SPACE ]</button>
      </div>
      <div class="hint">removes agent scratch (stray worktrees, node_modules, clones) from ticket dirs and trims old run journals. skips tickets that are actively running.</div>

      <hr class="sep">
      <div class="section-head">SECRETS <span>(repo .env + runtime)</span></div>
      <div id="s-secrets-panel" class="secrets-panel"></div>

      <hr class="sep">
      <div class="section-head">SYSTEM PROMPT <span>(root SYSTEM.md)</span></div>
      <div class="hint" id="s-system-meta">loading system prompt…</div>
      <textarea id="s-system-prompt" class="system-prompt" spellcheck="false"></textarea>
      <div class="disk-row"><span></span><button class="btn" id="s-system-save">[ SAVE SYSTEM.md ]</button></div>

      <hr class="sep">
      <div class="section-head">NOTIFICATIONS <span>(telegram)</span></div>
      <label class="f">TELEGRAM ALERTS</label>
      <select id="s-tg-on"><option value="">off</option><option value="1" ${s.telegram?.enabled ? 'selected' : ''}>on</option></select>
      <label class="f">CHAT ID</label>
      <input id="s-tg-chat" value="${esc(s.telegram?.chatId || '')}" placeholder="e.g. 123456789">
      <label class="f">PING ON</label>
      <label class="check-row inline"><input type="checkbox" id="s-tg-done" ${s.telegram?.events?.completed !== false ? 'checked' : ''}> <span>ticket completed</span></label>
      <label class="check-row inline"><input type="checkbox" id="s-tg-stuck" ${s.telegram?.events?.intervention !== false ? 'checked' : ''}> <span>needs my intervention</span></label>
      <div class="disk-row"><span></span><button class="btn" id="s-tg-test">[ SEND TEST ]</button></div>
      <div class="hint">bot token comes from the <code>TELEGRAM_BOT_TOKEN</code> env var (kept out of the data dir). set it in the service unit / dispatch.env. reuses your existing Claude-hook bot.</div>

      <div class="hint" style="margin-top:14px">claude auth depends on local Claude CLI credentials · codex auth depends on local chatgpt/codex login · <button class="btn" id="s-probe" style="padding:2px 6px">[ re-probe CLIs ]</button></div>
    </div>`,
    `<button class="btn btn-accent" id="s-save">[ SAVE ]</button>`);

  const fmtBytes = (n) => n == null ? '?' : n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} KB`;
  wireWorkspacePicker('s-ws');
  loadSecretsSettings();
  loadSystemPromptSettings();
  api('/api/maintenance/usage').then((u) => { const el = $('#s-usage'); if (el) el.textContent = fmtBytes(u.bytes); }).catch(() => {});
  $('#s-prune').onclick = () => {
    $('#s-prune').textContent = '[ RECLAIMING… ]';
    api('/api/maintenance/prune', 'POST', {}).then((r) => {
      toast(`RECLAIMED ${fmtBytes(r.freedBytes)} · ${r.itemsRemoved} item(s) removed`);
      const el = $('#s-usage'); if (el) el.textContent = fmtBytes(r.after);
      $('#s-prune').textContent = '[ RECLAIM DISK SPACE ]';
    }).catch((e) => { alertErr(e); $('#s-prune').textContent = '[ RECLAIM DISK SPACE ]'; });
  };
  $('#s-tg-test').onclick = () => {
    $('#s-tg-test').textContent = '[ SENDING... ]';
    api('/api/notify/test', 'POST', { chatId: $('#s-tg-chat').value.trim() })
    .then(() => toast('TEST SENT — check your phone'))
    .catch(alertErr)
    .finally(() => { $('#s-tg-test').textContent = '[ SEND TEST ]'; });
  };

  // Setup controls: provider enablement, preset assignment, re-check, copy login command, setup completion.
  for (const type of PROVIDER_ORDER) {
    const enabledEl = $(`#s-${type}-enabled`);
    const probeBtn = document.querySelector(`[data-probe="${type}"]`);
    const copyBtn = document.querySelector(`[data-copy="${type}"]`);
    const firstCmd = providerCommands(type)[1] || '';
    probeBtn?.addEventListener('click', async () => {
      probeBtn.textContent = '[ CHECKING… ]';
      try {
        await api('/api/probe', 'POST', {});
        loadState().then(renderSettingsModal);
        toast('CLI STATUS REFRESHED');
      } catch (e) { alertErr(e); }
      probeBtn.textContent = '[ RE-CHECK ]';
    });
    copyBtn?.addEventListener('click', async () => {
      try {
        await navigator.clipboard?.writeText(firstCmd || '');
        toast('copied to clipboard');
      } catch {
        prompt('copy this command', firstCmd || '');
      }
    });
  }
  $('#s-preset-apply').onclick = async () => {
    const preset = $('#s-preset').value;
    try {
      $('#s-preset-apply').textContent = '[ APPLYING… ]';
      await api('/api/setup/preset', 'POST', { preset });
      await loadState();
      renderSettingsModal();
      toast(`PRESET APPLIED: ${setupPresetLabel(preset.toLowerCase())}`);
    } catch (e) { alertErr(e); }
    finally { $('#s-preset-apply').textContent = '[ APPLY PRESET ]'; }
  };
  $('#s-setup-complete').onclick = async () => {
    try {
      $('#s-setup-complete').textContent = '[ SAVING… ]';
      await api('/api/setup/complete', 'POST', {});
      await loadState();
      renderSettingsModal();
      toast('SETUP MARKED COMPLETE');
    } catch (e) { alertErr(e); }
    finally { $('#s-setup-complete').textContent = '[ MARK SETUP COMPLETE ]'; }
  };

  for (const sel of document.querySelectorAll('[data-pd$=":model"]')) sel.onchange = () => {
    if (!handleCustomModel(sel)) return;
    // refill the sibling effort select with the chosen model's supported levels
    const colId = sel.dataset.pd.split(':')[0];
    const eff = document.querySelector(`[data-pd="${colId}:effort"]`);
    const col = cols().find((c) => c.id === colId);
    if (eff && col) eff.innerHTML = harnessOptions('effort', col.harness.type, eff.value, '— (CLI default)', sel.value);
  };

  // Appearance — device-local, applies live and persists immediately (no server round-trip).
  for (const btn of document.querySelectorAll('[data-theme-pick]')) {
    btn.onclick = () => {
      savePrefs({ ...S.prefs, theme: btn.dataset.themePick });
      for (const b of document.querySelectorAll('[data-theme-pick]')) b.classList.toggle('sel', b === btn);
    };
  }
  $('#s-font').oninput = (e) => { savePrefs({ ...S.prefs, fontPx: Number(e.target.value) }); $('#s-font-val').textContent = `${e.target.value}px`; };
  $('#s-ui').oninput = (e) => { savePrefs({ ...S.prefs, uiScale: Number(e.target.value) }); $('#s-ui-val').textContent = `${Math.round(e.target.value * 100)}%`; };
  $('#s-appear-reset').onclick = () => { savePrefs({ ...DEFAULT_PREFS }); renderSettingsModal(); };
  $('#s-system-save').onclick = async () => {
    const btn = $('#s-system-save');
    btn.textContent = '[ SAVING… ]';
    try {
      const data = await api('/api/system-prompt', 'PUT', { content: $('#s-system-prompt').value });
      $('#s-system-meta').innerHTML = `FILE: <code>${esc(data.path)}</code>`;
      toast('SYSTEM.md SAVED');
    } catch (e) { alertErr(e); }
    finally { btn.textContent = '[ SAVE SYSTEM.md ]'; }
  };

  $('#s-save').onclick = async () => {
    const btn = $('#s-save');
    const claudeEnabled = $('#s-claude-enabled');
    const codexEnabled = $('#s-codex-enabled');
    const phaseDefaults = {};
    btn.textContent = '[ SAVING… ]';
    for (const el of document.querySelectorAll('[data-pd]')) {
      const [colId, key] = el.dataset.pd.split(':');
      (phaseDefaults[colId] ||= {})[key] = el.value.trim();
    }
    try {
      await Promise.all(agentCols.map((c) => {
        const d = phaseDefaults[c.id];
        if (!d || (!d.model && !d.effort)) return null;
        const harness = { ...c.harness };
        if (d.model) harness.model = d.model;
        if (d.effort) harness.effort = d.effort;
        return api(`/api/columns/${c.id}`, 'PATCH', { harness });
      }).filter(Boolean));
      const preset = $('#s-preset')?.value;
      const setupPayload = {
        providers: {
          ...(claudeEnabled ? { claude: { enabled: Boolean(claudeEnabled.checked) } } : {}),
          ...(codexEnabled ? { codex: { enabled: Boolean(codexEnabled.checked) } } : {}),
        },
        preset,
        completedAt: true,
      };
      await api('/api/setup/providers', 'PATCH', setupPayload);
      await api('/api/settings', 'PATCH', {
        maxConcurrent: Number.isFinite(+$('#s-cap').value) ? Math.max(0, Math.min(8, +$('#s-cap').value)) : 2,
        runTimeoutMin: Number($('#s-to').value) || 30,
        defaultWorkspace: $('#s-ws').value.trim(),
        autoDispatch: Boolean($('#s-auto').value),
        autoDispatchEveryMin: Number($('#s-every').value) || 5,
        stallAfterMin: Number($('#s-stall').value),
        keepRunsPerTicket: Math.max(1, Number($('#s-keepruns').value) || 5),
        telegram: {
          enabled: Boolean($('#s-tg-on').value),
          chatId: $('#s-tg-chat').value.trim(),
          events: {
            completed: $('#s-tg-done').checked,
            intervention: $('#s-tg-stuck').checked,
          },
        },
      });
      toast('SETTINGS SAVED');
      closeAndReload();
    } catch (e) {
      alertErr(e);
    } finally {
      btn.textContent = '[ SAVE ]';
    }
  };
  $('#s-probe').onclick = () => api('/api/probe', 'POST', {}).catch(alertErr);
}

/* ---------- 1s clocks: sweep countdown, wake countdown, retry countdown, live-run elapsed ---------- */
function fmtCountdown(ms) {
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  return `T-${m}:${String(s).padStart(2, '0')}`;
}
setInterval(() => {
  const now = Date.now();
  const sweepAt = S.data?.scheduler?.nextSweepAt;
  for (const el of document.querySelectorAll('[data-sweep]')) {
    el.textContent = sweepAt ? (sweepAt - now <= 0 ? 'DUE — next tick' : fmtCountdown(sweepAt - now)) : 'T-—:——';
  }
  for (const el of document.querySelectorAll('[data-wakeclock]')) {
    const ms = Number(el.dataset.wakeclock) - now;
    el.textContent = ms <= 0 ? 'starting…' : fmtCountdown(ms);
  }
  for (const el of document.querySelectorAll('[data-retryclock]')) {
    const ms = Number(el.dataset.retryclock) - now;
    el.textContent = ms <= 0 ? 'retrying…' : `retry in ${fmtCountdown(ms)}`;
  }
  for (const el of document.querySelectorAll('[data-liveclock]')) {
    el.textContent = fmtDur(now - Number(el.dataset.liveclock));
  }
  for (const el of document.querySelectorAll('[data-active-base]')) {
    const base = Number(el.dataset.activeBase) || 0;
    const since = Number(el.dataset.activeSince) || 0;
    el.textContent = fmtDur(base + (since ? now - since : 0));
  }
}, 1000);

/* ---------- boot ---------- */
$('#btn-new').onclick = () => { S.newAttachments = []; S.modal = { type: 'new' }; renderModal(); };
$('#btn-settings').onclick = () => { S.modal = { type: 'settings' }; renderModal(); };
$('#btn-archive').onclick = () => { S.modal = { type: 'archive' }; renderModal(); };
$('#btn-pause').onclick = () => {
  const cap = S.data.board.settings.maxConcurrent ?? 2;
  let next;
  if (cap > 0) { localStorage.setItem('dispatch.prevCap', String(cap)); next = 0; }   // pause
  else { next = Number(localStorage.getItem('dispatch.prevCap')) || 2; }               // resume
  api('/api/settings', 'PATCH', { maxConcurrent: next })
    .then(() => toast(next === 0 ? 'ENGINE PAUSED — nothing new will run' : `ENGINE RESUMED — cap ${next}`))
    .catch(alertErr);
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
document.addEventListener('click', (e) => { if (e.target.closest('.refresh-models')) { e.preventDefault(); refreshModelRegistry(); } });

savePrefs(loadPrefs()); // apply saved theme / font / UI scale before first paint
loadState().then(connectWS).catch((e) => { document.body.innerHTML = `<pre style="color:#ff2a2a;padding:20px">DISPATCH FAILED TO LOAD: ${esc(e.message)}</pre>`; });
