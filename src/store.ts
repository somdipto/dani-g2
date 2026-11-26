import type { ActionItem, DictateResult, ExecResult, Outcome, Receipt } from './model';

export type Screen = 'offline' | 'brief' | 'queue' | 'detail' | 'listening' | 'transcribing' | 'running' | 'receipt' | 'error' | 'receipts';

export interface State {
  label: string;
  screen: Screen;
  /** The backend can turn a recording into a new draft, so detail offers "Reply by voice". */
  voice: boolean;
  pending: ActionItem[];
  receipts: Receipt[];
  /** Index into `pending` for the open item. */
  current: number;
  failure?: string;
  /** Last receipt, shown on the receipt screen. */
  last?: Receipt;
}

export type Input =
  | { type: 'click'; index: number }
  | { type: 'back' }
  | { type: 'menu'; id: number };

export const MENU = { approve: 1, skip: 2, reject: 3, voice: 4 } as const;
export const DETAIL_ACTIONS = ['Approve', 'Skip', 'Reject'] as const;
export const VOICE_ACTION = 'Reply by voice';

/** Rows shown under a draft. */
export const detailActions = (s: Pick<State, 'voice'>): string[] => (s.voice ? [...DETAIL_ACTIONS, VOICE_ACTION] : [...DETAIL_ACTIONS]);

export function offlineState(label: string, reason: string, receipts: Receipt[] = []): State {
  return { label, screen: 'offline', voice: false, pending: [], receipts, current: 0, failure: reason };
}

export function initialState(label: string, items: ActionItem[], receipts: Receipt[] = [], voice = false): State {
  const done = new Set(receipts.map((r) => r.itemId));
  return {
    label,
    voice,
    screen: 'brief',
    pending: items.filter((i) => !done.has(i.id)),
    receipts,
    current: 0,
  };
}

export function openItem(s: State): ActionItem | undefined {
  return s.pending[s.current];
}

function settle(s: State, outcome: Outcome, ref: string, now: Date): State {
  const item = openItem(s);
  if (!item) return s;
  const receipt: Receipt = { itemId: item.id, title: item.title, outcome, ref, at: now.toISOString() };
  const pending = s.pending.filter((_, i) => i !== s.current);
  return {
    ...s,
    pending,
    receipts: [...s.receipts, receipt],
    current: 0,
    failure: undefined,
    last: receipt,
    screen: 'receipt',
  };
}

/** Pure reducer for glasses input. Running an approval is a separate step: see `finishRun`. */
export function reduce(s: State, input: Input, now = new Date()): State {
  switch (s.screen) {
    case 'offline':
      return s; // the controller reloads on click
    case 'brief':
      if (input.type === 'click') {
        if (input.index === 0) return { ...s, screen: s.pending.length ? 'queue' : 'brief' };
        if (input.index === 1) return { ...s, screen: 'receipts' };
      }
      return s; // index 2 is Refresh, handled by the controller
    case 'queue':
      if (input.type === 'back') return { ...s, screen: 'brief' };
      if (input.type === 'click' && s.pending[input.index]) return { ...s, current: input.index, screen: 'detail' };
      return s;
    case 'receipts':
      return input.type === 'back' || input.type === 'click' ? { ...s, screen: 'brief' } : s;
    case 'detail': {
      if (input.type === 'back') return { ...s, screen: 'queue' };
      const choice =
        input.type === 'click'
          ? input.index
          : input.type === 'menu'
            ? input.id - 1
            : -1;
      if (choice === 0) return { ...s, screen: 'running', failure: undefined };
      if (choice === 1) return settle(s, 'skipped', 'skipped', now);
      if (choice === 2) return settle(s, 'rejected', 'rejected', now);
      if (choice === 3 && s.voice) return { ...s, screen: 'listening', failure: undefined };
      return s;
    }
    case 'listening':
      if (input.type === 'click') return { ...s, screen: 'transcribing' };
      if (input.type === 'back') return { ...s, screen: 'detail' };
      return s;
    case 'transcribing':
      return s; // input is ignored while the recording is being turned into text
    case 'error':
      if (input.type === 'back') return { ...s, screen: 'detail', failure: undefined };
      if (input.type === 'click') {
        if (input.index === 0) return { ...s, screen: 'running', failure: undefined };
        return settle(s, 'skipped', 'skipped after failure', now);
      }
      return s;
    case 'receipt':
      if (input.type === 'click' || input.type === 'back') {
        return { ...s, screen: s.pending.length ? 'queue' : 'brief' };
      }
      return s;
    case 'running':
      return s; // input is ignored while an approval is in flight
  }
}

/** Apply the executor result to a state that is in the `running` screen. */
export function finishRun(s: State, result: ExecResult, now = new Date()): State {
  if (s.screen !== 'running') return s;
  if (result.ok) return settle(s, 'done', result.ref, now);
  return { ...s, screen: 'error', failure: result.reason };
}

/** Apply a transcription result to a state that is in the `transcribing` screen. */
export function finishDictation(s: State, result: DictateResult): State {
  if (s.screen !== 'transcribing') return s;
  if (!result.ok) return { ...s, screen: 'detail', failure: result.reason };
  const pending = s.pending.map((p, i) => (i === s.current ? { ...p, draft: result.draft } : p));
  return { ...s, pending, screen: 'detail', failure: undefined };
}

export function counts(s: State) {
  const by = (o: Outcome) => s.receipts.filter((r) => r.outcome === o).length;
  return { pending: s.pending.length, done: by('done'), skipped: by('skipped'), rejected: by('rejected') };
}
