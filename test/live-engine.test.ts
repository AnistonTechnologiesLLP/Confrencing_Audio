import { describe, it, expect } from 'vitest';
import { MockCaptureAdapter } from '../src/live/mock-adapter.js';
import { StreamingDelaySumBeam } from '../src/live/beam.js';
import { sensibel8 } from '../src/beamformer/geometry.js';

function rms(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
}

describe('MockCaptureAdapter', () => {
  it('enumerates a named device and emits multichannel blocks of the right shape', async () => {
    const mock = new MockCaptureAdapter({ deviceName: 'MOCK-8', channels: 8, blocks: 3, blockSize: 256 });
    const devices = await mock.enumerate();
    expect(devices.some((d) => d.name === 'MOCK-8' && d.maxInputChannels === 8)).toBe(true);

    const seen: number[] = [];
    await mock.start({
      deviceName: 'MOCK-8',
      channels: 8,
      sampleRate: 44100,
      onBlock: (channels) => {
        seen.push(channels.length);
        expect((channels as ArrayLike<any>[])[0]!.length).toBe(256);
      },
    });
    expect(seen).toEqual([8, 8, 8]); // 3 blocks, 8 channels each
  });

  it('emits a plane wave a steered beam reinforces', async () => {
    const geom = sensibel8(0.04);
    const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 1, blockSize: 4096, freqHz: 1500 });
    const beam = new StreamingDelaySumBeam(geom, 44100);
    let aligned: Float32Array | Float32Array<ArrayBufferLike> = new Float32Array(0);
    let away: Float32Array | Float32Array<ArrayBufferLike> = new Float32Array(0);
    await mock.start({
      deviceName: 'MOCK-8', channels: 8, sampleRate: 44100,
      onBlock: (channels) => {
        beam.setLook(90, 90); aligned = beam.process(channels as Float32Array[]) as Float32Array;
        beam.reset(); beam.setLook(270, 90); away = beam.process(channels as Float32Array[]) as Float32Array;
      },
    });
    expect(rms(aligned.subarray(64))).toBeGreaterThan(rms(away.subarray(64)) * 1.5);
  });
});
