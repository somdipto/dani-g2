// Telegram bridge for Dani on G2 (hackathon track 1).
//
// Reads new messages from chats you allow, turns each into a queue item with a drafted reply, and sends the
// reply only after you approve it on the glasses. Channel posts are grouped into one digest item per poll.
// Uses the Bot API over HTTPS (getUpdates long polling and sendMessage). No dependencies.
//
// A bot only sees messages sent to it, plus groups and channels it was added to. In a group, turn off privacy
// mode with BotFather (/setprivacy) if the bot should see every message, and add it as admin to read a channel.

const MAX_CONTEXT = 500; // characters of the incoming message kept on the item
const MAX_REPLY = 4096; // Telegram's limit for one message
const DIGEST_LINES = 5;

/** Strip control characters and collapse whitespace. Incoming text is untrusted. */
export function clean(text, max = MAX_CONTEXT) {
  const t = String(text ?? '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

const displayName = (u) => clean([u?.first_name, u?.last_name].filter(Boolean).join(' ') || (u?.username ? `@${u.username}` : 'Unknown'), 40);
const chatName = (c) => clean(c?.title || [c?.first_name, c?.last_name].filter(Boolean).join(' ') || (c?.username ? `@${c.username}` : String(c?.id)), 40);

/** Parses TELEGRAM_CHAT_IDS: comma separated numeric ids or @usernames. Empty list means nothing is read. */
export function parseChats(value) {
  return new Set(
    String(value ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowed(chat, allowed) {
  if (!chat) return false;
  if (allowed.has(String(chat.id))) return true;
  return !!chat.username && allowed.has(`@${String(chat.username).toLowerCase()}`);
}

/**
 * @param {{
 *   token: string,
 *   chats: Set<string>,
 *   enqueue: (item: object, meta?: object) => boolean,
 *   drafter: (msg: { text: string, from: string, chat: string }) => Promise<string>,
 *   api?: string,
 *   fetchImpl?: typeof fetch,
 *   log?: (m: string) => void,
 *   pollSeconds?: number,
 * }} opts
 */
export function createTelegramBridge(opts) {
  const { token, chats, enqueue, drafter, api = 'https://api.telegram.org', fetchImpl = fetch, log = () => {}, pollSeconds = 25 } = opts;
  if (!token) throw new Error('Telegram bot token is required');
  let offset = 0;
  let running = false;
  let abort;

  const redact = (s) => String(s).split(token).join('<token>');

  async function call(method, body, signal) {
    let res;
    try {
      res = await fetchImpl(`${api}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      throw new Error(redact(e instanceof Error ? e.message : e));
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) throw new Error(redact(j.description ?? `Telegram HTTP ${res.status}`));
    return j.result;
  }

  /** Fetches one batch of updates and queues items. Returns how many items were queued. */
  async function pollOnce(signal) {
    const updates = await call('getUpdates', { offset, timeout: signal ? pollSeconds : 0, allowed_updates: ['message', 'channel_post'] }, signal);
    let queued = 0;
    const posts = new Map(); // chat id -> { chat, lines, lastId }
    for (const u of updates) {
      offset = Math.max(offset, u.update_id + 1);
      const m = u.message ?? u.channel_post;
      if (!m || typeof m.text !== 'string' || !m.text.trim()) continue;
      if (!isAllowed(m.chat, chats)) {
        log(`ignored message from a chat that is not in TELEGRAM_CHAT_IDS (${m.chat?.id})`);
        continue;
      }
      if (m.from?.is_bot) continue;
      if (u.channel_post) {
        const g = posts.get(m.chat.id) ?? { chat: m.chat, lines: [], lastId: m.message_id };
        g.lines.push(clean(m.text, 120));
        g.lastId = m.message_id;
        posts.set(m.chat.id, g);
        continue;
      }
      const from = displayName(m.from);
      const text = clean(m.text);
      const draft = clean(await drafter({ text, from, chat: chatName(m.chat) }), MAX_REPLY);
      const ok = enqueue(
        { id: `tg-${m.chat.id}-${m.message_id}`, app: 'telegram', title: `Reply: ${chatName(m.chat)}`, from, context: text, draft },
        { kind: 'reply', chatId: m.chat.id, replyTo: m.message_id },
      );
      if (ok) queued++;
    }
    for (const g of posts.values()) {
      const shown = g.lines.slice(0, DIGEST_LINES).map((l) => `- ${l}`);
      if (g.lines.length > DIGEST_LINES) shown.push(`+${g.lines.length - DIGEST_LINES} more`);
      const ok = enqueue(
        {
          id: `tg-digest-${g.chat.id}-${g.lastId}`,
          app: 'telegram',
          title: `Digest: ${chatName(g.chat)} (${g.lines.length} new)`,
          from: chatName(g.chat),
          context: shown.join('\n'),
          draft: 'Mark as read. Nothing is sent.',
        },
        { kind: 'digest' },
      );
      if (ok) queued++;
    }
    return queued;
  }

  /** Sends an approved reply. Digest items send nothing. Returns `{ ref }` or throws. */
  async function handle(item, meta) {
    if (!meta || meta.kind === 'digest') return { ref: 'marked-read' };
    if (meta.kind !== 'reply' || meta.chatId === undefined) throw new Error('item has no Telegram chat to reply to');
    const text = clean(item.draft, MAX_REPLY);
    if (!text) throw new Error('reply is empty');
    const sent = await call('sendMessage', {
      chat_id: meta.chatId,
      text,
      reply_parameters: { message_id: meta.replyTo, allow_sending_without_reply: true },
    });
    return { ref: `tg-${sent.chat?.id ?? meta.chatId}-${sent.message_id}` };
  }

  async function loop() {
    let backoff = 1000;
    while (running) {
      abort = new AbortController();
      try {
        await pollOnce(abort.signal);
        backoff = 1000;
      } catch (e) {
        if (!running) break;
        log(`telegram poll failed: ${e instanceof Error ? e.message : e} (retry in ${backoff / 1000}s)`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  return {
    pollOnce,
    handle,
    start() {
      if (running) return;
      running = true;
      void loop();
    },
    stop() {
      running = false;
      abort?.abort();
    },
  };
}
