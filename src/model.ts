/** One thing the assistant wants to do on the user's behalf. Nothing runs until the user approves it. */
export interface ActionItem {
  id: string;
  title: string;
  /** Who or what this is about. Shown under the title. */
  from: string;
  /** The exact text or change that will be applied if approved. */
  draft: string;
  /** What the draft answers, for example the incoming chat message. Shown above the draft. */
  context?: string;
  /** Optional source tag shown in the queue list, for example "gmail", "calendar", "drive". */
  app?: string;
}

export type Outcome = 'done' | 'skipped' | 'rejected';

export interface Receipt {
  itemId: string;
  title: string;
  outcome: Outcome;
  /** Reference returned by the backend for an approval, or a short note for skip and reject. */
  ref: string;
  at: string;
}

export interface QueueSnapshot {
  /** Shown on the glasses header, for example "LIVE" or "SAMPLE DATA". */
  label: string;
  items: ActionItem[];
  /** True when the backend can turn a voice recording into a new draft. */
  voice?: boolean;
}

export interface QueueSource {
  load(): Promise<QueueSnapshot>;
}

export type ExecResult = { ok: true; ref: string } | { ok: false; reason: string };

export type DictateResult = { ok: true; draft: string } | { ok: false; reason: string };

/** Records one spoken reply. `stop` returns a WAV file (16 kHz, mono, 16-bit). */
export interface Mic {
  start(): Promise<void>;
  stop(): Promise<Uint8Array>;
}

export interface Executor {
  /** Turn a recording into a new draft for the item. Optional: only backends with speech to text provide it. */
  dictate?(item: ActionItem, wav: Uint8Array): Promise<DictateResult>;
  approve(item: ActionItem): Promise<ExecResult>;
  /** Tell the backend the user skipped or rejected an item. Best effort: a failure never blocks the user. */
  resolve(item: ActionItem, outcome: 'skipped' | 'rejected'): Promise<void>;
}
