// src/live-node/output-sink.ts
/** Minimal Node output: play a mono Float32 stream on the default device (naudiodon2). */
interface NaudiodonOut {
  AudioIO: new (cfg: unknown) => { start(): void; write(buf: Buffer): void; quit(mode: string, done: () => void): void };
  SampleFormat16Bit: number;
}

const INSTALL_HINT = 'Live playback needs the optional native addon "naudiodon2":  npm install naudiodon2';

export class NodeOutputSink {
  private readonly injected: NaudiodonOut | null | undefined;
  private io: { start(): void; write(buf: Buffer): void; quit(m: string, d: () => void): void } | null = null;

  constructor(opts: { naudiodon?: unknown } = {}) {
    this.injected = opts.naudiodon as NaudiodonOut | null | undefined;
  }

  private async load(): Promise<NaudiodonOut> {
    if (this.injected === null) throw new Error(INSTALL_HINT);
    if (this.injected !== undefined) return this.injected;
    try {
      const spec: string = 'naudiodon2'; // computed specifier: optional native addon, not a type dep
      return (await import(spec)) as unknown as NaudiodonOut;
    } catch {
      throw new Error(INSTALL_HINT);
    }
  }

  async start(sampleRate: number, deviceId?: number): Promise<void> {
    const na = await this.load();
    this.io = new na.AudioIO({
      outOptions: {
        channelCount: 1,
        sampleFormat: na.SampleFormat16Bit,
        sampleRate,
        closeOnError: true,
        ...(deviceId !== undefined ? { deviceId } : {}),
      },
    });
    this.io.start();
  }

  write(mono: Float32Array): void {
    if (!this.io) return;
    const buf = Buffer.alloc(mono.length * 2);
    for (let i = 0; i < mono.length; i++) {
      const v = Math.max(-1, Math.min(1, mono[i]!));
      buf.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    this.io.write(buf);
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.io) return resolve();
      this.io.quit('flush', () => { this.io = null; resolve(); });
    });
  }
}
