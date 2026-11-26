import { counts, detailActions, MENU, openItem, VOICE_ACTION, type State } from './store';
import type { ActionItem } from './model';

/** Plain description of a G2 page (576x288, monochrome). Kept free of SDK imports so it is unit-testable. */
export interface TextBox {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  content: string;
  capture?: boolean;
}
export interface ListBox {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  items: string[];
}
export interface Page {
  texts: TextBox[];
  list?: ListBox;
  menu?: { id: number; name: string }[];
}

export const W = 576;
export const H = 288;
const MAX_ITEM_BYTES = 63;

export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}

/** Text containers hold at most 999 bytes; cut on a character boundary. */
export function fitBytes(text: string, max = 900): string {
  let out = text;
  while (new TextEncoder().encode(out).length > max) out = out.slice(0, -1);
  return out;
}

/** List item names are limited to 63 bytes on the glasses. */
export function listName(text: string): string {
  let out = text;
  while (new TextEncoder().encode(out).length > MAX_ITEM_BYTES) out = out.slice(0, -2) + '…';
  return out;
}

const APP_TAG: Record<string, string> = { gmail: 'MAIL', calendar: 'CAL', drive: 'DRIVE', telegram: 'TG' };
const tag = (app?: string) => (app ? (APP_TAG[app] ?? app.slice(0, 5).toUpperCase()) : 'TASK');

function header(s: State, right = ''): TextBox {
  const c = counts(s);
  const left = `DANI · ${s.label}`;
  return {
    name: 'hdr',
    x: 0,
    y: 0,
    w: W,
    h: 36,
    content: right ? `${left}   ${right}` : `${left}   ${c.pending} waiting`,
  };
}

/** Title, who it is from, what it answers (when known), then the draft. Four short lines fit the box. */
function detailText(item: ActionItem, note?: string): string {
  const head = `${clip(item.title, 40)}\nFrom ${clip(item.from, 30)}`;
  const body = item.context ? `They: ${clip(item.context, 70)}\nReply: ${clip(item.draft, 90)}` : clip(item.draft, 120);
  return `${head}\n${body}${note ? `\n! ${clip(note, 60)}` : ''}`;
}

export function render(s: State): Page {
  const page = renderRaw(s);
  return { ...page, texts: page.texts.map((t) => ({ ...t, content: fitBytes(t.content) })) };
}

function renderRaw(s: State): Page {
  const item = openItem(s);
  switch (s.screen) {
    case 'offline':
      return {
        texts: [
          { name: 'hdr', x: 0, y: 0, w: W, h: 36, content: `DANI · ${s.label}` },
          { name: 'body', x: 0, y: 44, w: W, h: 100, content: clip(s.failure ?? 'Not connected.', 200) },
        ],
        list: { name: 'off', x: 0, y: 160, w: W, h: 100, items: ['Try again'] },
      };
    case 'brief': {
      const c = counts(s);
      const body =
        c.pending > 0
          ? `${c.pending} action${c.pending === 1 ? '' : 's'} need your OK.\nNext: ${clip(s.pending[0]!.title, 40)}`
          : `Queue clear. ${c.done} done, ${c.skipped} skipped, ${c.rejected} rejected.`;
      return {
        texts: [header(s), { name: 'body', x: 0, y: 44, w: W, h: 70, content: body }],
        list: {
          name: 'nav',
          x: 0,
          y: 120,
          w: W,
          h: 150,
          items: [`Review queue (${c.pending})`, `Receipts (${s.receipts.length})`, 'Refresh'],
        },
      };
    }
    case 'queue':
      return {
        texts: [header(s, 'pick one')],
        list: {
          name: 'queue',
          x: 0,
          y: 44,
          w: W,
          h: 236,
          items: s.pending.map((p) => listName(`${tag(p.app)} ${clip(p.title, 44)}`)),
        },
      };
    case 'detail': {
      if (!item) return renderRaw({ ...s, screen: 'queue' });
      return {
        texts: [
          header(s, `${s.current + 1}/${s.pending.length}`),
          {
            name: 'draft',
            x: 0,
            y: 40,
            w: W,
            h: 112,
            content: detailText(item, s.failure),
          },
        ],
        list: { name: 'act', x: 0, y: 150, w: W, h: 134, items: detailActions(s) },
        menu: [
          { id: MENU.approve, name: 'Approve' },
          { id: MENU.skip, name: 'Skip' },
          { id: MENU.reject, name: 'Reject' },
          ...(s.voice ? [{ id: MENU.voice, name: VOICE_ACTION }] : []),
        ],
      };
    }
    case 'listening':
      return {
        texts: [
          header(s, 'listening'),
          { name: 'body', x: 0, y: 60, w: W, h: 160, content: `Say your reply to:\n${clip(item?.title ?? '', 44)}\n\nClick when done. Double-click cancels.`, capture: true },
        ],
      };
    case 'transcribing':
      return {
        texts: [
          header(s, 'working'),
          { name: 'body', x: 0, y: 60, w: W, h: 160, content: 'Turning your voice into text.\n\nPlease wait.', capture: true },
        ],
      };
    case 'running':
      return {
        texts: [
          header(s, 'working'),
          { name: 'body', x: 0, y: 60, w: W, h: 160, content: `Running: ${clip(item?.title ?? '', 44)}\n\nPlease wait.`, capture: true },
        ],
      };
    case 'receipt': {
      const r = s.last;
      const recordedOnly = r?.outcome === 'done' && r.ref.startsWith('recorded-');
      const verb = recordedOnly ? 'Recorded' : r?.outcome === 'done' ? 'Done' : r?.outcome === 'skipped' ? 'Skipped' : 'Rejected';
      return {
        texts: [
          header(s, verb),
          {
            name: 'body',
            x: 0,
            y: 50,
            w: W,
            h: 170,
            content: `${verb}: ${clip(r?.title ?? '', 44)}\nRef ${clip(r?.ref ?? '', 40)}${recordedOnly ? '\nApproval saved. Nothing was sent.' : ''}\n\nClick to continue.`,
            capture: true,
          },
        ],
      };
    }
    case 'error':
      return {
        texts: [
          header(s, 'failed'),
          {
            name: 'body',
            x: 0,
            y: 44,
            w: W,
            h: 120,
            content: `Did not run: ${clip(item?.title ?? '', 40)}\n${clip(s.failure ?? 'Unknown error', 90)}`,
          },
        ],
        list: { name: 'err', x: 0, y: 176, w: W, h: 100, items: ['Retry', 'Skip it'] },
      };
    case 'receipts': {
      const last = s.receipts.slice(-4).reverse();
      const body = last.length
        ? last.map((r) => `${r.outcome === 'done' ? 'OK  ' : r.outcome === 'skipped' ? 'SKIP' : 'NO  '} ${clip(r.title, 40)}`).join('\n')
        : 'Nothing yet.';
      return {
        texts: [header(s, 'receipts'), { name: 'body', x: 0, y: 50, w: W, h: 200, content: body, capture: true }],
      };
    }
  }
}
