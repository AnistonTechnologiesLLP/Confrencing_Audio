import { describe, it, expect } from 'vitest';
import { LiveEngine } from '../src/live/engine.js';
import { MockCaptureAdapter } from '../src/live/mock-adapter.js';
import { sensibel8 } from '../src/beamformer/geometry.js';
import type { BeamOutput, LiveConfig } from '../src/live/types.js';

const GEOM = sensibel8(0.04);
async function run(extra: Partial<LiveConfig>): Promise<BeamOutput[]> {
  const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 30, blockSize: 512, freqHz: 1500 });
  const engine = new LiveEngine(mock, { geom: GEOM, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 0, ...extra });
  const outs: BeamOutput[] = [];
  engine.onOutput((o) => outs.push(o));
  await engine.start();
  return outs;
}

describe('LiveEngine null-steering', () => {
  it('emits no activeNulls when nulls config is absent (byte-identical)', async () => {
    const outs = await run({ beam: 'freqDomain' });
    for (const o of outs) expect('activeNulls' in o).toBe(false);
  });

  it('applies a configured exclusion null on the freqDomain beam and reports it', async () => {
    const outs = await run({ beam: 'freqDomain', nulls: { exclusionDeg: [90] } });
    const last = outs.at(-1)!;
    expect(last.activeNulls).toBeDefined();
    expect(last.activeNulls!.some((a) => Math.abs(a - 90) < 8)).toBe(true);
  });

  it('ignores nulls config on the delay-sum beam (no throw, no activeNulls)', async () => {
    const outs = await run({ nulls: { exclusionDeg: [90] } }); // delaySum default
    expect(outs.length).toBeGreaterThan(0);
    for (const o of outs) expect('activeNulls' in o).toBe(false);
  });
});
