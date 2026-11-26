import { AudioInputSource, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import type { Mic } from './model';
import { pcmToWav } from './wav';

const MAX_BYTES = 16_000 * 2 * 25; // 25 s; the speech service takes at most 30 s per clip

/** Records the glasses microphone (16 kHz, mono, 16-bit PCM events) and returns a WAV on stop. */
export class GlassesMic implements Mic {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private off?: () => void;

  constructor(private bridge: EvenAppBridge) {}

  async start(): Promise<void> {
    this.chunks = [];
    this.size = 0;
    this.off = this.bridge.onEvenHubEvent((event) => {
      const pcm = event.audioEvent?.audioPcm;
      if (!pcm || this.size >= MAX_BYTES) return;
      const part = pcm.length + this.size > MAX_BYTES ? pcm.slice(0, MAX_BYTES - this.size) : pcm;
      this.chunks.push(part);
      this.size += part.length;
    });
    const ok = await this.bridge.audioControl(true, AudioInputSource.Glasses);
    if (!ok) {
      this.off();
      this.off = undefined;
      throw new Error('the glasses refused to open the microphone');
    }
  }

  async stop(): Promise<Uint8Array> {
    this.off?.();
    this.off = undefined;
    await this.bridge.audioControl(false).catch(() => undefined);
    const pcm = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) {
      pcm.set(c, at);
      at += c.length;
    }
    this.chunks = [];
    this.size = 0;
    return pcmToWav(pcm);
  }
}

/** Demo mode only: records nothing and returns one second of silence, so the voice flow can be shown without audio. */
export class DemoMic implements Mic {
  async start(): Promise<void> {}
  async stop(): Promise<Uint8Array> {
    return pcmToWav(new Uint8Array(32_000));
  }
}
