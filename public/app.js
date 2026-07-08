/* DISPATCH frontend — vanilla JS, no build step. */
'use strict';

const S = {
  data: null,          // /api/state payload
  modal: null,         // {type:'ticket'|'column'|'new'|'settings', id?, tab?}
  live: {},            // ticketId -> normalized run events (session-local)
  commentDraft: '',
};

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
    if (msg.type === 'run-event') {
      (S.live[msg.ticketId] ||= []).push(msg.event);
      if (S.live[msg.ticketId].length > 800) S.live[msg.ticketId].shift();
      if (S.modal?.type === 'ticket' && S.modal.id === msg.ticketId && S.modal.tab === 'transcript') {
        appendTranscriptLine(msg.event);
      }
    }
  };
  ws.onclose = () => setTimeout(connectWS, 2000);
}

/* ---------- helpers ---------- */
const cols = () => [...S.data.board.columns].sort((a, b) => a.order - b.order);
const ticketsIn = (colId) => S.data.tickets.filter((t) => t.columnId === colId)
  .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
const harnessLabel = (h) => h.type === 'human' ? 'HUMAN' : `${h.type} · ${h.model || 'default'} · ${h.effort || 'default'}`;
const effective = (t, c) => ({ ...c.harness, ...(t.overrides?.[c.id] || {}) });

/* ---------- render ---------- */
function render() {
  renderTopbar();
  renderBoard();
  if (S.modal?.type === 'ticket') {
    // Live-refresh only the non-form tabs; overview holds user edits.
    if (['activity', 'dossier'].includes(S.modal.tab)) renderModal();
    else updateTicketModalHead();
  }
}

function renderTopbar() {
  const h = S.data.health;
  $('#health').innerHTML =
    `<span class="${h.claude?.ok ? 'ok' : 'bad'}">CLAUDE ${h.claude?.ok ? (h.claude.version || 'OK') : 'OFFLINE'}</span>` +
    ` &nbsp;///&nbsp; <span class="${h.codex?.ok ? 'ok' : 'bad'}">CODEX ${h.codex?.ok ? (h.codex.version || 'OK') : 'OFFLINE'}</span>`;
  const r = S.data.runs;
  $('#queueinfo').innerHTML = `RUNNING <b>${r.running.length}</b> / QUEUED <b>${r.queued.length}</b> / CAP <b>${S.data.board.settings.maxConcurrent}</b>`;
}

