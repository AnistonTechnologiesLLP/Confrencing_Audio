import { describe, it, expect } from 'vitest';
import { ManualCaptureAdapter } from '../src/live/manual-adapter.js';

describe('ManualCaptureAdapter', () => {
  it('start() registers onBlock and push() feeds it (channels + sampleRate)', async () => {
    const a = new ManualCaptureAdapter({ channels: 8 });
    const got: { n: number; sr: number }[] = [];
    await a.start({ deviceName: 'X', channels: 8, sampleRate: 32000, onBlock: (ch, sr) => got.push({ n: ch.length, sr }) });
    expect(a.running).toBe(true);
    a.push(Array.from({ length: 8 }, () => new Float32Array(4)));
    a.push(Array.from({ length: 8 }, () => new Float32Array(4)));
    expect(got).toEqual([{ n: 8, sr: 32000 }, { n: 8, sr: 32000 }]);
  });

  it('push() is a no-op before start and after stop', async () => {
    const a = new ManualCaptureAdapter({ channels: 8 });
    let calls = 0;
    a.push([new Float32Array(1)]); // before start — ignored
    await a.start({ deviceName: 'X', channels: 8, sampleRate: 44100, onBlock: () => { calls++; } });
    a.push([new Float32Array(1)]);
    await a.stop();
    expect(a.running).toBe(false);
    a.push([new Float32Array(1)]); // after stop — ignored
    expect(calls).toBe(1);
  });

  it('enumerate() reports the manual device', async () => {
    const a = new ManualCaptureAdapter({ deviceName: 'MOCK', channels: 8 });
    const devs = await a.enumerate();
    expect(devs[0]!.name).toBe('MOCK');
    expect(devs[0]!.maxInputChannels).toBe(8);
  });
});
