import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module
import { createApp } from '../server/app.mjs';
// @ts-expect-error plain JS module
import { createSarvamStt } from '../server/stt.mjs';
import { HttpExecutor, HttpSource } from '../src/adapters';
import { Controller } from '../src/controller';
import type { ActionItem, Executor, Mic } from '../src/model';
import { detailActions, finishDictation, initialState, reduce } from '../src/store';
import { render } from '../src/view';
import { pcmToWav } from '../src/wav';

const open: Server[] = [];
afterEach(() => open.splice(0).forEach((s) => s.close()));
const items: ActionItem[] = [
  { id: 'a', title: 'Reply: Work group', from: 'Ava Rao', context: 'Can you send the deck by 5?', draft: 'Got it, thanks.', app: 'telegram' },
  { id: 'b', title: 'Move sync', from: 'Ben', draft: 'Move to 3pm.', app: 'calendar' },
];

describe('wav', () => {
  it('writes a valid 44-byte header for 16 kHz mono 16-bit PCM', () => {
    const w = pcmToWav(new Uint8Array(3200));
    const v = new DataView(w.buffer);
    expect(w.length).toBe(3244);
    expect(String.fromCharCode(...w.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...w.slice(8, 12))).toBe('WAVE');
    expect(v.getUint32(4, true)).toBe(36 + 3200);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(28, true)).toBe(32000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(3200);
  });
});

describe('Sarvam speech to text', () => {
  it('posts the clip with the key in a header and returns the transcript', async () => {
    let seen: { key: string | null; form: FormData } | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen = { key: (init.headers as Record<string, string>)['api-subscription-key'] ?? null, form: init.body as FormData };
      return new Response(JSON.stringify({ transcript: ' hello there ' }));
    }) as unknown as typeof fetch;
    const text = await createSarvamStt({ apiKey: 'sk-test', fetchImpl })(Buffer.from(pcmToWav(new Uint8Array(100))));
    expect(text).toBe('hello there');
    expect(seen!.key).toBe('sk-test');
    expect(seen!.form.get('model')).toBe('saaras:v4');
    expect(seen!.form.get('language_code')).toBe('unknown');
    expect(seen!.form.get('mode')).toBe('transcribe');
    expect((seen!.form.get('file') as File).type).toBe('audio/wav');
  });

  it('does not send mode for a saarika model, and reports empty or failed results without the key', async () => {
    let form: FormData | undefined;
    const ok = (async (_u: string, init: RequestInit) => ((form = init.body as FormData), new Response(JSON.stringify({ transcript: 'x' })))) as unknown as typeof fetch;
    await createSarvamStt({ apiKey: 'k', model: 'saarika:v2.5', language: 'en-IN', fetchImpl: ok })(Buffer.alloc(10));
    expect(form!.has('mode')).toBe(false);
    expect(form!.get('language_code')).toBe('en-IN');
    const empty = (async () => new Response(JSON.stringify({ transcript: '' }))) as unknown as typeof fetch;
    await expect(createSarvamStt({ apiKey: 'k', fetchImpl: empty })(Buffer.alloc(10))).rejects.toThrow('no speech recognised');
    const down = (async () => { throw new Error('connect failed for key sk-secret'); }) as unknown as typeof fetch;
    const err = await createSarvamStt({ apiKey: 'sk-secret', fetchImpl: down })(Buffer.alloc(10)).catch((e: Error) => e);
    expect((err as Error).message).toContain('speech service unreachable');
    expect((err as Error).message).not.toContain('sk-secret');
  });
});

