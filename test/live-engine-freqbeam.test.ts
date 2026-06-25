import { describe, it, expect } from 'vitest';
import { LiveEngine } from '../src/live/engine.js';
import { MockCaptureAdapter } from '../src/live/mock-adapter.js';
import { sensibel8 } from '../src/beamformer/geometry.js';
import type { BeamOutput } from '../src/live/types.js';

const GEOM = sensibel8(0.04);

async function run(beam: 'delaySum' | 'freqDomain' | undefined): Promise<BeamOutput[]> {
  const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 30, blockSize: 512, freqHz: 1500 });
  const cfg = { geom: GEOM, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90, ...(beam ? { beam } : {}) };
  const engine = new LiveEngine(mock, cfg);
  const outs: BeamOutput[] = [];
  engine.onOutput((o) => outs.push(o));
  await engine.start();
  return outs;
}

describe('LiveEngine freqDomain beam mode', () => {
  it('runs with the freqDomain beam and emits mono toward the source', async () => {
    const outs = await run('freqDomain');
    expect(outs.length).toBeGreaterThan(0);
    const last = outs.at(-1)!;
    expect(Number.isFinite(last.rmsDb)).toBe(true);
    expect(last.mono.length).toBe(512);
  });

  it('default (delaySum) is unchanged — emits mono, same BeamOutput shape', async () => {
    const def = await run(undefined);
    const ds = await run('delaySum');
    expect(def.length).toBeGreaterThan(0);
    // both default and explicit delaySum produce identical-shaped output
    expect(Object.keys(def.at(-1)!).sort()).toEqual(Object.keys(ds.at(-1)!).sort());
  });
});
