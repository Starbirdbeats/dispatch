/* DISPATCH frontend — vanilla JS, no build step. */
'use strict';

const S = {
  data: null,          // /api/state payload
  modal: null,         // {type:'ticket'|'column'|'new'|'settings'|'archive', id?, tab?} — mirrored in location.hash, see modalToHash/hashToModal
  live: {},            // ticketId -> normalized run events (session-local)
  liveContext: {},     // ticketId -> latest live context snapshot
  transcript: null,    // current transcript tab view state
  commentDraft: '',
  mobilePhase: 0,      // <760px board: which phase (column index) is on screen
  railExpanded: {},    // desktop rail: colId -> showing all chips past the +N cap
};

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- appearance prefs (device-local, not server state) ---------- */
const PREFS_KEY = 'dispatch.appearance';
const DEFAULT_PREFS = { fontPx: 20, uiScale: 1, transcriptShowTools: true };
function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
  catch { return { ...DEFAULT_PREFS }; }
}
function applyPrefs(p) {
  // Single paper palette — no theme switch. Font size + UI scale stay device-local.
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
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // fetch only rejects on network-level failure — the server is unreachable.
    throw new Error(`can't reach Dispatch — is the server still running? (${method} ${path})`);
  }
  if (!res.ok) {
    // Prefer the server's actionable { error } message; fall back to status context.
    const detail = (await res.json().catch(() => ({}))).error;
    throw new Error(detail || `${method} ${path} failed — ${res.status} ${res.statusText}`);
  }
  return res.json();
}

