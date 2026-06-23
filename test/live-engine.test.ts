import { describe, it, expect } from 'vitest';
import { MockCaptureAdapter } from '../src/live/mock-adapter.js';
import { StreamingDelaySumBeam } from '../src/live/beam.js';
import { LiveEngine } from '../src/live/engine.js';
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
        expect(channels[0]!.length).toBe(256);
      },
    });
    expect(seen).toEqual([8, 8, 8]); // 3 blocks, 8 channels each
  });

  it('emits a plane wave a steered beam reinforces', async () => {
    const geom = sensibel8(0.04);
    const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 1, blockSize: 4096, freqHz: 1500 });
    const beam = new StreamingDelaySumBeam(geom, 44100);
    let aligned: Float32Array = new Float32Array(0);
    let away: Float32Array = new Float32Array(0);
    await mock.start({
      deviceName: 'MOCK-8', channels: 8, sampleRate: 44100,
      onBlock: (channels) => {
        beam.setLook(90, 90); aligned = beam.process(channels);
        beam.reset(); beam.setLook(270, 90); away = beam.process(channels);
      },
    });
    expect(rms(aligned.subarray(64))).toBeGreaterThan(rms(away.subarray(64)) * 1.5);
  });
});

describe('LiveEngine', () => {
  it('produces BeamOutput per block, reinforcing the steered direction', async () => {
    const geom = sensibel8(0.04);
    const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 1, blockSize: 4096, freqHz: 1500 });
    const engine = new LiveEngine(mock, { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90 });
    const outs: number[] = [];
    let mono: Float32Array = new Float32Array(0);
    engine.onOutput((o) => { outs.push(o.rmsDb); mono = o.mono; expect(o.azimuthDeg).toBe(90); });
    await engine.start();
    expect(outs.length).toBe(1);
    expect(rms(mono.subarray(64))).toBeGreaterThan(0.3); // coherent sum of a unit sinusoid
  });

  it('re-steers via setLook without mutating prior output', async () => {
    const geom = sensibel8(0.04);
    const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 1, blockSize: 4096, freqHz: 1500 });
    const engine = new LiveEngine(mock, { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 270 });
    let r = 1;
    engine.onOutput((o) => { r = rms(o.mono.subarray(64)); });
    await engine.start(); // steered away (270) → low
    expect(engine.azimuthDeg).toBe(270);
    const low = r;
    engine.setLook(90);
    await engine.start(); // now steered at the source → high
    expect(r).toBeGreaterThan(low * 1.5);
  });
});
