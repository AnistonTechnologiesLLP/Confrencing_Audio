// test/live-node-adapter.test.ts
import { describe, it, expect } from 'vitest';
import { NodeCaptureAdapter } from '../src/live-node/naudiodon-adapter.js';
import { NodeOutputSink } from '../src/live-node/output-sink.js';

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

/** A minimal fake of the naudiodon2 OUTPUT surface, recording start() + write() buffers. */
function fakeOutputNaudiodon() {
  const writes: Buffer[] = [];
  const state = { started: false };
  const na = {
    AudioIO: class {
      constructor(public cfg: unknown) {}
      start() { state.started = true; }
      write(buf: Buffer) { writes.push(buf); }
      quit(_m: string, done: () => void) { done(); }
    },
    SampleFormat16Bit: 16,
  };
  return { na, writes, state };
}

describe('NodeOutputSink', () => {
  it('starts the output stream on start()', async () => {
    const { na, state } = fakeOutputNaudiodon();
    const sink = new NodeOutputSink({ naudiodon: na });
    await sink.start(44100);
    expect(state.started).toBe(true);
  });

  it('converts Float32 mono to clamped Int16LE samples on write()', async () => {
    const { na, writes } = fakeOutputNaudiodon();
    const sink = new NodeOutputSink({ naudiodon: na });
    await sink.start(44100);
    sink.write(new Float32Array([0, 1, -1, 0.5]));
    expect(writes.length).toBe(1);
    const buf = writes[0]!;
    const samples = [0, 1, 2, 3].map((i) => buf.readInt16LE(i * 2));
    expect(samples).toEqual([0, 32767, -32767, 16384]);
  });

  it('throws a clear install hint when naudiodon2 is missing', async () => {
    const sink = new NodeOutputSink({ naudiodon: null });
    await expect(sink.start(44100)).rejects.toThrow(/naudiodon2/);
  });
});
