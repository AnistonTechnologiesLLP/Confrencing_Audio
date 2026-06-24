/**
 * A {@link CaptureAdapter} driven by the host instead of an internal loop: `start()`
 * registers the `onBlock` callback and resolves immediately; the host then calls
 * `push(channels)` to feed one de-interleaved block at a time (e.g. from a browser
 * `requestAnimationFrame` loop, or a test). Pure, zero-dep, browser-safe — the live
 * core's synthetic-input driver for the in-browser visualizer.
 */
import type { CaptureAdapter, CaptureDevice, CaptureStartOptions } from './types.js';

export class ManualCaptureAdapter implements CaptureAdapter {
  private readonly deviceName: string;
  private readonly channels: number;
  private cb: ((channels: Float32Array[], sampleRate: number) => void) | null = null;
  private sampleRate = 44100;
  private _running = false;

  constructor(opts: { deviceName?: string; channels: number }) {
    this.deviceName = opts.deviceName ?? 'MANUAL';
    this.channels = opts.channels;
  }

  enumerate(): Promise<CaptureDevice[]> {
    return Promise.resolve([
      { id: 'manual-0', name: this.deviceName, maxInputChannels: this.channels, defaultSampleRate: 44100 },
    ]);
  }

  start(opts: CaptureStartOptions): Promise<void> {
    this.cb = opts.onBlock;
    this.sampleRate = opts.sampleRate;
    this._running = true;
    return Promise.resolve();
  }

  /** Feed one block of de-interleaved channels to the engine. No-op unless running. */
  push(channels: Float32Array[]): void {
    if (this._running && this.cb !== null) this.cb(channels, this.sampleRate);
  }

  get running(): boolean {
    return this._running;
  }

  stop(): Promise<void> {
    this._running = false;
    this.cb = null;
    return Promise.resolve();
  }
}
