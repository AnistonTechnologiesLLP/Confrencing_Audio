// src/live-node/naudiodon-adapter.ts
/**
 * Node-only capture backend for the real array (PortAudio via the optional native
 * addon `naudiodon2`). Lazy-imported so the package keeps zero hard runtime deps;
 * if the addon is absent, methods throw a clear install hint. Device is selected
 * by NAME (indices re-enumerate per process).
 */
import type { CaptureAdapter, CaptureDevice, CaptureStartOptions } from '../live/types.js';

interface NaudiodonLike {
  getDevices(): Array<{ id: number; name: string; maxInputChannels: number; defaultSampleRate: number }>;
  AudioIO: new (cfg: unknown) => {
    on(event: 'data', cb: (buf: Buffer) => void): void;
    start(): void;
    quit(mode: string, done: () => void): void;
  };
  SampleFormat16Bit: number;
}

const INSTALL_HINT =
  'The Node live-capture backend needs the optional native addon "naudiodon2". ' +
  'Install it (and a C++ toolchain) with:  npm install naudiodon2';

export class NodeCaptureAdapter implements CaptureAdapter {
  private readonly injected: NaudiodonLike | null | undefined;
  private io: { quit(mode: string, done: () => void): void } | null = null;

  constructor(opts: { naudiodon?: unknown } = {}) {
    // `undefined` => lazy-load the real addon; `null`/object => test injection.
    this.injected = opts.naudiodon as NaudiodonLike | null | undefined;
  }

  private async load(): Promise<NaudiodonLike> {
    if (this.injected === null) throw new Error(INSTALL_HINT);
    if (this.injected !== undefined) return this.injected;
    try {
      // Computed specifier (`: string`, not a literal) so tsc treats this as a
      // dynamic any-import and does NOT require the optional native addon's types.
      const spec: string = 'naudiodon2';
      const mod = (await import(spec)) as unknown as NaudiodonLike;
      return mod;
    } catch {
      throw new Error(INSTALL_HINT);
    }
  }

  async enumerate(): Promise<CaptureDevice[]> {
    const na = await this.load();
    return na.getDevices()
      .filter((d) => d.maxInputChannels > 0)
      .map((d) => ({ id: String(d.id), name: d.name, maxInputChannels: d.maxInputChannels, defaultSampleRate: d.defaultSampleRate }));
  }

  async start(opts: CaptureStartOptions): Promise<void> {
    const na = await this.load();
    const dev = na.getDevices().find((d) => d.maxInputChannels > 0 && d.name.includes(opts.deviceName));
    if (!dev) throw new Error(`No input device whose name contains ${JSON.stringify(opts.deviceName)}`);
    const io = new na.AudioIO({
      inOptions: {
        channelCount: opts.channels,
        sampleFormat: na.SampleFormat16Bit,
        sampleRate: opts.sampleRate,
        deviceId: dev.id,
        closeOnError: true,
      },
    });
    this.io = io;
    io.on('data', (buf: Buffer) => {
      const ch = opts.channels;
      const frames = Math.floor(buf.length / 2 / ch);
      const channels: Float32Array[] = Array.from({ length: ch }, () => new Float32Array(frames));
      for (let f = 0; f < frames; f++) {
        for (let c = 0; c < ch; c++) {
          channels[c]![f] = buf.readInt16LE((f * ch + c) * 2) / 32768;
        }
      }
      opts.onBlock(channels, opts.sampleRate);
    });
    io.start();
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.io) return resolve();
      this.io.quit('flush', () => { this.io = null; resolve(); });
    });
  }
}
