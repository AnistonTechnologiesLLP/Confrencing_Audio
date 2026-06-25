import { describe, it, expect } from 'vitest';
import { LiveEngine } from '../src/live/engine.js';
import { MockCaptureAdapter } from '../src/live/mock-adapter.js';
import { sensibel8 } from '../src/beamformer/geometry.js';
import type { BeamOutput } from '../src/live/types.js';

describe('LiveEngine PEQ wiring', () => {
  it('emits no `peq` field when peq is absent (byte-identical shape)', async () => {
    const geom = sensibel8(0.04);
    const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 10, blockSize: 512, freqHz: 1000 });
    const engine = new LiveEngine(mock, { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90 });
    const outs: BeamOutput[] = [];
    engine.onOutput((o) => outs.push(o));
    await engine.start();
    expect(outs.length).toBeGreaterThan(0);
    for (const o of outs) expect('peq' in o).toBe(false);
  });

  it('shapes the mono when a PEQ band is configured (runs, changes level)', async () => {
    const geom = sensibel8(0.04);
    const mkMock = () => new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 20, blockSize: 512, freqHz: 1000 });

    const refOuts: BeamOutput[] = [];
    const ref = new LiveEngine(mkMock(), { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90 });
    ref.onOutput((o) => refOuts.push(o));
    await ref.start();

    const eqOuts: BeamOutput[] = [];
    const eq = new LiveEngine(mkMock(), {
      geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90,
      peq: { bands: [{ type: 'bell', freqHz: 1000, gainDb: 12, q: 1 }] },
    });
    eq.onOutput((o) => eqOuts.push(o));
    await eq.start();

    const refRms = refOuts.at(-1)!.rmsDb;
    const eqRms = eqOuts.at(-1)!.rmsDb;
    expect(Number.isFinite(eqRms)).toBe(true);
    // a +12 dB bell centred on the 1 kHz beam tone lifts the level
    expect(eqRms).toBeGreaterThan(refRms + 6);
  });
});
