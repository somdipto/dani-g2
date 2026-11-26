import type { ActionItem, DictateResult, ExecResult, Executor, QueueSnapshot, QueueSource } from './model';
import { parseItems } from './validate';

const TIMEOUT_MS = 10_000;

async function request(url: string, init: RequestInit, token?: string): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: ctl.signal,
      headers: { ...(init.headers as Record<string, string>), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  } catch (e) {
    throw new Error(ctl.signal.aborted ? `timed out after ${TIMEOUT_MS / 1000}s` : e instanceof Error ? e.message : 'network error');
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a queue from a backend that follows the contract in the README (see also server/). */
export class HttpSource implements QueueSource {
  constructor(private base: string, private token?: string) {}
  async load(): Promise<QueueSnapshot> {
    const res = await request(`${this.base}/queue`, {}, this.token);
    if (!res.ok) throw new Error(`queue request failed: HTTP ${res.status}`);
    const payload = await res.json();
    const { items } = parseItems(payload);
    return { label: 'LIVE', items, voice: (payload as { voice?: unknown }).voice === true };
  }
}

export class HttpExecutor implements Executor {
  constructor(private base: string, private token?: string) {}

  async approve(item: ActionItem): Promise<ExecResult> {
    try {
      const res = await request(`${this.base}/actions/${encodeURIComponent(item.id)}/approve`, { method: 'POST' }, this.token);
      const body = (await res.json().catch(() => ({}))) as { ref?: string; error?: string };
      if (!res.ok) return { ok: false, reason: body.error ?? `server said HTTP ${res.status}` };
      return { ok: true, ref: body.ref ?? item.id };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : 'network error' };
    }
  }

  async dictate(item: ActionItem, wav: Uint8Array): Promise<DictateResult> {
    try {
      const res = await request(
        `${this.base}/actions/${encodeURIComponent(item.id)}/dictate`,
        { method: 'POST', body: wav as unknown as BodyInit, headers: { 'content-type': 'audio/wav' } },
        this.token,
      );
      const body = (await res.json().catch(() => ({}))) as { draft?: string; error?: string };
      if (!res.ok || !body.draft) return { ok: false, reason: body.error ?? `server said HTTP ${res.status}` };
      return { ok: true, draft: body.draft };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : 'network error' };
    }
  }

  async resolve(item: ActionItem, outcome: 'skipped' | 'rejected'): Promise<void> {
    const verb = outcome === 'skipped' ? 'skip' : 'reject';
    try {
      await request(`${this.base}/actions/${encodeURIComponent(item.id)}/${verb}`, { method: 'POST' }, this.token);
    } catch {
      /* the receipt on the device is the record; the backend copy is best effort */
    }
  }
}

/** Demo mode only (`?demo=1`). Loads made-up items bundled with the app. */
export class SampleSource implements QueueSource {
  constructor(private url = './queue.sample.json') {}
  async load(): Promise<QueueSnapshot> {
    const res = await fetch(this.url);
    if (!res.ok) throw new Error(`sample queue: HTTP ${res.status}`);
    const j = (await res.json()) as { label?: string };
    return { label: j.label ?? 'SAMPLE DATA', items: parseItems(j).items, voice: true };
  }
}

/**
 * Demo mode only. Does not send mail, edit calendars or share files; it waits, then reports success.
 * `failOnce` lists item ids whose first approval fails, so the retry path can be shown.
 */
export class SimulatedExecutor implements Executor {
  private failed = new Set<string>();
  constructor(private delayMs = 900, private failOnce: string[] = []) {}
  async approve(item: ActionItem): Promise<ExecResult> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failOnce.includes(item.id) && !this.failed.has(item.id)) {
      this.failed.add(item.id);
      return { ok: false, reason: 'Simulated failure: share service timed out.' };
    }
    return { ok: true, ref: `sim-${item.id}` };
  }
  /** Demo mode: ignores the recording and returns a fixed sentence, so the voice flow can be shown without a key. */
  async dictate(): Promise<DictateResult> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return { ok: true, draft: 'Sounds good. Thursday at 3 works for me, see you then.' };
  }
  async resolve(): Promise<void> {}
}