describe('dictate endpoint', () => {
  async function start(stt?: (b: Buffer) => Promise<string>) {
    const file = join(mkdtempSync(join(tmpdir(), 'dani-v-')), 'db.json');
    const srv: Server = createApp({ file, stt });
    open.push(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    await fetch(`${base}/queue`, { method: 'POST', body: JSON.stringify({ id: 'a', title: 'T', draft: 'old', from: 'F' }) });
    return base;
  }

  it('without a speech service: /queue says voice is off and dictate answers 501', async () => {
    const base = await start();
    expect((await new HttpSource(base).load()).voice).toBe(false);
    const r = await fetch(`${base}/actions/a/dictate`, { method: 'POST', body: new Uint8Array(2000) });
    expect(r.status).toBe(501);
  });

  it('with a speech service: replaces the draft, and the new draft survives a reload', async () => {
    const base = await start(async () => 'a new spoken reply');
    expect((await new HttpSource(base).load()).voice).toBe(true);
    const [item] = (await new HttpSource(base).load()).items;
    const r = await new HttpExecutor(base).dictate!(item!, new Uint8Array(2000));
    expect(r).toEqual({ ok: true, draft: 'a new spoken reply' });
    expect((await new HttpSource(base).load()).items[0]!.draft).toBe('a new spoken reply');
  });

  it('rejects tiny recordings, unknown items and speech failures', async () => {
    const base = await start(async () => { throw new Error('speech service returned HTTP 500'); });
    expect((await fetch(`${base}/actions/a/dictate`, { method: 'POST', body: new Uint8Array(10) })).status).toBe(400);
    expect((await fetch(`${base}/actions/zzz/dictate`, { method: 'POST', body: new Uint8Array(2000) })).status).toBe(404);
    const r = await fetch(`${base}/actions/a/dictate`, { method: 'POST', body: new Uint8Array(2000) });
    expect(r.status).toBe(502);
    expect((await (await fetch(`${base}/queue`)).json()).items[0].draft).toBe('old');
  });
});

describe('voice in the reducer and view', () => {
  const s0 = () => reduce(reduce(initialState('T', items, [], true), { type: 'click', index: 0 }), { type: 'click', index: 0 });

  it('offers "Reply by voice" only when the backend supports it', () => {
    expect(detailActions({ voice: true })).toEqual(['Approve', 'Skip', 'Reject', 'Reply by voice']);
    expect(detailActions({ voice: false })).toEqual(['Approve', 'Skip', 'Reject']);
    expect(render(s0()).list!.items).toHaveLength(4);
    expect(render({ ...s0(), voice: false }).list!.items).toHaveLength(3);
  });

  it('detail shows the incoming message above the draft', () => {
    const body = render(s0()).texts[1]!.content;
    expect(body).toContain('They: Can you send the deck by 5?');
    expect(body).toContain('Reply: Got it, thanks.');
  });

  it('listening: click stops, back cancels; transcription replaces the draft and returns to detail', () => {
    const detail = s0();
    expect(reduce(detail, { type: 'click', index: 3 }).screen).toBe('listening');
    expect(reduce(detail, { type: 'menu', id: 4 }).screen).toBe('listening');
    const listening = reduce(detail, { type: 'click', index: 3 });
    expect(reduce(listening, { type: 'back' }).screen).toBe('detail');
    const working = reduce(listening, { type: 'click', index: 0 });
    expect(working.screen).toBe('transcribing');
    expect(reduce(working, { type: 'click', index: 0 })).toBe(working);
    const done = finishDictation(working, { ok: true, draft: 'Yes, 5pm.' });
    expect(done.screen).toBe('detail');
    expect(done.pending[0]!.draft).toBe('Yes, 5pm.');
    expect(done.pending[1]!.draft).toBe('Move to 3pm.');
    const failed = finishDictation(working, { ok: false, reason: 'Heard nothing. Try again.' });
    expect(failed.pending[0]!.draft).toBe('Got it, thanks.');
    expect(render(failed).texts[1]!.content).toContain('! Heard nothing. Try again.');
  });

  it('voice rows do nothing when voice is off', () => {
    const detail = { ...s0(), voice: false };
    expect(reduce(detail, { type: 'click', index: 3 })).toBe(detail);
  });

  it('every voice screen fits the glasses limits', () => {
    const detail = s0();
    for (const s of [reduce(detail, { type: 'click', index: 3 }), { ...detail, screen: 'transcribing' as const }]) {
      for (const t of render(s).texts) expect(new TextEncoder().encode(t.content).length).toBeLessThan(1000);
    }
  });
});

describe('controller voice flow', () => {
  function make(dictate: Executor['dictate'], wavLength = 40_000) {
    const calls: string[] = [];
    const pages: string[] = [];
    const mic: Mic = {
      start: async () => void calls.push('start'),
      stop: async () => (calls.push('stop'), new Uint8Array(wavLength)),
    };
    const executor: Executor = { approve: async (i) => ({ ok: true, ref: i.id }), resolve: async () => {}, dictate };
    const store = new Map<string, string>();
    const c = new Controller(
      { load: async () => ({ label: 'T', items: structuredClone(items), voice: true }) },
      executor,
      { get: async (k) => store.get(k) ?? '', set: async (k, v) => void store.set(k, v) },
      (p) => void pages.push(p.texts.map((t) => t.content).join('|')),
      () => {},
      mic,
    );
    return { c, calls, pages };
  }
  const toDetail = async (c: Controller) => {
    await c.start();
    for (const index of [0, 0]) await c.handle({ type: 'click', index });
  };

  it('records, transcribes, and shows the new draft without approving anything', async () => {
    const { c, calls } = make(async () => ({ ok: true, draft: 'Spoken reply.' }));
    await toDetail(c);
    await c.handle({ type: 'click', index: 3 });
    expect(c.state.screen).toBe('listening');
    expect(calls).toEqual(['start']);
    await c.handle({ type: 'click', index: 0 });
    expect(calls).toEqual(['start', 'stop']);
    expect(c.state.screen).toBe('detail');
    expect(c.state.pending[0]!.draft).toBe('Spoken reply.');
    expect(c.state.receipts).toHaveLength(0);
  });

  it('cancelling stops the microphone and keeps the draft', async () => {
    const { c, calls } = make(async () => ({ ok: true, draft: 'never used' }));
    await toDetail(c);
    await c.handle({ type: 'click', index: 3 });
    await c.handle({ type: 'back' });
    expect(calls).toEqual(['start', 'stop']);
    expect(c.state.screen).toBe('detail');
    expect(c.state.pending[0]!.draft).toBe('Got it, thanks.');
  });

  it('a very short recording is not sent to the speech service', async () => {
    let called = false;
    const { c } = make(async () => ((called = true), { ok: true, draft: 'x' }), 100);
    await toDetail(c);
    await c.handle({ type: 'click', index: 3 });
    await c.handle({ type: 'click', index: 0 });
    expect(called).toBe(false);
    expect(c.state.failure).toBe('Heard nothing. Try again.');
  });

  it('a backend failure leaves the draft alone and says why', async () => {
    const { c } = make(async () => ({ ok: false, reason: 'speech service returned HTTP 500' }));
    await toDetail(c);
    await c.handle({ type: 'click', index: 3 });
    await c.handle({ type: 'click', index: 0 });
    expect(c.state.screen).toBe('detail');
    expect(c.state.pending[0]!.draft).toBe('Got it, thanks.');
    expect(c.state.failure).toBe('speech service returned HTTP 500');
  });

  it('a microphone that will not start returns to detail with a message', async () => {
    const c = new Controller(
      { load: async () => ({ label: 'T', items: structuredClone(items), voice: true }) },
      { approve: async () => ({ ok: true, ref: 'r' }), resolve: async () => {}, dictate: async () => ({ ok: true, draft: 'x' }) },
      { get: async () => '', set: async () => {} },
      () => {},
      () => {},
      { start: async () => { throw new Error('no mic'); }, stop: async () => new Uint8Array() },
    );
    await toDetail(c);
    await c.handle({ type: 'click', index: 3 });
    expect(c.state.screen).toBe('detail');
    expect(c.state.failure).toBe('Microphone not available.');
  });

  it('without a microphone, voice is hidden even if the backend supports it', async () => {
    const c = new Controller(
      { load: async () => ({ label: 'T', items: structuredClone(items), voice: true }) },
      { approve: async () => ({ ok: true, ref: 'r' }), resolve: async () => {} },
      { get: async () => '', set: async () => {} },
      () => {},
    );
    await c.start();
    expect(c.state.voice).toBe(false);
  });
});
