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
const ticketsIn = (colId) => S.data.tickets.filter((t) => t.columnId === colId && !t.archived)
  .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
const archivedTickets = () => S.data.tickets.filter((t) => t.archived)
  .sort((a, b) => ((a.archivedAt || '') < (b.archivedAt || '') ? 1 : -1)); // newest first
const harnessLabel = (h) => h.type === 'human' ? 'HUMAN' : `${h.type} · ${h.model || 'default'} · ${h.effort || 'default'}`;
const effective = (t, c) => ({ ...c.harness, ...(t.overrides?.[c.id] || {}) });

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
  const archived = S.data.tickets.filter((t) => t.archived).length;
  $('#btn-archive').textContent = archived ? `[ ARCHIVE ${String(archived).padStart(2, '0')} ]` : '[ ARCHIVE ]';
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
    <div class="t"><span class="led ${status}"></span><span class="title">${esc(t.title)}</span>${c.role === 'terminal' ? `<button class="arch" title="Archive ticket">[ ARCH ]</button>` : ''}</div>
    <div class="meta"><span>${esc(t.workspace.split('/').pop())}</span><span>${t.scheduledAt ? `SCHED ${esc(t.scheduledAt.replace('T', ' '))} · ` : ''}${esc(status)}</span></div>
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
  if (S.modal.type === 'archive') renderArchiveModal();
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
    <label class="f">ATTACHMENTS (referenced in the dossier for the agents — max ${MAX_ATTACH_MB}MB each)</label>
    ${dropzoneHTML('ov-att-drop', 'ov-att-input', 'ov-att-browse')}
    <div class="att-list" id="ov-att-list"></div>
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
      <label class="f">ATTACHMENTS (listed in the dossier for the agents to read — max ${MAX_ATTACH_MB}MB each)</label>
      ${dropzoneHTML('n-att-drop', 'n-att-input', 'n-att-browse')}
      <div class="att-list" id="n-att-list"></div>
      <div class="hint">unscheduled backlog tickets auto-start every ${S.data.board.settings.autoDispatchEveryMin || 5} min. a scheduled ticket waits for its timestamp.</div>
    </div>`,
    `<button class="btn btn-accent" id="n-create">[ CREATE ]</button>`);
  wireDropzone('n-att-drop', 'n-att-input', 'n-att-browse', async (files) => {
    S.newAttachments = (S.newAttachments || []).concat(await readUploads(files));
    renderStagedAttachments();
  });
  renderStagedAttachments();
  $('#n-create').onclick = () => api('/api/tickets', 'POST', {
    title: $('#n-title').value,
    description: $('#n-desc').value,
    workspace: $('#n-ws').value.trim(),
    columnId: $('#n-col').value,
    scheduledAt: $('#n-sched').value || null,
    attachments: (S.newAttachments || []).map(({ name, type, size, dataB64 }) => ({ name, type, size, dataB64 })),
  }).then(() => { S.newAttachments = []; toast('TICKET CREATED'); closeAndReload(); }).catch(alertErr);
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

/* ---- settings modal ---- */
function renderSettingsModal() {
  const s = S.data.board.settings;
  const agentCols = cols().filter((c) => c.role === 'agent');
  shell('SETTINGS', `
    <div class="panel-body">
      <label class="f">MAX CONCURRENT RUNS</label><input id="s-cap" type="number" min="1" max="8" value="${s.maxConcurrent}">
      <label class="f">RUN TIMEOUT (MINUTES)</label><input id="s-to" type="number" min="1" value="${s.runTimeoutMin}">
      <label class="f">DEFAULT WORKSPACE</label><input id="s-ws" value="${esc(s.defaultWorkspace)}">
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
          <div><select data-pd="${c.id}:model">${harnessOptions('model', c.harness.type, c.harness.model || '', '—')}</select></div>
          <div><select data-pd="${c.id}:effort">${harnessOptions('effort', c.harness.type, c.harness.effort || '', '— (CLI default)')}</select></div>`).join('')}
      </div></div>
      <div class="hint">changing a harness TYPE (claude ⇄ codex) still needs that column's own CFG panel — this list only sets model/effort defaults.</div>

      <div class="hint" style="margin-top:14px">claude auth: subscription oauth on starbird · codex auth: chatgpt login · <button class="btn" id="s-probe" style="padding:2px 6px">[ re-probe CLIs ]</button></div>
    </div>`,
    `<button class="btn btn-accent" id="s-save">[ SAVE ]</button>`);

  for (const sel of document.querySelectorAll('[data-pd$=":model"]')) sel.onchange = () => handleCustomModel(sel);

  $('#s-save').onclick = async () => {
    const phaseDefaults = {};
    for (const el of document.querySelectorAll('[data-pd]')) {
      const [colId, key] = el.dataset.pd.split(':');
      (phaseDefaults[colId] ||= {})[key] = el.value.trim();
    }
    await Promise.all(agentCols.map((c) => {
      const d = phaseDefaults[c.id];
      if (!d || (!d.model && !d.effort)) return null;
      const harness = { ...c.harness };
      if (d.model) harness.model = d.model;
      if (d.effort) harness.effort = d.effort;
      return api(`/api/columns/${c.id}`, 'PATCH', { harness });
    }).filter(Boolean));
    await api('/api/settings', 'PATCH', {
      maxConcurrent: Number($('#s-cap').value) || 2,
      runTimeoutMin: Number($('#s-to').value) || 30,
      defaultWorkspace: $('#s-ws').value.trim(),
      autoDispatch: Boolean($('#s-auto').value),
      autoDispatchEveryMin: Number($('#s-every').value) || 5,
      stallAfterMin: Number($('#s-stall').value),
    }).then(() => { toast('SETTINGS SAVED'); closeAndReload(); }).catch(alertErr);
  };
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
$('#btn-new').onclick = () => { S.newAttachments = []; S.modal = { type: 'new' }; renderModal(); };
$('#btn-settings').onclick = () => { S.modal = { type: 'settings' }; renderModal(); };
$('#btn-archive').onclick = () => { S.modal = { type: 'archive' }; renderModal(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

loadState().then(connectWS).catch((e) => { document.body.innerHTML = `<pre style="color:#ff2a2a;padding:20px">DISPATCH FAILED TO LOAD: ${esc(e.message)}</pre>`; });
