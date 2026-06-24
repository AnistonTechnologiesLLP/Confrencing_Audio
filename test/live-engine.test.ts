import { describe, it, expect } from 'vitest';
import { MockCaptureAdapter } from '../src/live/mock-adapter.js';
import { StreamingDelaySumBeam } from '../src/live/beam.js';
import { LiveEngine } from '../src/live/engine.js';
import { sensibel8 } from '../src/beamformer/geometry.js';
import * as live from '../src/live/index.js';

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

describe('live barrel', () => {
  it('exports the public surface', () => {
    expect(typeof live.LiveEngine).toBe('function');
    expect(typeof live.MockCaptureAdapter).toBe('function');
    expect(typeof live.StreamingDelaySumBeam).toBe('function');
    expect(typeof live.LevelMeter).toBe('function');
    expect(typeof live.directionUnit).toBe('function');
  });
});

describe('LiveEngine auto-steer', () => {
  it('follow mode re-aims the beam toward a synthetic source', async () => {
    const geom = sensibel8(0.04);
    const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 30, blockSize: 512, freqHz: 1500 });
    const engine = new LiveEngine(mock, {
      geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 0, // start pointed away
      autoSteer: { mode: 'follow', sector: { centerDeg: 90, halfWidthDeg: 60 }, detectionHops: 2 },
    });
    let last: number | undefined;
    let detectedSeen = false;
    engine.onOutput((o) => {
      last = o.azimuthDeg;
      if (o.detected && o.detected.azimuths.length > 0) detectedSeen = true;
    });
    await engine.start();
    expect(detectedSeen).toBe(true);
    // the beam ended up aimed near the 90° source (within a grid step or two)
    expect(Math.min(Math.abs((last ?? 0) - 90), 360 - Math.abs((last ?? 0) - 90))).toBeLessThanOrEqual(6);
  });

  it('manual mode leaves the beam static (no DOA steering)', async () => {
    const geom = sensibel8(0.04);
    const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 10, blockSize: 512, freqHz: 1500 });
    const engine = new LiveEngine(mock, { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 0 });
    let last = -1;
    engine.onOutput((o) => { last = o.azimuthDeg; });
    await engine.start();
    expect(last).toBe(0); // unchanged
  });
});

describe('LiveEngine cleaning', () => {
  it('absent cleaning emits no cleaning field (byte-identical to Phase 2)', async () => {
    const geom = sensibel8(0.04);
    const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 3, blockSize: 256, freqHz: 1500 });
    const engine = new LiveEngine(mock, { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90 });
    let cleaningField: unknown = 'unset';
    engine.onOutput((o) => { cleaningField = (o as { cleaning?: unknown }).cleaning; });
    await engine.start();
    expect(cleaningField).toBeUndefined();
  });

  it('omlsa cleaning: BeamOutput.cleaning reflects the engine config', async () => {
    const geom = sensibel8(0.04);
    const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 60, blockSize: 256, freqHz: 1500 });
    const engine = new LiveEngine(mock, {
      geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90,
      cleaning: { engine: 'omlsa' },
    });
    const cleaningFields: Array<{ engine: string; preserved: boolean }> = [];
    let onRms = 0;
    engine.onOutput((o) => {
      if (o.cleaning !== undefined) cleaningFields.push(o.cleaning);
      // accumulate the last block's RMS
      let s = 0;
      for (const v of o.mono) s += v * v;
      onRms = Math.sqrt(s / o.mono.length);
    });
    await engine.start();
    expect(cleaningFields.length).toBeGreaterThan(0);
    for (const f of cleaningFields) {
      expect(f.engine).toBe('omlsa');
      expect(f.preserved).toBe(false);
    }
    // NR never amplifies: cleaned tail RMS ≤ off-path RMS + tiny epsilon
    // (the off-path produces a beam-coherent sinusoid; NR ≤ passthrough)
    const offMock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 60, blockSize: 256, freqHz: 1500 });
    const offEngine = new LiveEngine(offMock, { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90 });
    let offRms = 0;
    offEngine.onOutput((o) => {
      let s = 0;
      for (const v of o.mono) s += v * v;
      offRms = Math.sqrt(s / o.mono.length);
    });
    await offEngine.start();
    expect(onRms).toBeLessThanOrEqual(offRms + 1e-6);
  });

  it('omlsa with preserveLevel:true sets preserved=true in BeamOutput.cleaning', async () => {
    const geom = sensibel8(0.04);
    const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 3, blockSize: 256, freqHz: 1500 });
    const engine = new LiveEngine(mock, {
      geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90,
      cleaning: { engine: 'omlsa', preserveLevel: true },
    });
    let preserved: boolean | undefined;
    engine.onOutput((o) => { if (o.cleaning !== undefined) preserved = o.cleaning.preserved; });
    await engine.start();
    expect(preserved).toBe(true);
  });
});
