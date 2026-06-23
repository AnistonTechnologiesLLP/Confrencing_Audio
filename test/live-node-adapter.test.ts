// test/live-node-adapter.test.ts
import { describe, it, expect } from 'vitest';
import { NodeCaptureAdapter } from '../src/live-node/naudiodon-adapter.js';

/** A minimal fake of the naudiodon2 surface the adapter uses. */
function fakeNaudiodon(emit?: (push: (buf: Buffer) => void) => void) {
  return {
    getDevices: () => [
      { id: 0, name: 'Some Other Device', maxInputChannels: 2, defaultSampleRate: 48000 },
      { id: 7, name: 'Digital Audio Interface (SB-POLARIS)', maxInputChannels: 8, defaultSampleRate: 44100 },
    ],
    AudioIO: class {
      private cb: ((buf: Buffer) => void) | null = null;
      constructor(public cfg: unknown) {}
      on(_event: string, cb: (buf: Buffer) => void) { this.cb = cb; }
      start() { if (emit && this.cb) emit(this.cb); }
      quit(_m: string, done: () => void) { done(); }
    },
    SampleFormat16Bit: 16,
  };
}

describe('NodeCaptureAdapter', () => {
  it('enumerates devices by name', async () => {
    const a = new NodeCaptureAdapter({ naudiodon: fakeNaudiodon() });
    const devices = await a.enumerate();
    expect(devices.find((d) => d.name.includes('SB-POLARIS'))?.maxInputChannels).toBe(8);
  });

  it('selects the device by name substring and de-interleaves frames', async () => {
    // One frame of 8 ch, value = channel index (int16), little-endian.
    const emit = (push: (b: Buffer) => void) => {
      const frames = 4, ch = 8;
      const buf = Buffer.alloc(frames * ch * 2);
      for (let f = 0; f < frames; f++) for (let c = 0; c < ch; c++) buf.writeInt16LE(c * 1000, (f * ch + c) * 2);
      push(buf);
    };
    const a = new NodeCaptureAdapter({ naudiodon: fakeNaudiodon(emit) });
    let got: Float32Array[] = [];
    await a.start({
      deviceName: 'SB-POLARIS', channels: 8, sampleRate: 44100,
      onBlock: (channels) => { got = channels; },
    });
    expect(got.length).toBe(8);
    expect(got[0]!.length).toBe(4);
    // channel 3 carried 3000/32768; channel 0 carried 0
    expect(got[3]![0]!).toBeCloseTo(3000 / 32768, 4);
    expect(got[0]![0]!).toBeCloseTo(0, 6);
  });

  it('throws a clear install hint when naudiodon2 is missing', async () => {
    const a = new NodeCaptureAdapter({ naudiodon: null });
    await expect(a.enumerate()).rejects.toThrow(/naudiodon2/);
  });
});
