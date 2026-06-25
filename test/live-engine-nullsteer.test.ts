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

  it('null at the source azimuth meaningfully suppresses output (engine-level suppression proof)', async () => {
    // Source is at 90°; look is at 0°. An exclusion null at 90° should deeply suppress the off-axis source.
    // Measured: noNull last-block rmsDb ≈ -15.1, null last-block rmsDb ≈ -80.9 → delta ≈ -65.8 dB.
    const noNullOuts = await run({ beam: 'freqDomain' });
    const nullOuts = await run({ beam: 'freqDomain', nulls: { exclusionDeg: [90] } });
    const noNullRmsDb = noNullOuts.at(-1)!.rmsDb;
    const nullRmsDb = nullOuts.at(-1)!.rmsDb;
    // Assert null run is at least 6 dB quieter (measured delta is ~65 dB, so this is very conservative but unambiguous).
    expect(nullRmsDb).toBeLessThan(noNullRmsDb - 6);
  });
});
