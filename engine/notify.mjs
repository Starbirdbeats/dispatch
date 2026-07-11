// Telegram notifications for ticket lifecycle edges. Dependency-free: Node provides fetch.

function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function telegramConfig(settings = {}) {
  const t = settings.telegram || {};
  const token = process.env.TELEGRAM_BOT_TOKEN || t.token || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || t.chatId || '';
  const events = { completed: true, intervention: true, ...(t.events || {}) };
  const enabled = t.enabled === true && Boolean(token && chatId);
  const baseUrl = process.env.DISPATCH_PUBLIC_URL || `http://localhost:${process.env.DISPATCH_PORT || 4400}`;
  return { token, chatId, enabled, events, baseUrl };
}

export async function sendTelegram({ token, chatId }, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`telegram ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json().catch(() => ({}));
}

// Distinct chats seen in a getUpdates result. Private DMs need a numeric chat id, and the
// Bot API only reveals it after the human has messaged the bot — this is how we find it.
export function chatsFromUpdates(updates = []) {
  const chats = new Map();
  for (const u of updates) {
    const c = u?.message?.chat || u?.edited_message?.chat || u?.channel_post?.chat
      || u?.my_chat_member?.chat || u?.callback_query?.message?.chat;
    if (!c || c.id == null || chats.has(c.id)) continue; // keep the first, fullest sighting
    chats.set(c.id, {
      id: c.id,
      type: c.type || '?',
      username: c.username || null,
      name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.title || null,
    });
  }
  return [...chats.values()];
}

async function tgGet(token, method) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(`telegram ${res.status}: ${body.description || 'request failed'}`);
  }
  return body.result;
}

// Discover who the bot can talk to: bot identity, whether a webhook is eating updates,
// and every distinct chat in the recent update backlog (empty until the human messages
// the bot, and Telegram drops updates after ~24h — both surfaced to the UI as guidance).
export async function detectChats(token) {
  const me = await tgGet(token, 'getMe');
  const webhook = await tgGet(token, 'getWebhookInfo').catch(() => ({}));
  const updates = await tgGet(token, 'getUpdates?limit=100').catch(() => []);
  return {
    bot: { username: me?.username || null, name: me?.first_name || null },
    webhookUrl: webhook?.url || null,
    chats: chatsFromUpdates(updates),
  };
}

export function renderMessage(event, ticket, column, baseUrl) {
  const link = `${baseUrl}/#${ticket.id}`;
  if (event === 'completed') {
    const took = ticket.durationMs ? ` · took ${fmtDur(ticket.durationMs)}` : '';
    return `✅ DONE — ${ticket.title}\nlanded in ${column?.name || '?'}${took}\n${link}`;
  }

  const reason = ticket.stuckReason?.detail || ticket.status || 'needs attention';
  return `⚠️ NEEDS YOU — ${ticket.title}\n${column?.name || '?'} · ${ticket.status || '?'}\n${String(reason).slice(0, 400)}\n${link}`;
}