function renderBoard() {
  const board = $('#board');
  board.innerHTML = '';
  for (const c of cols()) {
    const col = document.createElement('section');
    col.className = 'column';
    col.dataset.colId = c.id;
    const tickets = ticketsIn(c.id);
    col.innerHTML = `
      <div class="col-head">
        <div class="col-title"><h2>${esc(c.name)}</h2><span class="count">${String(tickets.length).padStart(2, '0')}</span></div>
        <div class="col-harness">
          <span>[ ${esc(harnessLabel(c.harness))} ]${c.autoRun ? ' <span class="auto">AUTO</span>' : ''}</span>
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
}

function cardEl(t, c) {
  const el = document.createElement('article');
  const running = S.data.runs.running.includes(t.id);
  const status = running ? 'running' : (S.data.runs.queued.includes(t.id) ? 'queued' : (c.role === 'terminal' ? 'done' : t.status));
  el.className = `card status-${status}`;
  el.draggable = true;
  const last = [...t.activity].reverse().find((a) => a.kind !== 'run');
  el.innerHTML = `
    <div class="t"><span class="led ${status}"></span><span class="title">${esc(t.title)}</span></div>
    <div class="meta"><span>${esc(t.workspace.split('/').pop())}</span><span>${t.scheduledAt ? `SCHED ${esc(t.scheduledAt.replace('T', ' '))} · ` : ''}${esc(status)}</span></div>
    ${last ? `<div class="last">&gt; ${esc(last.text)}</div>` : ''}`;
  el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/ticket', t.id); el.classList.add('dragging'); });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.onclick = () => { S.modal = { type: 'ticket', id: t.id, tab: 'overview' }; renderModal(); };
  return el;
}

/* ---------- modals ---------- */
function closeModal() { S.modal = null; $('#modal-root').innerHTML = ''; }

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
}

function updateTicketModalHead() {
  const t = S.data.tickets.find((x) => x.id === S.modal?.id);
  const h = $('#ticket-status');
  if (t && h) h.textContent = t.status.toUpperCase();
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

  const body = $('#tab-body');
  if (tab === 'overview') renderOverview(body, t);
  if (tab === 'activity') renderActivity(body, t);
  if (tab === 'transcript') renderTranscript(body, t);
  if (tab === 'dossier') fetch(`/api/tickets/${t.id}/dossier`).then((r) => r.text()).then((txt) => { body.innerHTML = `<div class="dossier">${esc(txt)}</div>`; });
}

function closeAndReload() { closeModal(); loadState(); }

// Build a <select> for model/effort/permissions scoped to a harness type, with the
// current value always present and a custom escape hatch for models.
function harnessOptions(kind, type, current, defaultLabel) {
  const reg = S.data.registry[type];
  let items = [];
  if (reg) {
    if (kind === 'model') items = reg.models.map((m) => ({ v: m.id, l: m.label }));
    if (kind === 'effort') items = reg.efforts.map((e) => ({ v: e, l: e }));
    if (kind === 'permissions') items = reg.permissions.map((p) => ({ v: p, l: p }));
  }
  if (current && !items.some((i) => i.v === current)) items.push({ v: current, l: `${current} (custom)` });
  const opts = [`<option value="">${esc(defaultLabel)}</option>`]
    .concat(items.map((i) => `<option value="${esc(i.v)}" ${i.v === current ? 'selected' : ''}>${esc(i.l)}</option>`));
  if (kind === 'model') opts.push(`<option value="__custom">custom…</option>`);
  return opts.join('');
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

function renderOverview(body, t) {
  if (S.ovDraft?.id !== t.id) S.ovDraft = { id: t.id, ov: structuredClone(t.overrides || {}) };
  const draft = S.ovDraft.ov;
  const agentCols = cols().filter((c) => c.role === 'agent');
  body.innerHTML = `
    <div class="kv">
      <div class="k">ID</div><div>${t.id}</div>
      <div class="k">WORKSPACE</div><div><input id="f-ws" value="${esc(t.workspace)}"></div>
      <div class="k">SCHEDULED</div><div><input id="f-sched" type="datetime-local" value="${esc(t.scheduledAt || '')}"></div>
      <div class="k">SESSIONS</div><div>claude: ${t.sessions.claude || '—'}<br>codex: ${t.sessions.codex || '—'}</div>
      <div class="k">HUMAN TEST</div><div>${t.humanTest ? esc(t.humanTest) : '<span class="warn">not provided yet</span>'}</div>
    </div>
    <label class="f">DESCRIPTION</label>
    <textarea id="f-desc">${esc(t.description)}</textarea>
    <label class="f">PER-COLUMN HARNESS OVERRIDES ("default" = column config)</label>
    <div class="overrides-wrap"><div class="overrides-grid">
      <div class="h">PHASE</div><div class="h">HARNESS</div><div class="h">MODEL</div><div class="h">EFFORT</div><div class="h">PERMS</div>
      ${agentCols.map((c) => {
        const o = draft[c.id] || {};
        const effType = o.type || c.harness.type;
        return `<div>${esc(c.name)}</div>
          <div><select data-ov="${c.id}:type">
            <option value="">default (${esc(c.harness.type)})</option>
            <option value="claude" ${o.type === 'claude' ? 'selected' : ''}>claude</option>
            <option value="codex" ${o.type === 'codex' ? 'selected' : ''}>codex</option>
          </select></div>
          <div><select data-ov="${c.id}:model">${harnessOptions('model', effType, o.model || '', `default (${c.harness.model || '—'})`)}</select></div>
          <div><select data-ov="${c.id}:effort">${harnessOptions('effort', effType, o.effort || '', `default (${c.harness.effort || '—'})`)}</select></div>
          <div><select data-ov="${c.id}:permissions">${harnessOptions('permissions', effType, o.permissions || '', `default (${c.harness.permissions || '—'})`)}</select></div>`;
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
      // switching harness type changes which models/efforts/perms apply
      if (key === 'type') renderOverview(body, t);
    };
  }

  $('#btn-save-ticket').onclick = async () => {
    await api(`/api/tickets/${t.id}`, 'PATCH', {
      workspace: $('#f-ws').value.trim(),
      description: $('#f-desc').value,
      scheduledAt: $('#f-sched').value || null,
      overrides: draft,
    }).then(() => toast('TICKET SAVED')).catch(alertErr);
  };
}

function renderActivity(body, t) {
  body.innerHTML = `
    <div class="activity">${[...t.activity].reverse().map((a) => `
      <div class="item kind-${a.kind}">
        <div class="who"><span class="by-${a.by}">${esc(a.by)} / ${esc(a.kind)}</span><span>${esc(a.ts.replace('T', ' ').slice(0, 19))}</span></div>
        <div class="txt">${esc(a.text)}</div>
      </div>`).join('') || '<div class="item"><div class="txt">no activity yet</div></div>'}
    </div>
    <div class="commentbox">
      <textarea id="f-comment" placeholder="comment — the next agent run will see this">${esc(S.commentDraft)}</textarea>
      <button class="btn" id="btn-comment">[ POST ]</button>
    </div>`;
  $('#f-comment').oninput = (e) => { S.commentDraft = e.target.value; };
  $('#btn-comment').onclick = async () => {
    const text = $('#f-comment').value.trim();
    if (!text) return;
    S.commentDraft = '';
    await api(`/api/tickets/${t.id}/comment`, 'POST', { text }).then((r) => toast(r.woke ? 'COMMENT POSTED — AGENT WAKING' : 'COMMENT POSTED')).catch(alertErr);
  };
}

function renderTranscript(body, t) {
  body.innerHTML = `<div class="transcript" id="transcript"></div><div class="hint" id="tr-hint"></div>`;
  fetch(`/api/tickets/${t.id}/transcript`).then((r) => r.json()).then(({ file, lines }) => {
    $('#tr-hint').textContent = file ? `FILE: ${file}` : 'NO RUNS YET';
    for (const raw of lines || []) {
      let obj; try { obj = JSON.parse(raw); } catch { continue; }
      if (obj.meta) appendTranscriptLine({ kind: 'system', text: `spawn: ${obj.meta.cmd} (${obj.meta.column})` });
      else if (obj.stderr) appendTranscriptLine({ kind: 'error', text: obj.stderr.trim() });
      else if (obj.ev) appendTranscriptLine(obj.ev);
    }
    for (const ev of S.live[t.id] || []) appendTranscriptLine(ev);
  });
}

function appendTranscriptLine(ev) {
  const box = $('#transcript');
  if (!box || !ev?.text) return;
  const div = document.createElement('div');
  div.className = `ln k-${ev.kind || 'text'}`;
  div.innerHTML = `<span class="tag">${esc(ev.kind || 'text')}</span>${esc(ev.text)}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

/* ---- column config modal ---- */
function renderColumnModal(draftOverride) {
  const c = S.data.board.columns.find((x) => x.id === S.modal.id);
  if (!c) return closeModal();
  const h = draftOverride || c.harness;
  const type = h.type || 'human';
  shell(`PHASE CONFIG /// ${esc(c.name)}`, `
    <div class="panel-body">
      <label class="f">NAME</label><input id="c-name" value="${esc(draftOverride?._name ?? c.name)}">
      <label class="f">ROLE</label>
      <select id="c-role">${['intake', 'agent', 'human-gate', 'terminal'].map((r) => `<option ${r === (draftOverride?._role ?? c.role) ? 'selected' : ''}>${r}</option>`).join('')}</select>
      <label class="f">HARNESS</label>
      <select id="c-type">${['human', 'claude', 'codex'].map((r) => `<option ${r === type ? 'selected' : ''}>${r}</option>`).join('')}</select>
      <label class="f">MODEL</label>
      <select id="c-model" ${type === 'human' ? 'disabled' : ''}>${harnessOptions('model', type, h.model || '', '—')}</select>
      <label class="f">EFFORT</label>
      <select id="c-effort" ${type === 'human' ? 'disabled' : ''}>${harnessOptions('effort', type, h.effort || '', '— (CLI default)')}</select>
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
    d.model = ''; d.effort = ''; d.permissions = '';
    renderColumnModal(d);
  };
  $('#c-model').onchange = () => handleCustomModel($('#c-model'));

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
      <input id="n-ws" value="${esc(S.data.board.settings.defaultWorkspace)}">
      <label class="f">START IN</label>
      <select id="n-col">${cols().map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
      <label class="f">SCHEDULE FOR (optional — leave blank for the next backlog sweep)</label>
      <input id="n-sched" type="datetime-local">
      <div class="hint">unscheduled backlog tickets auto-start every ${S.data.board.settings.autoDispatchEveryMin || 5} min. a scheduled ticket waits for its timestamp.</div>
    </div>`,
    `<button class="btn btn-accent" id="n-create">[ CREATE ]</button>`);
  $('#n-create').onclick = () => api('/api/tickets', 'POST', {
    title: $('#n-title').value,
    description: $('#n-desc').value,
    workspace: $('#n-ws').value.trim(),
    columnId: $('#n-col').value,
    scheduledAt: $('#n-sched').value || null,
  }).then(() => { toast('TICKET CREATED'); closeAndReload(); }).catch(alertErr);
}

/* ---- settings modal ---- */
function renderSettingsModal() {
  const s = S.data.board.settings;
  shell('SETTINGS', `
    <div class="panel-body">
      <label class="f">MAX CONCURRENT RUNS</label><input id="s-cap" type="number" min="1" max="8" value="${s.maxConcurrent}">
      <label class="f">RUN TIMEOUT (MINUTES)</label><input id="s-to" type="number" min="1" value="${s.runTimeoutMin}">
      <label class="f">DEFAULT WORKSPACE</label><input id="s-ws" value="${esc(s.defaultWorkspace)}">
      <label class="f">AUTO-DISPATCH BACKLOG</label>
      <select id="s-auto"><option value="">off</option><option value="1" ${s.autoDispatch !== false ? 'selected' : ''}>on</option></select>
      <label class="f">SWEEP INTERVAL (MINUTES)</label><input id="s-every" type="number" min="1" value="${s.autoDispatchEveryMin || 5}">
      <div class="hint" style="margin-top:14px">claude auth: subscription oauth on starbird · codex auth: chatgpt login · <button class="btn" id="s-probe" style="padding:2px 6px">[ re-probe CLIs ]</button></div>
    </div>`,
    `<button class="btn btn-accent" id="s-save">[ SAVE ]</button>`);
  $('#s-save').onclick = () => api('/api/settings', 'PATCH', {
    maxConcurrent: Number($('#s-cap').value) || 2,
    runTimeoutMin: Number($('#s-to').value) || 30,
    defaultWorkspace: $('#s-ws').value.trim(),
    autoDispatch: Boolean($('#s-auto').value),
    autoDispatchEveryMin: Number($('#s-every').value) || 5,
  }).then(() => { toast('SETTINGS SAVED'); closeAndReload(); }).catch(alertErr);
  $('#s-probe').onclick = () => api('/api/probe', 'POST', {}).catch(alertErr);
}

/* ---------- sweep countdown (1s tick, no full re-render) ---------- */
setInterval(() => {
  const at = S.data?.scheduler?.nextSweepAt;
  const els = document.querySelectorAll('[data-sweep]');
  if (!at || !els.length) return;
  const ms = at - Date.now();
  let label;
  if (ms <= 0) label = 'DUE — next tick';
  else {
    const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
    label = `T-${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  for (const el of els) el.textContent = label;
}, 1000);

/* ---------- boot ---------- */
$('#btn-new').onclick = () => { S.modal = { type: 'new' }; renderModal(); };
$('#btn-settings').onclick = () => { S.modal = { type: 'settings' }; renderModal(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

loadState().then(connectWS).catch((e) => { document.body.innerHTML = `<pre style="color:#ff2a2a;padding:20px">DISPATCH FAILED TO LOAD: ${esc(e.message)}</pre>`; });
