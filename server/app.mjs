// Reference backend for Dani on G2. No dependencies. File-backed queue + audit log.
//
//   GET  /queue                   -> { items: ActionItem[] }          pending items
//   POST /queue                   -> add one item or { items: [...] } (how an assistant enqueues drafts)
//   POST /actions/:id/approve     -> runs the handler; { ref } or { error } (502 if the handler fails)
//   POST /actions/:id/skip|reject -> records the decision
//   POST /actions/:id/dictate     -> WAV body; transcribes it and replaces the draft ({ draft })
//   GET  /log                     -> audit entries
//
// Approve calls DANI_HANDLER_URL (POST, JSON body {item}) if set. A 2xx reply means "done" and may return {ref}.
// With no handler set, approve only RECORDS the approval (reply has recorded_only: true). It does not send anything.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const MAX_AUDIO = 1_500_000; // about 45 s of 16 kHz 16-bit PCM in a WAV

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { code: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { code: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const pick = (i) => ({
  id: i.id,
  title: i.title,
  draft: i.draft,
  from: i.from ?? '',
  ...(i.context ? { context: String(i.context) } : {}),
  ...(i.app ? { app: i.app } : {}),
});

function readRaw(req, limit = MAX_AUDIO) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('audio too large'), { code: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function validItem(o) {
  return o && typeof o.id === 'string' && o.id && typeof o.title === 'string' && o.title && typeof o.draft === 'string';
}

const publicItem = ({ meta, ...rest }) => rest;

/**
 * @param {{ file: string, token?: string, handlerUrl?: string, fetchImpl?: typeof fetch,
 *   handlers?: Record<string, (item: object, meta: object|undefined) => Promise<{ ref?: string }>>,
 *   stt?: (wav: Buffer) => Promise<string> }} opts
 * `handlers` maps an item's `app` tag to a function that performs the approved action (for example "telegram").
 * An item may carry private `meta` (never returned by GET /queue) that its handler needs.
 */
export function createApp(opts) {
  const { file, token, handlerUrl, fetchImpl = fetch, handlers = {}, stt } = opts;
  let db = { items: [], log: [] };
  if (existsSync(file)) db = JSON.parse(readFileSync(file, 'utf8'));
  const save = () => {
    writeFileSync(`${file}.tmp`, JSON.stringify(db, null, 2));
    renameSync(`${file}.tmp`, file);
  };
  const audit = (id, outcome, ref) => {
    db.log.push({ id, outcome, ref, at: new Date().toISOString() });
    db.log = db.log.slice(-1000);
  };

  /** Adds one item from inside the process (used by the Telegram bridge). Returns false for a duplicate. */
  const enqueue = (i, meta) => {
    if (!validItem(i)) throw new Error('item needs string id, title and draft');
    if (db.items.some((x) => x.id === i.id) || db.log.some((l) => l.id === i.id)) return false;
    db.items.push({ ...pick(i), ...(meta ? { meta } : {}) });
    save();
    return true;
  };

  const server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    if (token && req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'unauthorized' });
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/queue') return json(res, 200, { items: db.items.map(publicItem), voice: !!stt });
      if (req.method === 'GET' && path === '/log') return json(res, 200, { log: db.log });
      if (req.method === 'POST' && path === '/queue') {
        const body = await readBody(req);
        const list = Array.isArray(body.items) ? body.items : [body];
        const bad = list.find((i) => !validItem(i));
        if (bad) return json(res, 400, { error: 'each item needs string id, title and draft' });
        for (const i of list) {
          if (db.items.some((x) => x.id === i.id) || db.log.some((l) => l.id === i.id)) {
            return json(res, 409, { error: `item ${i.id} already exists or was already handled` });
          }
        }
        for (const i of list) {
          db.items.push(pick(i));
        }
        save();
        return json(res, 201, { added: list.length });
      }
      const d = req.method === 'POST' && path.match(/^\/actions\/([^/]+)\/dictate$/);
      if (d) {
        // Voice reply: the body is a WAV clip. The transcript replaces the draft; nothing is sent until approve.
        if (!stt) return json(res, 501, { error: 'Voice replies are not set up on the backend (SARVAM_API_KEY).' });
        const item = db.items.find((i) => i.id === decodeURIComponent(d[1]));
        if (!item) return json(res, 404, { error: 'no such pending item' });
        const wav = await readRaw(req);
        if (wav.length < 1000) return json(res, 400, { error: 'recording too short' });
        let text;
        try {
          text = (await stt(wav)).replace(/\s+/g, ' ').trim().slice(0, 1000);
        } catch (e) {
          return json(res, 502, { error: e instanceof Error ? e.message : 'speech failed' });
        }
        item.draft = text;
        save();
        return json(res, 200, { draft: text });
      }
      const m = req.method === 'POST' && path.match(/^\/actions\/([^/]+)\/(approve|skip|reject)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const verb = m[2];
        const item = db.items.find((i) => i.id === id);
        if (!item) return json(res, 404, { error: 'no such pending item' });
        let ref = `recorded-${randomUUID().slice(0, 8)}`;
        let recordedOnly = false;
        if (verb === 'approve') {
          const handler = item.app && handlers[item.app];
          if (handler) {
            try {
              const r = await handler(publicItem(item), item.meta);
              if (typeof r?.ref === 'string') ref = r.ref;
            } catch (e) {
              return json(res, 502, { error: `${item.app} failed: ${e instanceof Error ? e.message : e}` });
            }
          } else if (handlerUrl) {
            let r;
            try {
              r = await fetchImpl(handlerUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ item: publicItem(item) }),
                signal: AbortSignal.timeout(15_000),
              });
            } catch (e) {
              return json(res, 502, { error: `handler unreachable: ${e instanceof Error ? e.message : e}` });
            }
            if (!r.ok) return json(res, 502, { error: `handler returned HTTP ${r.status}` });
            const b = await r.json().catch(() => ({}));
            if (typeof b.ref === 'string') ref = b.ref;
          } else {
            recordedOnly = true;
          }
        }
        db.items = db.items.filter((i) => i.id !== id);
        audit(id, verb === 'approve' ? 'approved' : verb === 'skip' ? 'skipped' : 'rejected', ref);
        save();
        return json(res, 200, { ref, ...(recordedOnly ? { recorded_only: true } : {}) });
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, e.code === 413 || e.code === 400 ? e.code : 500, { error: e.message });
    }
  });
  server.enqueue = enqueue;
  return server;
}