let loadStateSeq = 0;
async function loadState() {
  // Websocket bursts (e.g. a login settling fires probe + usage broadcasts back-to-back)
  // trigger overlapping loadState calls. Drop any response superseded by a newer request
  // so a slow, stale /api/state can't clobber fresher state and revert the UI mid-flight.
  const seq = ++loadStateSeq;
  const data = await api('/api/state');
  if (seq !== loadStateSeq) return;
  S.data = data;
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
const boardMaxBounces = () => S.data.board.settings.maxBounces ?? 3;
function parseMaxBouncesInput(sel, fallback = null) {
  const v = $(sel).value.trim();
  if (v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

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
// display number for a ticket — "DSP-039"; falls back to the raw id for pre-seq tickets
const ticketNo = (t) => Number.isFinite(t?.seq) ? `DSP-${String(t.seq).padStart(3, '0')}` : (t?.id || '');
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

// "2H14M" remaining-until-reset countdown from an ISO timestamp (compact, no seconds).
function fmtResetIn(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((t - Date.now()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}H${String(m).padStart(2, '0')}M` : `${m}M`;
}
// Weekly reset as weekday + HH:MM in local time, e.g. "SUN 00:00".
function fmtResetDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const wd = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getDay()];
  return `${wd} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
// Auth-source badge derived from the usage source string (tier isn't in the data model).
function usageSourceLabel(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('oauth')) return 'OAUTH';
  if (s.includes('api')) return 'API';
  return '';
}

// One usage window: "5H ▓▓▓░ 38%" — the number is % REMAINING; the 5H meter fills
// with what's left and tones green → amber → red as it drains; the weekly meter stays
// muted ink. (Bar and number both show headroom, not consumption.)
function usageWindowHTML(label, win, provider, kind) {
  if (!win || !Number.isFinite(Number(win.usedPct))) {
    return `<span class="usage-window w${kind} missing"><span class="usage-key">${label}</span><b>—</b></span>`;
  }
  const used = clamp(win.usedPct);
  const remaining = clamp(100 - used);
  const tone = kind === '7d' ? 'muted' : meterTone(remaining);
  const title = [
    `${provider} ${label}: ${pctText(remaining)} remaining`,
    `${pctText(used)} used`,
    win.resetsAt ? `resets ${fmtTs(win.resetsAt)}` : '',
  ].filter(Boolean).join(' · ');
  return `<span class="usage-window w${kind} tone-${tone}" title="${esc(title)}">
    <span class="usage-key">${label}</span><span class="meter tone-${tone}" style="--pct:${remaining}%"><span></span></span><b>${pctText(remaining)}</b>
  </span>`;
}

function usageProviderHTML(provider) {
  const u = S.data.usage?.[provider] || {};
  const title = [u.source, u.at ? `updated ${fmtTs(u.at)}` : '', u.error ? `error: ${u.error}` : ''].filter(Boolean).join(' · ');
  // "MAX·OAUTH" / "PLUS·OAUTH" when the CLI auth file exposes a tier; source-derived otherwise
  const plan = u.plan ? String(u.plan).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ')[0] : '';
  const src = plan ? `${plan}·OAUTH` : usageSourceLabel(u.source);
  // dot echoes the 5H tone (green = headroom, amber = running low, red = nearly spent)
  const tone5 = Number.isFinite(Number(u.fiveHour?.usedPct)) ? meterTone(clamp(100 - u.fiveHour.usedPct)) : 'muted';
  const rst5 = u.fiveHour?.resetsAt ? fmtResetIn(u.fiveHour.resetsAt) : '';
  const rstWk = u.weekly?.resetsAt ? fmtResetDay(u.weekly.resetsAt) : '';
  // .usage-src + .usage-reset are surfaced on mobile (rich cards); desktop keeps the strip compact.
  const reset = (rst5 || rstWk)
    ? `<div class="usage-reset"><span>${rst5 ? `RST ${rst5}` : ''}</span><span>${rstWk ? `WK · ${rstWk}` : ''}</span></div>`
    : '';
  return `<div class="usage-provider" title="${esc(title)}">
    <div class="usage-top"><span class="usage-dot tone-${tone5}"></span><span class="usage-name">${provider}</span>${src ? `<span class="usage-src">${esc(src)}</span>` : ''}</div>
    ${usageWindowHTML('5H', u.fiveHour, provider, '5h')}
    ${usageWindowHTML('7D', u.weekly, provider, '7d')}
    ${reset}
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

function providerCommands(type) {
  if (type === 'claude') {
    return [
      'claude --version',
      'claude auth login', // subscription sign-in (--claudeai is the CLI default)
    ];
  }
  return [
    'codex --version',
    'codex login',
  ];
}

/* ---------- Providers → 4C guided stepper (Enable → Authenticate → Assign) ----------
   Pure view layer over setupInfo(). Re-emits the same ids the settings handlers bind to
   (#s-<type>-enabled, #s-preset, #s-preset-apply, #s-setup-complete, #s-probe, data-probe),
   so no wiring changes are needed beyond the new data-auth launch button. */

// Derive the three-step state from the existing setup payload.
function providerStepState() {
  const info = setupInfo();
  const enabledTypes = PROVIDER_ORDER.filter((t) => info.providers?.[t]?.enabled !== false);
  // Step 1 — at least one provider is enabled for automation.
  const enable = enabledTypes.length > 0;
  // Step 2 — every ENABLED + INSTALLED provider is authenticated (disabled ones skipped).
  const relevant = enabledTypes.filter((t) => info.providers?.[t]?.installed);
  const auth = enable && relevant.length > 0 && relevant.every((t) => info.providers?.[t]?.authenticated);
  // Step 3 — roles assigned + setup marked complete.
  const assign = Boolean(info.completedAt);
  const doneCount = [enable, auth, assign].filter(Boolean).length;
  return { enable, auth, assign, doneCount, enabledTypes };
}

// Enable toggle for Step 1 — keeps the #s-<type>-enabled id the #s-save handler reads.
function stepEnableToggle(type) {
  const on = setupInfo().providers?.[type]?.enabled !== false;
  return `<label class="check-row inline step-enable">
    <input id="s-${type}-enabled" type="checkbox" ${on ? 'checked' : ''}>
    <span>${providerStatusLabel(type)}</span>
  </label>`;
}

// One provider row inside Step 2. Three states: authenticated (pill only), login in
// progress (open-URL / paste-code controls, driven by setup.authPending from the
// server's in-memory login sessions), or idle (command + AUTHENTICATE →).
function stepAuthRow(type) {
  const info = setupInfo();
  const st = info.providers?.[type] || {};
  const label = providerStatusLabel(type).toUpperCase();
  const authed = Boolean(st.authenticated);
  const pending = !authed ? info.authPending?.[type] : null;
  const lastError = !authed && !pending ? info.authErrors?.[type] : null;
  const cmd = providerCommands(type)[1] || ''; // the subscription login command

  if (authed) {
    return `<div class="step-auth">
      <div class="step-auth-head">
        <span class="step-dot tone-ok"></span>
        <span class="step-auth-name">${label}</span>
        <span class="setup-pill ok">✓ AUTHENTICATED</span>
        <button class="btn" data-probe="${type}">↻ RE-CHECK</button>
      </div>
    </div>`;
  }

  if (pending) {
    return `<div class="step-auth todo">
      <div class="step-auth-head">
        <span class="step-dot tone-warn"></span>
        <span class="step-auth-name">${label}</span>
        <span class="setup-pill warn">⋯ LOGIN IN PROGRESS</span>
        <button class="btn" data-auth-cancel="${type}">✕ CANCEL</button>
      </div>
      <div class="step-auth-cmd">
        <code>${esc(pending.command || cmd)}</code>
        <button class="btn btn-accent" data-auth-open="${type}" ${pending.url ? '' : 'disabled'}>OPEN LOGIN PAGE ↗</button>
      </div>
      ${pending.needsCode ? `<div class="step-auth-cmd">
        <input class="step-code" data-auth-code-input="${type}" placeholder="paste the code from the browser" autocomplete="off" spellcheck="false">
        <button class="btn btn-accent" data-auth-code="${type}">SUBMIT CODE →</button>
      </div>
      <div class="hint">sign in with your subscription in the login tab — it shows a one-time code; paste it above.</div>`
      : `<div class="hint">finish the sign-in in the opened tab (browser on the Dispatch machine) — this row updates by itself.</div>`}
    </div>`;
  }

  return `<div class="step-auth todo">
    <div class="step-auth-head">
      <span class="step-dot tone-warn"></span>
      <span class="step-auth-name">${label}</span>
      <span class="setup-pill warn">! NOT AUTHENTICATED</span>
      <button class="btn" data-probe="${type}">↻ RE-CHECK</button>
    </div>
    <div class="step-auth-cmd">
      <code>${esc(cmd)}</code>
      <button class="btn" data-copy="${type}">COPY</button>
      <button class="btn btn-accent" data-auth="${type}">AUTHENTICATE →</button>
    </div>
    ${lastError ? `<div class="hint bad">${esc(lastError)} — try again, or run \`${esc(cmd)}\` in a terminal, then RE-CHECK</div>` : ''}
  </div>`;
}

function setupStepperHTML(s) {
  const st = providerStepState();
  const presetVal = s.setup?.lastPreset || 'both';
  const node = (n, done, active) =>
    `<span class="step-node ${done ? 'done' : active ? 'active' : 'pending'}">${done ? '✓' : n}</span>`;
  // per-step done/active drives BOTH the desktop rail node and the mobile inline chip
  const step1 = { done: st.enable, active: !st.enable };
  const step2 = { done: st.auth, active: st.enable && !st.auth };
  const step3 = { done: st.assign, active: st.auth && !st.assign };
  const bodyClass = (step, locked) =>
    `step-body${locked ? ' step-locked' : ''}${step.done ? ' is-done' : step.active ? ' is-active' : ''}`;
  const authedCount = st.enabledTypes.filter((t) => setupInfo().providers?.[t]?.authenticated).length;

  return `
  <div class="stepper-head">
    <div class="section-head" style="border:none;margin:0;padding:0">PROVIDER SETUP</div>
    <div class="stepper-progress">
      <span>${st.doneCount} OF 3 DONE</span>
      <span class="meter tone-live" style="--pct:${(st.doneCount / 3) * 100}%"><span></span></span>
    </div>
  </div>

  <div class="stepper">
    <!-- STEP 1 — ENABLE -->
    <div class="step-rail">${node(1, step1.done, step1.active)}<span class="step-spine"></span></div>
    <div class="${bodyClass(step1, false)}">
      <div class="step-title" data-step="1">01 · Enable providers ${st.enable ? '' : '<span class="step-flag active">START HERE</span>'}</div>
      <div class="step-sub">${st.enabledTypes.length} of ${PROVIDER_ORDER.length} enabled for automation</div>
      <div class="step-enables">${PROVIDER_ORDER.map(stepEnableToggle).join('')}</div>
    </div>

    <!-- STEP 2 — AUTHENTICATE -->
    <div class="step-rail">${node(2, step2.done, step2.active)}<span class="step-spine"></span></div>
    <div class="${bodyClass(step2, !st.enable)}">
      <div class="step-title" data-step="2">02 · Authenticate ${step2.active ? '<span class="step-flag">IN PROGRESS</span>' : ''}</div>
      <div class="step-sub">${authedCount} of ${st.enabledTypes.length} authenticated</div>
      ${st.enabledTypes.map(stepAuthRow).join('')}
      <div class="hint"><button class="btn" id="s-probe" style="padding:2px 6px">[ re-probe CLIs ]</button></div>
    </div>

    <!-- STEP 3 — ASSIGN -->
    <div class="step-rail">${node(3, step3.done, step3.active)}</div>
    <div class="${bodyClass(step3, !st.auth)}">
      <div class="step-title" data-step="3">03 · Assign roles</div>
      <div class="step-sub">Preset drives Planning / Build / Review harnesses</div>
      <select id="s-preset" class="step-preset">
        <option value="both" ${presetVal === 'both' || presetVal === 'manual' ? 'selected' : ''}>Both (planning: Claude, build: Codex)</option>
        <option value="claude" ${presetVal === 'claude' || presetVal === 'claude only' ? 'selected' : ''}>Claude only</option>
        <option value="codex" ${presetVal === 'codex' || presetVal === 'codex only' ? 'selected' : ''}>Codex only</option>
      </select>
      <button class="btn" id="s-preset-apply">[ APPLY PRESET ]</button>
      <div class="hint">Presets are shortcuts — PHASE DEFAULTS below lets each phase run ANY provider, model &amp; effort.</div>
    </div>
  </div>

  <div class="stepper-foot">
    <span class="hint" style="margin:0">${st.enable && st.auth ? 'Ready — mark setup complete.' : 'Finish steps 1 &amp; 2 to complete setup.'}</span>
    <button class="btn ${st.enable && st.auth ? 'btn-accent' : ''}" id="s-setup-complete" ${st.enable && st.auth ? '' : 'disabled'}>[ MARK SETUP COMPLETE ]</button>
  </div>`;
}

// Everything the stepper re-render depends on. When this changes (probe result, a login
// session starting/settling, setup completion), the open settings modal patches ONLY the
// stepper region — full re-renders would wipe unsaved edits in the other panes.
function stepperFingerprint() {
  const info = setupInfo();
  return JSON.stringify([
    PROVIDER_ORDER.map((t) => {
      const p = info.providers?.[t] || {};
      return [p.enabled, p.installed, p.authenticated, p.authDetail];
    }),
    Object.keys(info.authPending || {}),
    info.authErrors || {},
    info.completedAt,
  ]);
}

// Surgical stepper refresh, driven by websocket state-changed while SETTINGS is open.
// Skips when the user is mid-interaction: typing a login code, or an enable toggle is
// dirty vs the server (a re-render would silently revert their unsaved change).
function updateStepperUI() {
  const box = $('#s-stepper');
  if (!box) return;
  const fp = stepperFingerprint();
  if (fp === S.stepperFp) return;
  const codeInput = box.querySelector('[data-auth-code-input]');
  if (codeInput && codeInput.value.trim() && setupInfo().authPending?.[codeInput.dataset.authCodeInput]) return;
  for (const type of PROVIDER_ORDER) {
    const el = $(`#s-${type}-enabled`);
    if (el && el.checked !== (setupInfo().providers?.[type]?.enabled !== false)) return;
  }
  box.innerHTML = setupStepperHTML(S.data.board.settings);
  wireStepperHandlers();
  S.stepperFp = fp;
}

// While a login session is pending, poll state as a fallback so the row still flips to
// AUTHENTICATED even if the websocket 'state-changed' push is missed (reconnect window,
// suspended tab). Self-clearing: stops when no session is pending or SETTINGS closes.
let authPollTimer = null;
function syncAuthPolling() {
  const pendingTypes = Object.keys(setupInfo().authPending || {});
  const needed = pendingTypes.length > 0 && Boolean($('#s-stepper'));
  if (needed && !authPollTimer) {
    authPollTimer = setInterval(() => {
      if (!$('#s-stepper') || !Object.keys(setupInfo().authPending || {}).length) {
        clearInterval(authPollTimer);
        authPollTimer = null;
        return;
      }
      loadState().catch(() => { /* transient fetch failure — next tick retries */ });
    }, 2500);
  } else if (!needed && authPollTimer) {
    clearInterval(authPollTimer);
    authPollTimer = null;
  }
}

// Handlers for everything inside #s-stepper. Called on every stepper (re)render — all
// bindings are scoped to current DOM nodes, so re-wiring after a patch is safe.
function wireStepperHandlers() {
  S.stepperFp = stepperFingerprint();
  syncAuthPolling();
  for (const type of PROVIDER_ORDER) {
    const probeBtn = document.querySelector(`[data-probe="${type}"]`);
    const copyBtn = document.querySelector(`[data-copy="${type}"]`);
    const firstCmd = providerCommands(type)[1] || '';
    probeBtn?.addEventListener('click', async () => {
      probeBtn.textContent = '[ CHECKING… ]';
      try {
        await api('/api/probe', 'POST', {});
        await loadState();
        updateStepperUI();
        toast('CLI STATUS REFRESHED');
      } catch (e) { alertErr(e); }
      const btn = document.querySelector(`[data-probe="${type}"]`);
      if (btn) btn.textContent = '↻ RE-CHECK';
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

  // AUTHENTICATE → : start the subscription login on the host, open its URL here.
  // The blank tab is opened synchronously (inside the click) so popup blockers allow it,
  // then pointed at the auth URL once the server hands it back.
  for (const btn of document.querySelectorAll('[data-auth]')) {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.auth;
      btn.textContent = '[ STARTING… ]';
      btn.disabled = true;
      const popup = window.open('', '_blank');
      try {
        const r = await api('/api/setup/auth', 'POST', { type });
        if (popup && r.url) popup.location = r.url;
        else if (popup) popup.close();
        await loadState();
        updateStepperUI();
        if (!popup && r.url) toast('popup blocked — use OPEN LOGIN PAGE ↗ to open the sign-in tab', true);
        else toast(r.needsCode ? 'login tab opened — sign in, then paste the code below' : `login tab opened — finish the sign-in in the browser on ${r.host}`);
      } catch (e) {
        if (popup) popup.close();
        await loadState().catch(() => {});
        updateStepperUI();
        alertErr(e);
      }
    });
  }
  // OPEN LOGIN PAGE ↗ : re-open the pending session's URL (popup lost / opened elsewhere).
  for (const btn of document.querySelectorAll('[data-auth-open]')) {
    btn.addEventListener('click', () => {
      const url = setupInfo().authPending?.[btn.dataset.authOpen]?.url;
      if (url) window.open(url, '_blank');
      else toast('no login URL yet — click AUTHENTICATE again', true);
    });
  }
  // SUBMIT CODE → : forward the one-time code to the CLI's stdin (claude flow).
  for (const btn of document.querySelectorAll('[data-auth-code]')) {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.authCode;
      const input = document.querySelector(`[data-auth-code-input="${type}"]`);
      const code = (input?.value || '').trim();
      if (!code) { toast('paste the code from the browser first', true); return; }
      btn.textContent = '[ VERIFYING… ]';
      btn.disabled = true;
      try {
        await api('/api/setup/auth/code', 'POST', { type, code });
        toast('code submitted — verifying with the provider…');
        // success flips the row via the server's post-login probe broadcast
      } catch (e) {
        alertErr(e);
        const b = document.querySelector(`[data-auth-code="${type}"]`);
        if (b) { b.textContent = 'SUBMIT CODE →'; b.disabled = false; }
      }
    });
  }
  for (const btn of document.querySelectorAll('[data-auth-cancel]')) {
    btn.addEventListener('click', async () => {
      try {
        await api('/api/setup/auth/cancel', 'POST', { type: btn.dataset.authCancel });
        await loadState();
        updateStepperUI();
        toast('login cancelled');
      } catch (e) { alertErr(e); }
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
    finally { const b = $('#s-preset-apply'); if (b) b.textContent = '[ APPLY PRESET ]'; }
  };
  $('#s-setup-complete').onclick = async () => {
    try {
      $('#s-setup-complete').textContent = '[ SAVING… ]';
      await api('/api/setup/complete', 'POST', {});
      await loadState();
      renderSettingsModal();
      toast('SETUP MARKED COMPLETE');
    } catch (e) { alertErr(e); }
    finally { const b = $('#s-setup-complete'); if (b) b.textContent = '[ MARK SETUP COMPLETE ]'; }
  };
  const probeAll = $('#s-probe');
  if (probeAll) probeAll.onclick = () => api('/api/probe', 'POST', {}).catch(alertErr);
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
// Pull image files out of a clipboard payload, naming browser-generated blobs.
function imagesFromClipboard(dataTransfer) {
  const out = [];
  let n = 0;
  for (const it of [...(dataTransfer?.items || [])]) {
    if (it.kind !== 'file' || !it.type.startsWith('image/')) continue;
    const blob = it.getAsFile();
    if (!blob) continue;
    const ext = (blob.type.split('/')[1] || 'png').replace('+xml', '');
    const name = (blob.name && blob.name !== 'image.png')
      ? blob.name
      : `pasted-${Date.now()}${n ? '-' + n : ''}.${ext}`;
    out.push(new File([blob], name, { type: blob.type }));
    n++;
  }
  return out;
}
function insertAtCursor(ta, text) {
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  const pos = s + text.length;
  ta.selectionStart = ta.selectionEnd = pos;
}
function wirePasteImages(ta, onImages) {
  if (!ta) return;
  ta.addEventListener('paste', async (e) => {
    const dt = e.clipboardData;
    const imgs = imagesFromClipboard(dt);
    if (!imgs.length) return;
    const hasText = [...(dt?.items || [])].some((it) => it.kind === 'string');
    if (!hasText) e.preventDefault();
    insertAtCursor(ta, imgs.map((f) => `[image: ${f.name}]`).join('\n'));
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await onImages(imgs);
  });
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
  `<div class="att-drop" id="${dropId}"><span>DROP FILES, PASTE, OR</span><button type="button" class="btn" id="${browseId}">[ BROWSE ]</button><input type="file" id="${inputId}" multiple hidden></div>`;

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
  // Settings modal never fully re-renders on state changes (it holds unsaved edits), but
  // the provider stepper must flip live when a login completes — patch just that region.
  if (S.modal?.type === 'settings') updateStepperUI();
  if (S.modal?.type === 'archive') renderArchiveModal();
}

function renderTopbar() {
  const h = S.data.health;
  // Paper look: liveness lives in the usage meters. Only surface health when a harness is DOWN.
  const down = [];
  if (!h.claude?.ok) down.push('CLAUDE');
  if (!h.codex?.ok) down.push('CODEX');
  $('#health').innerHTML = down.map((n) => `<span class="bad">${n} OFFLINE</span>`).join(' &nbsp;///&nbsp; ');
  $('#usage').innerHTML = usageStripHTML();
  const r = S.data.runs;
  const cap = S.data.board.settings.maxConcurrent ?? 2;
  const paused = cap <= 0;
  $('#queueinfo').innerHTML = paused
    ? `<span class="paused-flag">⏸ PAUSED</span> · RUN <b>${r.running.length}</b> · Q <b>${r.queued.length}</b>`
    : `RUN <b>${r.running.length}</b> · QUEUE <b>${r.queued.length}</b> · CAP <b>${cap}</b>`;
  $('#btn-new').textContent = mqMobile.matches ? '+ TICKET' : '[ + TICKET ]';  // mobile bar drops the brackets
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
      : '';
  }
  const openNotice = $('#s-open-setup');
  if (openNotice) openNotice.onclick = () => pushModal({ type: 'settings', tab: 'providers' });
}

/* Board = design 3a: desktop (≥760px) is the 1c pipeline rail + in-flight tracker;
   mobile (<760px) is the 2a one-phase-per-screen swipe view. */
const mqMobile = window.matchMedia('(max-width: 760px)');
mqMobile.addEventListener('change', () => { if (S.data) render(); }); // topbar labels + board layout both flip

// Phase/harness accent for a column: intake=red, terminal=faint, else the harness type colour.
function stationAccent(c) {
  if (c.role === 'intake') return 'var(--red)';
  if (c.role === 'terminal') return 'var(--fg-faint)';
  if (c.harness?.type === 'claude') return 'var(--claude)';
  if (c.harness?.type === 'codex') return 'var(--codex)';
  return 'var(--red)'; // human agent phase
}

function ticketStatus(t, c) {
  if (S.data.runs.running.includes(t.id)) return 'running';
  if (S.data.runs.queued.includes(t.id)) return 'queued';
  if (c.role === 'terminal') return 'done';
  return t.status;
}

// Compact harness label for a station/row, e.g. "CLAUDE·FABLE-5·HIGH", "HUMAN · INTAKE".
function stationHarnessLabel(c) {
  if (c.role === 'intake') return 'HUMAN · INTAKE';
  if (c.role === 'terminal') return 'TERMINAL · GATE';
  const h = c.harness || {};
  if (h.type === 'human') return 'HUMAN';
  // strip the redundant type prefix from the model id: claude-fable-5 → FABLE-5
  const model = String(h.model || '').replace(new RegExp(`^${h.type}[-_]`, 'i'), '');
  return [h.type, model, h.effort].filter(Boolean).join('·').toUpperCase();
}

// 4-char phase tag for the tracker progress bar (data-driven from the column name).
function phaseAbbrev(name) {
  return String(name || '').replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase() || '—';
}

function queuePos(id) {
  const i = (S.data.runs.queued || []).indexOf(id);
  return i < 0 ? '?' : i + 1;
}

function stopTicketAction(e) {
  e.preventDefault();
  e.stopPropagation();
}

function defaultRestoreColumnId() {
  return (cols().find((c) => c.role === 'terminal') || cols().at(-1) || {}).id || '';
}

function ticketActionButtonsHTML(t, className = 'ticket-actions') {
  const classes = ['ticket-actions', className].filter(Boolean).join(' ');
  return `<span class="${classes}" data-ticket-actions>
    <button type="button" class="ticket-icon" data-ticket-archive="${esc(t.id)}" title="Archive ticket" aria-label="Archive ${esc(t.title)}">A</button>
    <button type="button" class="ticket-icon danger" data-ticket-delete="${esc(t.id)}" title="Delete ticket" aria-label="Delete ${esc(t.title)}">X</button>
  </span>`;
}

function wireTicketActionButtons(root = document) {
  for (const b of root.querySelectorAll('[data-ticket-archive]')) {
    b.onclick = (e) => {
      stopTicketAction(e);
      archiveTicket(b.dataset.ticketArchive, { closeTicketModal: S.modal?.type === 'ticket' });
    };
  }
  for (const b of root.querySelectorAll('[data-ticket-delete]')) {
    b.onclick = (e) => {
      stopTicketAction(e);
      deleteTicket(b.dataset.ticketDelete, { closeTicketModal: S.modal?.type === 'ticket' });
    };
  }
}

async function archiveTicket(id, { closeTicketModal = false } = {}) {
  const t = S.data.tickets.find((x) => x.id === id);
  const active = S.data.runs.running.includes(id) || S.data.runs.queued.includes(id);
  const msg = active
    ? `Archive "${t?.title || id}" and stop its queued/running work? It will be hidden from the board but kept in the archive.`
    : `Archive "${t?.title || id}"? It will be hidden from the board but kept in the archive.`;
  if (!confirm(msg)) return;
  try {
    await api(`/api/tickets/${id}/archive`, 'POST', {});
    toast('ARCHIVED');
  } catch (e) { alertErr(e); return; }
  if (closeTicketModal && S.modal?.type === 'ticket' && S.modal.id === id) closeModal();
  await loadState();
}

async function deleteTicket(id, { closeTicketModal = false, archived = false } = {}) {
  const t = S.data.tickets.find((x) => x.id === id);
  const noun = archived ? 'archived ticket' : 'ticket';
  if (!confirm(`Permanently delete ${noun} "${t?.title || id}" + dossier + transcripts + attachments?`)) return;
  try {
    await api(`/api/tickets/${id}`, 'DELETE');
    toast('DELETED');
  } catch (e) { alertErr(e); return; }
  if (closeTicketModal && S.modal?.type === 'ticket' && S.modal.id === id) closeModal();
  await loadState();
}

async function restoreTicket(id, columnId = defaultRestoreColumnId()) {
  try {
    await api(`/api/tickets/${id}/unarchive`, 'POST', { columnId });
    toast('RESTORED');
  } catch (e) { alertErr(e); return; }
  await loadState();
}

function renderBoard() {
  const board = $('#board');
  board.innerHTML = '';
  board.classList.toggle('mobile', mqMobile.matches);
  if (mqMobile.matches) renderMobileBoard(board);
  else renderRailBoard(board);
}

/* ---- desktop: pipeline rail + in-flight tracker ---- */
function renderRailBoard(board) {
  const rail = document.createElement('div');
  rail.className = 'rail';
  const list = cols();
  list.forEach((c, i) => {
    rail.appendChild(stationEl(c));
    if (i < list.length - 1) {
      const arr = document.createElement('div');
      arr.className = 'rail-arrow';
      arr.textContent = '▸';
      rail.appendChild(arr);
    }
  });
  board.appendChild(rail);
  board.appendChild(inflightEl());
}

function stationEl(c) {
  const tickets = ticketsIn(c.id);
  const accent = stationAccent(c);
  const runningHere = tickets.some((t) => S.data.runs.running.includes(t.id));
  const disabledType = c.harness?.type && c.harness.type !== 'human' && !isProviderEnabled(c.harness.type);
  const el = document.createElement('div');
  el.className = 'station';
  el.style.setProperty('--accent', accent);
  el.innerHTML = `
    <div class="station-head">
      <div class="sh-top">
        <span class="station-name">${esc(c.name)}</span>
        <span style="display:inline-flex;gap:6px;align-items:center">
          ${runningHere ? '<span class="run-badge">★ RUN</span>' : ''}
          <span class="station-count">${String(tickets.length).padStart(2, '0')}</span>
        </span>
      </div>
      <div class="station-harness"><span class="dot"></span>${esc(stationHarnessLabel(c))}${c.role === 'agent' && !c.autoRun ? ' · MANUAL' : ''}<button class="cfg" data-cfg="${c.id}" title="Configure phase">CFG</button></div>
      ${disabledType ? '<div class="station-sweep" style="color:var(--red);border-color:var(--red)">PROVIDER DISABLED IN SETUP</div>' : ''}
      ${c.role === 'intake' && S.data.scheduler?.autoDispatch
        ? '<div class="station-sweep">AUTO SWEEP <span data-sweep>T-—:——</span></div>' : ''}
    </div>
    <div class="station-body"></div>`;
  const body = $('.station-body', el);
  const CAP = 4;
  const expanded = S.railExpanded[c.id];
  const shown = expanded ? tickets : tickets.slice(0, CAP);
  for (const t of shown) body.appendChild(chipEl(t, c));
  if (tickets.length > CAP) {
    const btn = document.createElement('button');
    btn.className = 'chip-more';
    btn.textContent = expanded ? 'SHOW LESS' : `+${tickets.length - CAP} MORE`;
    btn.onclick = () => { S.railExpanded[c.id] = !expanded; renderBoard(); };
    body.appendChild(btn);
  }
  if (c.role === 'intake') {
    const drop = document.createElement('div');
    drop.className = 'chip-drop';
    drop.textContent = '· · · DROP TICKET · · ·';
    body.appendChild(drop);
  }
  $('.cfg', el).onclick = (e) => { e.stopPropagation(); pushModal({ type: 'column', id: c.id }); };
  // drag & drop a ticket onto a station = move it to that column
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('dragover'); });
  el.addEventListener('dragleave', () => el.classList.remove('dragover'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.classList.remove('dragover');
    const id = e.dataTransfer.getData('text/ticket');
    if (id) await api(`/api/tickets/${id}/move`, 'POST', { columnId: c.id }).catch(alertErr);
  });
  return el;
}

function chipEl(t, c) {
  const el = document.createElement('div');
  const st = ticketStatus(t, c);
  el.className = `chip card status-${st}`;
  el.dataset.id = t.id;
  el.draggable = true;
  el.innerHTML = `<span class="led ${st}"></span><span class="title">${esc(t.title)}</span>${ticketActionButtonsHTML(t, 'chip-actions')}`;
  el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/ticket', t.id); el.classList.add('dragging'); });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  wireTicketActionButtons(el);
  el.onclick = () => pushModal({ type: 'ticket', id: t.id, tab: 'overview' });
  return el;
}

function inflightEl() {
  const running = S.data.runs.running || [];
  const queued = S.data.runs.queued || [];
  const wrap = document.createElement('div');
  wrap.className = 'inflight';
  wrap.innerHTML = `<div class="inflight-head"><span class="dot"></span>IN FLIGHT · ${running.length} RUNNING · ${queued.length} QUEUED</div>`;
  const track = document.createElement('div');
  track.className = 'track';
  const ids = [...running, ...queued.filter((id) => !running.includes(id))];
  const rows = ids.map((id) => S.data.tickets.find((t) => t.id === id)).filter((t) => t && !t.archived);
  if (!rows.length) {
    track.innerHTML = '<div class="inflight-empty">NO RUNS IN FLIGHT — queue a ticket and watch it move down the line</div>';
  } else {
    for (const t of rows) track.appendChild(trackRowEl(t));
  }
  wrap.appendChild(track);
  return wrap;
}

function trackRowEl(t) {
  const list = cols();
  const cur = list.findIndex((col) => col.id === t.columnId);
  const c = list[cur] || {};
  const isRun = S.data.runs.running.includes(t.id);
  const isQ = S.data.runs.queued.includes(t.id);
  const accent = stationAccent(c);
  const segs = list.map((col, i) => {
    if (i < cur) return `<span class="seg passed" style="background:${stationAccent(col)}"></span>`;
    if (i === cur) {
      if (isRun) return `<span class="seg passed current-run" style="background:${accent}"></span>`;
      if (isQ) return '<span class="seg current-queue"></span>';
      return `<span class="seg passed" style="background:${accent}"></span>`;
    }
    return '<span class="seg"></span>';
  }).join('');
  const labels = list.map((col, i) => `<span class="${i === cur ? 'here' : ''}">${esc(phaseAbbrev(col.name))}</span>`).join('');
  const startMs = t.startedAt ? Date.parse(t.startedAt) : null;
  const row = document.createElement('div');
  row.className = 'track-row card';
  row.dataset.id = t.id;
  row.innerHTML = `
    <div style="min-width:0">
      <div class="track-title">${esc(t.title)}</div>
      <div class="track-sub"><span class="dot" style="background:${accent}"></span>${esc(ticketNo(t))} · ${esc(stationHarnessLabel(c))}</div>
    </div>
    <div><div class="seg-row">${segs}</div><div class="seg-labels">${labels}</div></div>
    <div class="track-phase${isQ ? ' queued' : ''}">${isQ ? `Queued · pos ${queuePos(t.id)}` : `▸ ${esc(c.name || '?')}`}</div>
    ${isRun && startMs ? `<div class="track-elapsed" data-tplus="${startMs}">T+00:00</div>` : '<div class="track-elapsed none">—</div>'}
    ${ticketActionButtonsHTML(t, 'track-actions')}`;
  wireTicketActionButtons(row);
  row.onclick = () => pushModal({ type: 'ticket', id: t.id, tab: 'overview' });
  return row;
}

/* ---- mobile: one phase per screen, swipe/tap between phases ---- */
function renderMobileBoard(board) {
  const list = cols();
  if (!list.length) return;
  S.mobilePhase = Math.max(0, Math.min(S.mobilePhase, list.length - 1));
  const idx = S.mobilePhase;
  const c = list[idx];
  const tickets = ticketsIn(c.id);
  const accent = stationAccent(c);
  const runningHere = tickets.some((t) => S.data.runs.running.includes(t.id));

  // run/queue/cap ledger (queueinfo is hidden on mobile; this restates it above the phase pager)
  const rr = S.data.runs;
  const cap = S.data.board.settings.maxConcurrent ?? 2;
  const strip = document.createElement('div');
  strip.className = 'mrunstrip';
  strip.innerHTML = cap <= 0
    ? `<span class="paused-flag">⏸ PAUSED</span> · RUN ${rr.running.length} · Q ${rr.queued.length}`
    : `RUN ${rr.running.length} · Q ${rr.queued.length} · CAP ${cap}`;
  board.appendChild(strip);

  const nav = document.createElement('div');
  nav.className = 'mphase-nav';
  nav.innerHTML = `
    <button class="mprev" ${idx === 0 ? 'disabled' : ''} aria-label="previous phase">‹</button>
    <div class="mphase-title">
      <div class="n">${esc(c.name)}</div>
      <div class="h">${runningHere ? '<span class="run-badge">★ RUN</span>' : ''}<span class="dot" style="background:${accent}"></span>${esc(stationHarnessLabel(c))}</div>
    </div>
    <button class="mnext" ${idx === list.length - 1 ? 'disabled' : ''} aria-label="next phase">›</button>`;
  board.appendChild(nav);

  const dots = document.createElement('div');
  dots.className = 'mdots';
  dots.innerHTML = list.map((_, i) => `<span class="${i === idx ? 'on' : ''}"></span>`).join('');
  board.appendChild(dots);

  const body = document.createElement('div');
  body.className = 'mbody';
  if (tickets.length) {
    for (const t of tickets) body.appendChild(mcardEl(t, c));
  } else {
    const empty = document.createElement('div');
    empty.className = 'chip-drop';
    empty.textContent = '· · · NO TICKETS IN THIS PHASE · · ·';
    body.appendChild(empty);
  }
  // every phase gets a drop target on mobile; tapping it opens the new-ticket form
  const drop = document.createElement('div');
  drop.className = 'chip-drop';
  drop.textContent = '· · · DROP TICKET · · ·';
  drop.onclick = () => { S.newAttachments = []; S.newOverrides = {}; pushModal({ type: 'new' }); };
  body.appendChild(drop);
  const prevN = idx > 0 ? list[idx - 1].name : '';
  const nextN = idx < list.length - 1 ? list[idx + 1].name : '';
  const hint = document.createElement('div');
  hint.className = 'mswipe-hint';
  hint.innerHTML = `${prevN ? '‹ ' : ''}SWIPE · ${[prevN && esc(prevN), nextN && esc(nextN)].filter(Boolean).join('&nbsp;&nbsp;|&nbsp;&nbsp;')}${nextN ? ' ›' : ''}`;
  body.appendChild(hint);
  board.appendChild(body);

  const go = (d) => { const n = idx + d; if (n >= 0 && n < list.length) { S.mobilePhase = n; renderBoard(); } };
  $('.mprev', nav).onclick = () => go(-1);
  $('.mnext', nav).onclick = () => go(1);
  let x0 = null;
  board.ontouchstart = (e) => { x0 = e.touches[0].clientX; };
  board.ontouchend = (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 45) go(dx < 0 ? 1 : -1);
    x0 = null;
  };
}

function mcardEl(t, c) {
  const el = document.createElement('div');
  const st = ticketStatus(t, c);
  el.className = `mcard card status-${st}`;
  el.dataset.id = t.id;
  const last = [...t.activity].reverse().find((a) => a.kind !== 'run');
  const startMs = t.startedAt ? Date.parse(t.startedAt) : null;
  const foot = st === 'running' && startMs
    ? `<span class="t run"><span data-tplus="${startMs}">T+00:00</span> · RUNNING</span>`
    : `<span class="t">${esc(st.toUpperCase())}</span>`;
  el.innerHTML = `
    <div class="mc-top"><span class="led ${st}"></span><span class="title">${esc(t.title)}</span>${ticketActionButtonsHTML(t, 'mcard-actions')}</div>
    <div class="mc-meta"><span>${esc(ticketNo(t))}</span><span>${esc(t.workspace.split('/').pop())}</span></div>
    <div class="mc-harness"><span class="dot" style="background:${stationAccent(c)}"></span>${esc(stationHarnessLabel(c))}</div>
    ${last ? `<div class="mc-last">▸ ${esc(last.text)}</div>` : ''}
    <div class="mc-foot">${foot}<span class="tap">tap to open ▸</span></div>`;
  wireTicketActionButtons(el);
  el.onclick = () => pushModal({ type: 'ticket', id: t.id, tab: 'overview' });
  return el;
}

/* ---------- modals ---------- */
function closeModal() {
  // history.back() is only safe because initHistoryFromLocation() guarantees a
  // "board" entry sits beneath every modal we ever push — see below.
  if (history.state?.modal) { history.back(); return; }
  S.modal = null; S.transcript = null; $('#modal-root').innerHTML = '';
  history.replaceState({ modal: false }, '', location.pathname + location.search);
}

let toastTimer = null;
function toast(text, isError = false) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.addEventListener('click', () => { el.classList.remove('show'); clearTimeout(toastTimer); });
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.className = isError ? 'err show' : 'show';
  clearTimeout(toastTimer);
  // Errors are usually actionable ("run X, then RE-CHECK") — hold them longer and let a
  // click dismiss early; success toasts stay brief.
  toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 7000 : 2600);
}
function alertErr(e) { toast(`ERROR — ${e.message}`, true); }

