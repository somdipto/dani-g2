import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Controller } from '../src/controller';
import { SampleSource, SimulatedExecutor } from '../src/adapters';
import { DemoMic } from '../src/mic';
import { render } from '../src/view';
import type { Screen } from '../src/store';

interface Step { expect: Screen | 'receipt'; caption: string; actions: string[]; wait: number; name: string }

/**
 * Replays demo/flow.json (the same file scripts/demo.mjs plays against the real simulator) through the app's
 * controller, with a list-selection model like the glasses: "down" moves the highlight, any screen change resets it.
 * It checks the screen reached after each step, so the video script cannot drift from the app.
 */
describe('demo script', () => {
  it('reaches the screen each step promises, and ends with an empty queue', async () => {
    const flow = JSON.parse(readFileSync('demo/flow.json', 'utf8')) as Step[];
    const sample = JSON.parse(readFileSync('public/queue.sample.json', 'utf8'));
    const mem = new Map<string, string>();
    const app = new Controller(
      { load: async () => ({ label: 'SAMPLE DATA', items: sample.items, voice: true }) },
      new SimulatedExecutor(0, ['s-3']),
      { get: async (k) => mem.get(k) ?? '', set: async (k, v) => void mem.set(k, v) },
      () => {},
      () => {},
      new DemoMic(),
    );
    await app.start();
    expect(app.state.pending).toHaveLength(6);
    let highlight = 0;
    for (const step of flow) {
      for (const action of step.actions) {
        const before = app.state.screen;
        if (action === 'down') highlight++;
        else await app.handle({ type: 'click', index: highlight });
        if (app.state.screen !== before) highlight = 0;
      }
      const label = step.expect === 'receipt' ? 'receipt' : step.expect;
      expect(app.state.screen, `after "${step.name}"`).toBe(label);
      expect(render(app.state).texts.length).toBeGreaterThan(0);
    }
    expect(app.state.pending).toHaveLength(0);
    expect(app.state.receipts.map((r) => r.outcome)).toEqual(['done', 'done', 'done', 'done', 'rejected', 'skipped']);
    expect(app.state.receipts.map((r) => r.itemId)).toEqual(['s-t1', 's-t2', 's-1', 's-3', 's-2', 's-4']);
    expect(app.state.pending.length + app.state.receipts.length).toBe(6);
  });
});
