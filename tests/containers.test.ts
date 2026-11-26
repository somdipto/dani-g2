import { formatEvenHubPageContainerValidationError, validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk';
import { describe, expect, it } from 'vitest';
import { containersFor } from '../src/glasses';
import type { ActionItem } from '../src/model';
import { initialState, offlineState, reduce, type State } from '../src/store';
import { render } from '../src/view';

const long = 'word '.repeat(80);
const items: ActionItem[] = [
  { id: 'a', title: `Reply: ${long}`, from: `Someone ${long}`, context: long, draft: long, app: 'telegram' },
  { id: 'b', title: 'Digest: News (7 new)', from: 'News', context: '- one\n- two\n- three\n- four\n- five\n+2 more', draft: 'Mark as read. Nothing is sent.', app: 'telegram' },
  { id: 'c', title: 'Plain', from: 'F', draft: 'D', app: 'gmail' },
];

function screens(): [string, State][] {
  const brief = initialState('LIVE', items, [], true);
  const queue = reduce(brief, { type: 'click', index: 0 });
  const detail = reduce(queue, { type: 'click', index: 0 });
  return [
    ['offline', offlineState('OFFLINE', long)],
    ['brief', brief],
    ['queue', queue],
    ['detail', detail],
    ['detail with failure', { ...detail, failure: long }],
    ['detail without voice', { ...detail, voice: false }],
    ['listening', reduce(detail, { type: 'click', index: 3 })],
    ['transcribing', { ...detail, screen: 'transcribing' }],
    ['running', reduce(detail, { type: 'click', index: 0 })],
    ['error', { ...detail, screen: 'error', failure: long }],
    ['receipts', { ...brief, screen: 'receipts' }],
  ];
}

describe('every screen is accepted by the Even Hub SDK validator', () => {
  for (const [name, state] of screens()) {
    it(name, () => {
      const result = validateEvenHubPageContainer(containersFor(render(state)) as never);
      expect(result.valid, result.valid ? '' : formatEvenHubPageContainerValidationError(result)).toBe(true);
    });
  }

  it('lists never exceed 20 rows and detail menus carry the voice entry only when voice is on', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, title: `T${i}`, from: 'F', draft: 'D' }));
    const q = reduce(initialState('LIVE', many.slice(0, 20), [], true), { type: 'click', index: 0 });
    expect(render(q).list!.items).toHaveLength(20);
    const detail = reduce(q, { type: 'click', index: 0 });
    expect(render(detail).menu!.map((m) => m.name)).toEqual(['Approve', 'Skip', 'Reject', 'Reply by voice']);
    expect(render({ ...detail, voice: false }).menu!.map((m) => m.name)).toEqual(['Approve', 'Skip', 'Reject']);
  });
});