function shell(title, bodyHTML, footHTML = '') {
  $('#modal-root').innerHTML = `
    <div class="overlay" id="overlay">
      <div class="panel">
        <div class="panel-head"><h3>${title}</h3><button class="x" id="modal-close">[ ESC ]</button></div>
        ${bodyHTML}
        ${footHTML ? `<div class="panel-foot">${footHTML}</div>` : ''}
      </div>
    </div>`;
  $('#modal-close').onclick = requestCloseModal;
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

/* ---------- URL-state routing: every modal open/tab is reflected in location.hash,
   so a hard refresh (or a shared/bookmarked link) lands back on the same view. ---------- */
function modalToHash(modal) {
  if (!modal) return '';
  if (modal.type === 'ticket') return modal.tab && modal.tab !== 'overview' ? `${modal.id}/${modal.tab}` : modal.id;
  if (modal.type === 'column') return `column/${modal.id}`;
  if (modal.type === 'settings') return modal.tab && modal.tab !== 'engine' ? `settings/${modal.tab}` : 'settings';
  if (modal.type === 'new') return 'new';
  if (modal.type === 'archive') return 'archive';
  return '';
}

function hashToModal(hash) {
  const h = String(hash || '').replace(/^#/, '');
  if (!h) return null;
  if (h === 'new') return { type: 'new' };
  if (h === 'archive') return { type: 'archive' };
  if (h === 'settings') return { type: 'settings', tab: 'engine' };
  if (h.startsWith('settings/')) {
    const tab = h.slice('settings/'.length);
    return { type: 'settings', tab: SETTINGS_TABS.includes(tab) ? tab : 'engine' };
  }
  if (h.startsWith('column/')) return { type: 'column', id: h.slice('column/'.length) };
  // bare ticket id (matches links already sent by notify.mjs) or id/tab
  const [id, tab] = h.split('/');
  if (id.startsWith('t-')) return { type: 'ticket', id, tab: TICKET_TABS.includes(tab) ? tab : 'overview' };
  return null;
}

// Writes the hash for a state change. Doesn't touch S.modal or the DOM — callers do
// that themselves first, since ticket tabs fully re-render but settings tabs just
// toggle CSS visibility (see renderSettingsModal) to preserve unsaved field edits.
function writeModalHash(modal, { push }) {
  const hash = modalToHash(modal);
  const url = hash ? `#${hash}` : location.pathname + location.search;
  if (push) history.pushState({ modal: Boolean(modal) }, '', url);
  else history.replaceState({ modal: Boolean(modal) }, '', url);
}

// Opens a *new* modal (as opposed to switching tabs inside the one that's already
// open) — always pushes, so Back steps out to whatever was open before, or the board.
function pushModal(modal) {
  S.modal = modal;
  renderModal();
  writeModalHash(modal, { push: true });
}

// Single source of truth for "what does the current hash mean" — runs on boot and on
// every hashchange (Back/Forward, address-bar edits, or a raw location.hash= write).
// Never writes history itself: by the time this runs, the URL has already changed.
function renderForHash() {
  const modal = hashToModal(location.hash);
  const missing =
    (modal?.type === 'ticket' && !S.data?.tickets?.some((t) => t.id === modal.id)) ||
    (modal?.type === 'column' && !cols().some((c) => c.id === modal.id));
  if (missing) {
    toast(`${modal.type === 'ticket' ? 'TICKET' : 'COLUMN'} NOT FOUND`, true);
    history.replaceState({ modal: false }, '', location.pathname + location.search);
    S.modal = null; S.transcript = null; $('#modal-root').innerHTML = '';
    return;
  }
  S.modal = modal;
  if (modal) renderModal();
  else { S.transcript = null; $('#modal-root').innerHTML = ''; }
}
window.addEventListener('hashchange', renderForHash);

// Establishes a "board" entry beneath whatever the page loaded with, so a deep link
// (Telegram notification, bookmark, shared URL) always has somewhere safe for Back to
// land instead of navigating out of the app entirely.
function initHistoryFromLocation() {
  const initialHash = location.hash;
  history.replaceState({ modal: false }, '', location.pathname + location.search);
  if (initialHash) history.pushState({ modal: true }, '', initialHash);
  renderForHash();
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
const TICKET_TABS = ['overview', 'activity', 'transcript', 'dossier'];

function renderTicketModal() {
  const t = S.data.tickets.find((x) => x.id === S.modal.id);
  if (!t) return closeModal();
  const tab = S.modal.tab || 'overview';
  const tabs = TICKET_TABS;
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
     <button class="btn" id="btn-archive-ticket">[ ARCHIVE ]</button>
     <button class="btn btn-danger" id="btn-del">[ DELETE ]</button>`
  );

  for (const b of document.querySelectorAll('[data-tab]')) {
    b.onclick = () => { S.modal.tab = b.dataset.tab; renderTicketModal(); writeModalHash(S.modal, { push: false }); };
  }
  $('#btn-move').onclick = () => api(`/api/tickets/${t.id}/move`, 'POST', { columnId: $('#move-to').value }).then(() => { toast('MOVED'); closeAndReload(); }).catch(alertErr);
  $('#btn-run').onclick = () => api(`/api/tickets/${t.id}/run`, 'POST', {}).then((r) => {
    if (r.queued) toast(r.startedPhase ? `PIPELINE STARTED → ${r.startedPhase}` : 'RUN QUEUED');
    else toast(`NOT QUEUED: ${r.reason || 'unknown'}`, true);
  }).catch(alertErr);
  $('#btn-stop').onclick = () => api(`/api/tickets/${t.id}/stop`, 'POST', {}).then(() => toast('STOP SIGNAL SENT')).catch(alertErr);
  $('#btn-archive-ticket').onclick = () => archiveTicket(t.id, { closeTicketModal: true });
  $('#btn-del').onclick = () => deleteTicket(t.id, { closeTicketModal: true, archived: t.archived });

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

function overridesGridHTML(draft) {
  const agentCols = cols().filter((c) => c.role === 'agent');
  return `<div class="overrides-wrap"><div class="overrides-grid">
    <div class="h">PHASE</div><div class="h">HARNESS</div><div class="h">MODEL</div><div class="h">EFFORT</div><div class="h">PERMS</div>
    ${agentCols.map((c) => {
      const o = draft[c.id] || {};
      const n = normalizeOverrideForColumn(o, c);
      if (n.model !== (o.model || '') || n.effort !== (o.effort || '') || n.permissions !== (o.permissions || '')) {
        setOverrideDraft(draft, c.id, { ...o, model: n.model, effort: n.effort, permissions: n.permissions });
      }
      const effType = n.type;
      const sameHarnessType = !o.type || o.type === c.harness.type;
      const defaultModelLabel = sameHarnessType ? `default (${c.harness.model || '—'})` : 'default';
      const defaultEffortLabel = sameHarnessType ? `default (${c.harness.effort || '—'})` : 'default';
      const defaultPermsLabel = sameHarnessType ? `default (${c.harness.permissions || '—'})` : 'default';
      const disabledWarning = effType !== 'human' && !isProviderEnabled(effType) && o.type
        ? '<div class="setup-pill warn">disabled in setup</div>'
        : '';
      return `<div>${esc(c.name)}</div>
        <div><select data-ov="${c.id}:type">
          <option value="" ${o.type ? '' : 'selected'}>default (${esc(c.harness.type)})</option>
          ${providerTypeOptions(o.type, { includeHuman: false, includeCurrent: true })}
        </select>${disabledWarning}</div>
        <div class="model-cell"><select data-ov="${c.id}:model">${harnessOptions('model', effType, n.model || '', defaultModelLabel)}</select>${refreshBtn()}</div>
        <div><select data-ov="${c.id}:effort">${harnessOptions('effort', effType, n.effort || '', defaultEffortLabel, n.model || (sameHarnessType ? c.harness.model : ''))}</select></div>
        <div><select data-ov="${c.id}:permissions">${harnessOptions('permissions', effType, n.permissions || '', defaultPermsLabel)}</select></div>`;
    }).join('')}
  </div></div>`;
}

function wireOverridesGrid(root, draft, refresh) {
  for (const sel of root.querySelectorAll('[data-ov]')) {
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
        refresh();
      }
    };
  }
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
  body.innerHTML = `
    <div class="kv">
      <div class="k">ID</div><div>${t.id}</div>
      <div class="k">WORKSPACE</div><div>${workspacePicker('f-ws', t.workspace)}</div>
      <div class="k">SCHEDULED</div><div><input id="f-sched" type="datetime-local" value="${esc(t.scheduledAt || '')}"></div>
      <div class="k">BOUNCE LIMIT</div><div>
        <input id="f-maxbounce" type="number" min="0" value="${t.maxBounces ?? ''}" placeholder="default (${boardMaxBounces()})" style="width:90px">
        <span class="skip-note">blank = board default; how many times it can be sent back before pausing for you</span>
      </div>
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
    ${overridesGridHTML(draft)}
    <div class="hint">claude efforts go up to max; codex up to xhigh. "custom…" under model takes any id the CLI accepts.</div>
    <div style="margin-top:14px"><button class="btn" id="btn-save-ticket">[ SAVE CHANGES ]</button></div>`;

  wireOverridesGrid(body, draft, () => renderOverview(body, t));
  wireWorkspacePicker('f-ws');

  $('#btn-save-ticket').onclick = async () => {
    await api(`/api/tickets/${t.id}`, 'PATCH', {
      workspace: $('#f-ws').value.trim(),
      description: $('#f-desc').value,
      scheduledAt: $('#f-sched').value || null,
      readOnly: $('#f-readonly').checked,
      overrides: draft,
      maxBounces: parseMaxBouncesInput('#f-maxbounce', null),
    }).then(() => toast('TICKET SAVED')).catch(alertErr);
  };

  // Attachments upload/remove independently of SAVE CHANGES so draft edits above are never lost.
  wireDropzone('ov-att-drop', 'ov-att-input', 'ov-att-browse', (files) => uploadTicketFiles(t, files));
  wirePasteImages($('#f-desc'), (files) => uploadTicketFiles(t, files));
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
  wirePasteImages($('#f-comment'), (files) => uploadTicketFiles(t, files));
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
function renderNewOverrides() {
  const box = $('#n-ov');
  if (!box) return;
  S.newOverrides ||= {};
  box.innerHTML = overridesGridHTML(S.newOverrides);
  wireOverridesGrid(box, S.newOverrides, renderNewOverrides);
}

function renderNewModal() {
  S.newOverrides ||= {};
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
      <label class="f">REVIEW / BOUNCE LIMIT (blank = board default: ${boardMaxBounces()})</label>
      <input id="n-maxbounce" type="number" min="0" placeholder="default (${boardMaxBounces()})">
      <label class="check-row"><input type="checkbox" id="n-readonly"> <span>READ-ONLY — agents may only read the repo for context (no edits, no commits)</span></label>
      <div id="n-skip-wrap" class="skip-wrap" hidden>
        <div class="skip-lbl">skip these phases (nothing to build/verify on a read-only ticket):</div>
        ${cols().filter((c) => c.role === 'agent').map((c) => `<label class="check-row sub"><input type="checkbox" class="n-skip" value="${c.id}" ${/build/i.test(c.name) ? 'checked' : ''}> <span>${esc(c.name)}</span></label>`).join('')}
      </div>
      <label class="f">PER-COLUMN HARNESS OVERRIDES ("default" = phase config)</label>
      <div id="n-ov"></div>
      <div class="hint">claude efforts go up to max; codex up to xhigh. "custom…" under model takes any id the CLI accepts.</div>
      <label class="f">ATTACHMENTS (listed in the dossier for the agents to read — max ${MAX_ATTACH_MB}MB each)</label>
      ${dropzoneHTML('n-att-drop', 'n-att-input', 'n-att-browse')}
      <div class="att-list" id="n-att-list"></div>
      <div class="hint">unscheduled backlog tickets start immediately if a run slot is free, otherwise on the next sweep (every ${S.data.board.settings.autoDispatchEveryMin || 5} min). a scheduled ticket waits for its timestamp.</div>
    </div>`,
    `<button class="btn btn-accent" id="n-create">[ CREATE ]</button>`);
  renderNewOverrides();
  wireDropzone('n-att-drop', 'n-att-input', 'n-att-browse', async (files) => {
    S.newAttachments = (S.newAttachments || []).concat(await readUploads(files));
    renderStagedAttachments();
  });
  wirePasteImages($('#n-desc'), async (files) => {
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
      maxBounces: parseMaxBouncesInput('#n-maxbounce', null),
      overrides: S.newOverrides || {},
      readOnly, skip,
      attachments: (S.newAttachments || []).map(({ name, type, size, dataB64 }) => ({ name, type, size, dataB64 })),
    }).then((r) => { S.newAttachments = []; S.newOverrides = {}; toast(r.started ? `CREATED — STARTED → ${r.started.toUpperCase()}` : 'TICKET CREATED'); closeAndReload(); }).catch(alertErr);
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
  const restoreDefault = defaultRestoreColumnId();
  const restoreOptions = (selected = restoreDefault) => cols().map((c) =>
    `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`
  ).join('');
  const rows = items.map((t) => {
    const current = cols().find((c) => c.id === t.columnId);
    return `
    <div class="arch-item" data-open="${t.id}">
      <div class="arch-main">
        <div class="arch-title">${esc(ticketNo(t))} · ${esc(t.title)}</div>
        <div class="arch-meta">
          <span>${esc(t.workspace.split('/').pop())}</span>
          <span>FROM ${esc(current?.name || '?')}</span>
          ${t.archivedAt ? `<span>ARCHIVED ${esc(t.archivedAt.replace('T', ' ').slice(0, 16))}</span>` : ''}
        </div>
      </div>
      <div class="arch-actions">
        <select class="arch-dest" data-restore-dest="${esc(t.id)}" aria-label="Restore destination for ${esc(t.title)}">${restoreOptions()}</select>
        <button class="btn arch-restore" data-restore="${esc(t.id)}">[ RESTORE ]</button>
        <button class="btn btn-danger arch-delete" data-archive-delete="${esc(t.id)}">[ DELETE ]</button>
      </div>
    </div>`;
  }).join('');
  shell(
    `ARCHIVE <span style="color:var(--fg-faint);font-size:10px">${String(items.length).padStart(2, '0')} TICKETS</span>`,
    `<div class="panel-body">${items.length
      ? `<div class="arch-list">${rows}</div>`
      : '<div class="arch-empty">ARCHIVE EMPTY — archive a ticket and it lands here</div>'}</div>`
  );
  for (const el of document.querySelectorAll('[data-open]')) {
    el.onclick = () => pushModal({ type: 'ticket', id: el.dataset.open, tab: 'overview' });
  }
  for (const el of document.querySelectorAll('[data-restore]')) {
    el.onclick = (e) => {
      stopTicketAction(e);
      const dest = el.closest('.arch-item')?.querySelector('[data-restore-dest]')?.value || restoreDefault;
      restoreTicket(el.dataset.restore, dest);
    };
  }
  for (const el of document.querySelectorAll('[data-restore-dest]')) {
    el.onclick = stopTicketAction;
  }
  for (const el of document.querySelectorAll('[data-archive-delete]')) {
    el.onclick = (e) => {
      stopTicketAction(e);
      deleteTicket(el.dataset.archiveDelete, { archived: true });
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
      <div><span class="secret-source ${entry.inFile ? (entry.inRuntime ? 'src-both' : 'src-file') : 'src-runtime'}">${esc(secretSource(entry))}</span></div>
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
    <div class="hint" id="s-secret-msg"></div>
    <div class="hint"><code>${esc(data.path || '.env')}</code> · each row's [ SAVE ] writes straight to this file · runtime-only keys have no <code>.env</code> line to delete yet.</div>
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

  // Add-row key validation: block ADD until the key is a valid env name; warn on overwrite.
  const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const keyInput = $('#s-secret-key');
  const addBtn = $('#s-secret-add');
  const msg = $('#s-secret-msg');
  const existingKeys = new Set([...document.querySelectorAll('.secret-key')].map((el) => el.textContent));
  const validateKey = () => {
    const k = keyInput.value.trim();
    if (!k) { addBtn.disabled = true; msg.textContent = ''; msg.className = 'hint'; return; }
    if (!KEY_RE.test(k)) {
      addBtn.disabled = true;
      msg.textContent = 'KEY MUST BE LETTERS, DIGITS OR _ AND NOT START WITH A DIGIT';
      msg.className = 'hint bad';
      return;
    }
    addBtn.disabled = false;
    if (existingKeys.has(k)) { msg.textContent = `${k} ALREADY EXISTS — SAVING WILL OVERWRITE IT`; msg.className = 'hint warn'; }
    else { msg.textContent = ''; msg.className = 'hint'; }
  };
  keyInput.addEventListener('input', validateKey);
  validateKey();

  addBtn.onclick = async () => {
    const key = keyInput.value.trim();
    const value = newValue.value;
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
  // Mark a row's [ SAVE ] as unsaved once its value diverges from what's on disk.
  // The panel re-renders after every save, so defaultValue re-syncs and the flag clears.
  for (const input of document.querySelectorAll('.secret-value')) {
    input.addEventListener('input', () => {
      const saveBtn = input.closest('div').nextElementSibling?.nextElementSibling?.querySelector('[data-secret-save]');
      if (saveBtn) saveBtn.classList.toggle('dirty', input.value !== input.defaultValue);
    });
  }
}

// True when the secrets panel has value edits that were never saved to .env.
function unsavedSecretCount() {
  if (S.modal?.type !== 'settings') return 0;
  let n = 0;
  for (const input of document.querySelectorAll('.secret-value')) if (input.value !== input.defaultValue) n++;
  return n;
}

// Guarded close: warn before discarding unsaved secret edits (each row saves on its own).
function requestCloseModal() {
  const n = unsavedSecretCount();
  if (n && !confirm(`${n} secret ${n > 1 ? 'values have' : 'value has'} unsaved edits. Close without saving? Use each row's [ SAVE ] to keep changes.`)) return;
  closeModal();
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
const SETTINGS_TABS = ['engine', 'providers', 'environment', 'system', 'notify', 'appearance'];

function renderSettingsModal() {
  const s = S.data.board.settings;
  const agentCols = cols().filter((c) => c.role === 'agent');
  const p = S.prefs;
  const tab = SETTINGS_TABS.includes(S.modal.tab) ? S.modal.tab : 'engine';
  // Every pane stays in the DOM; tabs only toggle visibility. [ SAVE SETTINGS ] reads
  // inputs across all panes and the unsaved-secrets guard scans them, so hiding (not
  // re-rendering) keeps both working and preserves unsaved edits across tab switches.
  const pane = (id, html) => `<div class="s-pane ${id === tab ? 'active' : ''}" data-pane="${id}">${html}</div>`;
  shell('SETTINGS', `
    <div class="tabs">${SETTINGS_TABS.map((id) => `<button data-tab="${id}" class="${id === tab ? 'active' : ''}">${id}</button>`).join('')}</div>
    <div class="panel-body">
      ${pane('engine', `
      <div class="section-head">ENGINE</div>
      <label class="f">MAX CONCURRENT RUNS <output>${(s.maxConcurrent ?? 2) <= 0 ? 'paused' : ''}</output></label><input id="s-cap" type="number" min="0" max="8" value="${s.maxConcurrent ?? 2}">
      <div class="hint" style="margin-top:4px">0 = pause the engine (nothing new runs; queued work waits until you raise it).</div>
      <label class="f">RUN TIMEOUT (MINUTES)</label><input id="s-to" type="number" min="1" value="${s.runTimeoutMin}">
      <label class="f">REVIEW / BOUNCE LIMIT (times a ticket can be sent back before it pauses for you)</label>
      <input id="s-maxbounce" type="number" min="0" value="${s.maxBounces ?? 3}">
      <div class="hint" style="margin-top:4px">0 = pause on the first bounce. Per-ticket overrides live on each ticket.</div>
      <label class="f">DEFAULT WORKSPACE</label>${workspacePicker('s-ws', s.defaultWorkspace)}
      <label class="f">STALL WATCHDOG (MINUTES — resume orphaned tickets after this dwell; 0 = off)</label>
      <input id="s-stall" type="number" min="0" value="${s.stallAfterMin ?? 10}">
      <label class="f">AUTO-DISPATCH BACKLOG</label>
      <select id="s-auto"><option value="">off</option><option value="1" ${s.autoDispatch !== false ? 'selected' : ''}>on</option></select>
      <label class="f">SWEEP INTERVAL (MINUTES)</label><input id="s-every" type="number" min="1" value="${s.autoDispatchEveryMin || 5}">

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
      <div class="section-head">ARCHIVE</div>
      <div class="disk-row">
        <span>ARCHIVED TICKETS: <b>${S.data.tickets.filter((t) => t.archived).length}</b></span>
        <button class="btn" id="s-open-archive">[ OPEN ARCHIVE ]</button>
      </div>`)}

      ${pane('providers', `
      <div id="s-stepper">${setupStepperHTML(s)}</div>

      <hr class="sep">
      <div class="section-head">PHASE DEFAULTS <span>(harness, model &amp; effort per column)</span></div>
      <div class="overrides-wrap"><div class="overrides-grid" style="grid-template-columns:110px 110px 1fr 1fr">
        <div class="h">PHASE</div><div class="h">HARNESS</div><div class="h">MODEL</div><div class="h">EFFORT</div>
        ${agentCols.map((c) => `
          <div>${esc(c.name)}</div>
          <div><select data-pd="${c.id}:type">${providerTypeOptions(c.harness.type, { includeHuman: true, disabledOk: false, showWarnings: true })}</select></div>
          <div class="model-cell"><select data-pd="${c.id}:model" ${c.harness.type === 'human' ? 'disabled' : ''}>${harnessOptions('model', c.harness.type, c.harness.model || '', '—')}</select>${refreshBtn()}</div>
          <div><select data-pd="${c.id}:effort" ${c.harness.type === 'human' ? 'disabled' : ''}>${harnessOptions('effort', c.harness.type, c.harness.effort || '', '— (CLI default)', c.harness.model)}</select></div>`).join('')}
      </div></div>
      <div class="hint">any phase can run any provider — presets in step 3 are just shortcuts. Permissions, network &amp; tools live in each column's CFG panel.</div>
      <div class="hint" id="s-models-meta">${['claude', 'codex'].map((ty) => {
        const m = S.data.registry[ty]?.meta || {};
        const age = m.fetchedAt ? fmtDur(Date.now() - Date.parse(m.fetchedAt)) + ' ago' : 'never';
        return `${ty}: ${esc(m.source || 'seed')} · ${age}`;
      }).join(' &nbsp;///&nbsp; ')} — models auto-refresh daily; ↻ forces it now.</div>
      <div class="hint" style="margin-top:14px">claude auth is detected via <code>claude auth status</code> · codex via <code>codex login status</code> — re-probe from step 2 above if state looks stale.</div>`)}

      ${pane('environment', `
      <div class="section-head">ENVIRONMENT VARIABLES <span>(repo .env + runtime)</span></div>
      <div id="s-secrets-panel" class="secrets-panel"></div>`)}

      ${pane('system', `
      <div class="section-head">SYSTEM PROMPT <span>(root SYSTEM.md)</span></div>
      <div class="hint" id="s-system-meta">loading system prompt…</div>
      <textarea id="s-system-prompt" class="system-prompt" spellcheck="false"></textarea>
      <div class="disk-row"><span></span><button class="btn" id="s-system-save">[ SAVE SYSTEM.md ]</button></div>`)}

      ${pane('notify', `
      <div class="section-head">NOTIFICATIONS <span>(telegram)</span></div>
      <label class="f">TELEGRAM ALERTS</label>
      <select id="s-tg-on"><option value="">off</option><option value="1" ${s.telegram?.enabled ? 'selected' : ''}>on</option></select>
      <label class="f">CHAT ID</label>
      <input id="s-tg-chat" value="${esc(s.telegram?.chatId || '')}" placeholder="e.g. 123456789">
      <div class="hint">no bot yet? message <code>@BotFather</code> → <code>/newbot</code> for a token, then <code>@userinfobot</code> for your numeric chat ID. full walkthrough in the README's "Notifications (Telegram)" section.</div>
      <label class="f">PING ON</label>
      <label class="check-row inline"><input type="checkbox" id="s-tg-done" ${s.telegram?.events?.completed !== false ? 'checked' : ''}> <span>ticket completed</span></label>
      <label class="check-row inline"><input type="checkbox" id="s-tg-stuck" ${s.telegram?.events?.intervention !== false ? 'checked' : ''}> <span>needs my intervention</span></label>
      <div class="disk-row"><span></span><button class="btn" id="s-tg-test">[ SEND TEST ]</button></div>
      <div class="hint">bot token comes from the <code>TELEGRAM_BOT_TOKEN</code> env var (kept out of the data dir). set it in the service unit / dispatch.env. reuses your existing Claude-hook bot.</div>`)}

      ${pane('appearance', `
      <div class="section-head">APPEARANCE <span>(this device only)</span></div>
      <label class="f">FONT SIZE <output id="s-font-val">${p.fontPx}px</output></label>
      <input id="s-font" type="range" min="12" max="32" step="1" value="${p.fontPx}">
      <label class="f">UI SIZE <output id="s-ui-val">${Math.round(p.uiScale * 100)}%</output></label>
      <input id="s-ui" type="range" min="0.7" max="1.6" step="0.05" value="${p.uiScale}">
      <button class="btn" id="s-appear-reset" style="margin-top:8px">[ RESET APPEARANCE ]</button>`)}
    </div>`,
    `<button class="btn btn-accent" id="s-save">[ SAVE SETTINGS ]</button>`);

  // Tab switching toggles visibility only — no re-render, so in-progress edits survive.
  for (const b of document.querySelectorAll('.tabs [data-tab]')) {
    b.onclick = () => {
      S.modal.tab = b.dataset.tab;
      for (const x of document.querySelectorAll('.tabs [data-tab]')) x.classList.toggle('active', x === b);
      for (const el of document.querySelectorAll('.s-pane')) el.classList.toggle('active', el.dataset.pane === S.modal.tab);
      writeModalHash(S.modal, { push: false });
    };
  }

  const fmtBytes = (n) => n == null ? '?' : n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} KB`;
  wireWorkspacePicker('s-ws');
  loadSecretsSettings();
  loadSystemPromptSettings();
  api('/api/maintenance/usage').then((u) => { const el = $('#s-usage'); if (el) el.textContent = fmtBytes(u.bytes); }).catch(() => {});
  $('#s-open-archive').onclick = () => pushModal({ type: 'archive' });
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

  // Setup controls (enable toggles, auth flow, preset, completion) all live inside the
  // stepper, which re-renders on auth changes — wiring is shared with updateStepperUI().
  wireStepperHandlers();

  // Effective (possibly unsaved) harness type for a phase row — the type select wins
  // over the column's saved harness so model/effort refills track what's on screen.
  const rowType = (colId) => document.querySelector(`[data-pd="${colId}:type"]`)?.value
    || cols().find((c) => c.id === colId)?.harness.type || 'claude';

  // Switching a phase's harness re-fills model + effort with THAT provider's registry
  // (reset to CLI default — the old values belong to the other provider). HUMAN takes
  // neither, so both selects grey out.
  for (const sel of document.querySelectorAll('[data-pd$=":type"]')) sel.onchange = () => {
    const colId = sel.dataset.pd.split(':')[0];
    const type = sel.value;
    const model = document.querySelector(`[data-pd="${colId}:model"]`);
    const eff = document.querySelector(`[data-pd="${colId}:effort"]`);
    const human = type === 'human';
    if (model) {
      model.innerHTML = human ? '<option value="">—</option>' : harnessOptions('model', type, '', '—');
      model.disabled = human;
    }
    if (eff) {
      eff.innerHTML = human ? '<option value="">—</option>' : harnessOptions('effort', type, '', '— (CLI default)', '');
      eff.disabled = human;
    }
  };

  for (const sel of document.querySelectorAll('[data-pd$=":model"]')) sel.onchange = () => {
    if (!handleCustomModel(sel)) return;
    // refill the sibling effort select with the chosen model's supported levels
    const colId = sel.dataset.pd.split(':')[0];
    const eff = document.querySelector(`[data-pd="${colId}:effort"]`);
    if (eff) eff.innerHTML = harnessOptions('effort', rowType(colId), eff.value, '— (CLI default)', sel.value);
  };

  // Appearance — device-local, applies live and persists immediately (no server round-trip).
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
        const d = phaseDefaults[c.id] || {};
        const typeChanged = d.type && d.type !== c.harness.type;
        if (!typeChanged && !d.model && !d.effort) return null;
        const harness = { ...c.harness };
        if (typeChanged) {
          // Provider swap: take model/effort from the refilled selects verbatim — empty
          // means CLI default; the previous values belonged to the other provider.
          harness.type = d.type;
          harness.model = d.model || '';
          harness.effort = d.effort || '';
        } else {
          if (d.model) harness.model = d.model;
          if (d.effort) harness.effort = d.effort;
        }
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
        maxBounces: parseMaxBouncesInput('#s-maxbounce', s.maxBounces ?? 3),
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
      btn.textContent = '[ SAVE SETTINGS ]';
    }
  };
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
  for (const el of document.querySelectorAll('[data-tplus]')) {
    const ms = Math.max(0, now - Number(el.dataset.tplus));
    const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
    el.textContent = `T+${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  for (const el of document.querySelectorAll('[data-active-base]')) {
    const base = Number(el.dataset.activeBase) || 0;
    const since = Number(el.dataset.activeSince) || 0;
    el.textContent = fmtDur(base + (since ? now - since : 0));
  }
}, 1000);

/* ---------- boot ---------- */
$('#btn-new').onclick = () => { S.newAttachments = []; S.newOverrides = {}; pushModal({ type: 'new' }); };
$('#btn-settings').onclick = () => pushModal({ type: 'settings' });
$('#btn-archive').onclick = () => pushModal({ type: 'archive' });
$('#btn-pause').onclick = () => {
  const cap = S.data.board.settings.maxConcurrent ?? 2;
  let next;
  if (cap > 0) { localStorage.setItem('dispatch.prevCap', String(cap)); next = 0; }   // pause
  else { next = Number(localStorage.getItem('dispatch.prevCap')) || 2; }               // resume
  api('/api/settings', 'PATCH', { maxConcurrent: next })
    .then(() => toast(next === 0 ? 'ENGINE PAUSED — nothing new will run' : `ENGINE RESUMED — cap ${next}`))
    .catch(alertErr);
};
/* ---- mobile overflow menu (≡): folds Pause / Archive / Settings off the top bar ---- */
function buildTopMenu() {
  const cap = S.data?.board?.settings?.maxConcurrent ?? 2;
  const paused = cap <= 0;
  const archived = S.data?.tickets?.filter((t) => t.archived).length || 0;
  return [
    { id: 'btn-pause', label: paused ? '▶ RESUME ENGINE' : '⏸ PAUSE ENGINE', danger: paused },
    { id: 'btn-archive', label: archived ? `ARCHIVE · ${String(archived).padStart(2, '0')}` : 'ARCHIVE' },
    { id: 'btn-settings', label: 'SETTINGS' },
  ].map((it) => `<button class="topmenu-item${it.danger ? ' danger' : ''}" data-act="${it.id}">${it.label}</button>`).join('');
}
function closeTopMenu() {
  const m = $('#topmenu');
  if (!m || m.hidden) return;
  m.hidden = true;
  $('#btn-menu')?.setAttribute('aria-expanded', 'false');
}
function toggleTopMenu() {
  const m = $('#topmenu');
  if (!m) return;
  if (!m.hidden) { closeTopMenu(); return; }
  m.innerHTML = buildTopMenu();
  const bar = $('#topbar')?.getBoundingClientRect();
  if (bar) { m.style.top = `${bar.bottom}px`; m.style.right = `${Math.max(8, window.innerWidth - bar.right + 8)}px`; }
  m.hidden = false;
  $('#btn-menu')?.setAttribute('aria-expanded', 'true');
  // items just re-trigger the real (hidden) top-bar buttons so wiring stays in one place
  for (const b of m.querySelectorAll('[data-act]')) {
    b.onclick = () => { closeTopMenu(); $(`#${b.dataset.act}`)?.click(); };
  }
}
$('#btn-menu').onclick = (e) => { e.stopPropagation(); toggleTopMenu(); };

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeTopMenu(); requestCloseModal(); } });
document.addEventListener('click', (e) => {
  if (e.target.closest('.refresh-models')) { e.preventDefault(); refreshModelRegistry(); }
  if (!e.target.closest('#topmenu') && !e.target.closest('#btn-menu')) closeTopMenu();
});

savePrefs(loadPrefs()); // apply saved font size / UI scale before first paint
loadState()
  .then(() => { initHistoryFromLocation(); connectWS(); }) // needs S.data loaded first, to validate a deep-linked ticket/column id
  .catch((e) => { document.body.innerHTML = `<pre style="color:#ff2a2a;padding:20px">DISPATCH FAILED TO LOAD: ${esc(e.message)}</pre>`; });
