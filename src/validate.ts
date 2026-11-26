import type { ActionItem } from './model';

const MAX_ITEMS = 20; // the glasses list holds at most 20 entries

/** Parses an untrusted backend payload. Bad entries are dropped and counted, never guessed at. */
export function parseItems(payload: unknown): { items: ActionItem[]; dropped: number } {
  const raw = (payload as { items?: unknown } | null)?.items;
  if (!Array.isArray(raw)) throw new Error('queue payload has no items array');
  const items: ActionItem[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const r of raw) {
    const o = r as Record<string, unknown> | null;
    const ok =
      o &&
      typeof o.id === 'string' && o.id &&
      typeof o.title === 'string' && o.title &&
      typeof o.draft === 'string' &&
      !seen.has(o.id);
    if (!ok || items.length >= MAX_ITEMS) {
      dropped++;
      continue;
    }
    seen.add(o.id as string);
    items.push({
      id: o.id as string,
      title: o.title as string,
      draft: o.draft as string,
      from: typeof o.from === 'string' ? o.from : '',
      ...(typeof o.context === 'string' && o.context ? { context: o.context } : {}),
      ...(typeof o.app === 'string' && o.app ? { app: o.app } : {}),
    });
  }
  return { items, dropped };
}
