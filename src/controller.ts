import type { ActionItem, DictateResult, Executor, Mic, QueueSource, Receipt } from './model';
import { finishDictation, finishRun, initialState, offlineState, openItem, reduce, type Input, type State } from './store';
import { render, type Page } from './view';

export interface Storage {
  get(key: string): Promise<string>;
  set(key: string, value: string): Promise<unknown>;
}

const RECEIPTS_KEY = 'dani-g2.receipts.v1';
const MAX_RECEIPTS = 200;

/** Owns state, runs approvals, persists receipts. UI-agnostic so tests can drive it without glasses. */
export class Controller {
  state: State;
  private busy = false;
  private receipts: Receipt[] = [];

  constructor(
    private source: QueueSource | undefined,
    private executor: Executor,
    private storage: Storage,
    private onPage: (p: Page) => Promise<void> | void,
    private log: (m: string) => void = () => {},
    private mic?: Mic,
  ) {
    this.state = offlineState('NOT CONNECTED', 'Starting…');
  }

  async start(): Promise<void> {
    try {
      const raw = await this.storage.get(RECEIPTS_KEY);
      if (raw) this.receipts = (JSON.parse(raw) as Receipt[]).slice(-MAX_RECEIPTS);
    } catch {
      this.log('could not read saved receipts, starting clean');
    }
    await this.reload();
  }

  /** Fetch the queue again. Keeps receipts; a failure shows an offline screen with Try again. */
  async reload(): Promise<void> {
    if (!this.source) {
      this.state = offlineState('NOT CONNECTED', 'No backend set. Open the app with ?backend=URL (see README).', this.receipts);
    } else {
      try {
        const snap = await this.source.load();
        this.state = initialState(snap.label, snap.items, this.receipts, !!snap.voice && !!this.mic && !!this.executor.dictate);
      } catch (e) {
        const why = e instanceof Error ? e.message : 'unknown error';
        this.log(`load failed: ${why}`);
        this.state = offlineState('OFFLINE', `Could not load the queue: ${why}`, this.receipts);
      }
    }
    await this.push();
  }

  async handle(input: Input): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const s = this.state;
      if (input.type === 'click' && (s.screen === 'offline' || (s.screen === 'brief' && input.index === 2))) {
        await this.reload();
        return;
      }
      const item = openItem(s);
      this.state = reduce(s, input);
      if (this.state.receipts.length !== s.receipts.length) {
        const r = this.state.receipts[this.state.receipts.length - 1]!;
        this.receipts = this.state.receipts;
        await this.save();
        if (item && r.outcome !== 'done') await this.executor.resolve(item, r.outcome);
      }
      if (s.screen === 'detail' && this.state.screen === 'listening') {
        await this.startRecording();
      } else if (s.screen === 'listening' && this.state.screen === 'detail') {
        await this.mic?.stop().catch(() => undefined); // cancelled: discard the recording
      }
      await this.push();
      if (this.state.screen === 'running') await this.run();
      if (this.state.screen === 'transcribing') await this.transcribe(item);
    } finally {
      this.busy = false;
    }
  }

  private async startRecording(): Promise<void> {
    try {
      await this.mic!.start();
    } catch (e) {
      this.log(`microphone failed: ${e instanceof Error ? e.message : e}`);
      this.state = { ...this.state, screen: 'detail', failure: 'Microphone not available.' };
    }
  }

  private async transcribe(item: ActionItem | undefined): Promise<void> {
    let result: DictateResult;
    try {
      const wav = await this.mic!.stop();
      result =
        !item || !this.executor.dictate
          ? { ok: false, reason: 'Voice replies are not available.' }
          : wav.length < 6_000 // under about 0.2 s of audio
            ? { ok: false, reason: 'Heard nothing. Try again.' }
            : await this.executor.dictate(item, wav);
    } catch (e) {
      result = { ok: false, reason: e instanceof Error ? e.message : 'recording failed' };
    }
    this.state = finishDictation(this.state, result);
    await this.push();
  }

  private async run(): Promise<void> {
    const item = openItem(this.state);
    if (!item) return;
    this.log(`approve ${item.id}`);
    const result = await this.executor.approve(item);
    this.state = finishRun(this.state, result);
    if (result.ok) {
      this.receipts = this.state.receipts;
      await this.save();
    }
    await this.push();
  }

  private async save(): Promise<void> {
    await this.storage.set(RECEIPTS_KEY, JSON.stringify(this.receipts.slice(-MAX_RECEIPTS)));
  }

  private async push(): Promise<void> {
    await this.onPage(render(this.state));
  }
}
