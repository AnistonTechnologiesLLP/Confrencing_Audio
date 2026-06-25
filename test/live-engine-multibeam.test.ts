import { describe, it, expect } from 'vitest';
import { LiveEngine } from '../src/live/engine.js';
import { MockCaptureAdapter } from '../src/live/mock-adapter.js';
import { sensibel8 } from '../src/beamformer/geometry.js';
import type { BeamOutput, LiveConfig } from '../src/live/types.js';

const GEOM = sensibel8(0.04);
async function run(extra: Partial<LiveConfig>): Promise<BeamOutput[]> {
  const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 40, blockSize: 512, freqHz: 1500 });
  const engine = new LiveEngine(mock, {
    geom: GEOM, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 0,
    autoSteer: { mode: 'follow', sector: { centerDeg: 90, halfWidthDeg: 80 }, detectionHops: 2 },
    ...extra,
  });
  const outs: BeamOutput[] = [];
  engine.onOutput((o) => outs.push(o));
  await engine.start();
  return outs;
}

describe('LiveEngine multi-beam mode', () => {
  it('absent multiBeam emits no multiBeam field (byte-identical)', async () => {
    const outs = await run({});
    for (const o of outs) expect('multiBeam' in o).toBe(false);
  });

  it('multiBeam mode runs, emits mono + slots/gates, and tracks the source', async () => {
    const outs = await run({ multiBeam: { nBeams: 3 } });
    expect(outs.length).toBeGreaterThan(0);
    const last = outs.at(-1)!;
    expect(last.multiBeam).toBeDefined();
    expect(last.multiBeam!.slots.length).toBe(3);
    expect(last.multiBeam!.gates.length).toBe(3);
    expect(Number.isFinite(last.rmsDb)).toBe(true);
    expect(last.mono.length).toBe(512);
    // at least one slot picked up the 90° source over the run
    const sawSource = outs.some((o) => o.multiBeam!.slots.some((s) => s.azimuthDeg !== null && Math.abs((s.azimuthDeg) - 90) < 30));
    expect(sawSource).toBe(true);
  });
});
