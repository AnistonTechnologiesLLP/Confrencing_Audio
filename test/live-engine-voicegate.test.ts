import { describe, it, expect } from 'vitest';
import { LiveEngine } from '../src/live/engine.js';
import { MockCaptureAdapter } from '../src/live/mock-adapter.js';
import { sensibel8 } from '../src/beamformer/geometry.js';
import type { BeamOutput, LiveConfig } from '../src/live/types.js';

const GEOM = sensibel8(0.04);

async function run(extra: Partial<LiveConfig>, blocks = 20): Promise<BeamOutput[]> {
  const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks, blockSize: 512, freqHz: 1000 });
  const engine = new LiveEngine(mock, { geom: GEOM, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90, ...extra });
  const outs: BeamOutput[] = [];
  engine.onOutput((o) => outs.push(o));
  await engine.start();
  return outs;
}

describe('LiveEngine voice-gate + band-limit wiring', () => {
  it('absent voiceGate + bandLimit emits no voiceGate field (byte-identical shape)', async () => {
    const outs = await run({});
    expect(outs.length).toBeGreaterThan(0);
    for (const o of outs) expect('voiceGate' in o).toBe(false);
  });

  it('voiceGate config emits { open, reductionDb, score } and runs without throwing', async () => {
    const outs = await run({ voiceGate: {} });
    expect(outs.length).toBeGreaterThan(0);
    const last = outs.at(-1)!;
    expect(last.voiceGate).toBeDefined();
    expect(typeof last.voiceGate!.open).toBe('boolean');
    expect(typeof last.voiceGate!.reductionDb).toBe('number');
    expect(typeof last.voiceGate!.score).toBe('number');
    expect(last.voiceGate!.score).toBeGreaterThanOrEqual(0);
    expect(last.voiceGate!.score).toBeLessThanOrEqual(1);
    expect(last.voiceGate!.reductionDb).toBeGreaterThanOrEqual(0);
    // open ⇔ ~no reduction; closed ⇔ real reduction
    if (last.voiceGate!.open) expect(last.voiceGate!.reductionDb).toBeLessThan(6);
    else expect(last.voiceGate!.reductionDb).toBeGreaterThan(0);
  });

  it('composes agc + peq + voiceGate without throwing and emits both telemetry fields', async () => {
    const outs = await run({
      agc: { targetDb: -20 },
      peq: { bands: [{ type: 'bell', freqHz: 1000, gainDb: 6, q: 1 }] },
      voiceGate: {},
    });
    expect(outs.length).toBeGreaterThan(0);
    const last = outs.at(-1)!;
    expect(last.agc).toBeDefined();
    expect(last.voiceGate).toBeDefined();
    expect(Number.isFinite(last.rmsDb)).toBe(true);
  });

  it('bandLimit config runs, attenuates out-of-band energy, and adds no BeamOutput field', async () => {
    // a 1 kHz beam tone; a low-pass at 400 Hz should drop it hard vs no band-limit
    const ref = await run({});
    const lp = await run({ bandLimit: { lowpassHz: 400 } });
    const refRms = ref.at(-1)!.rmsDb;
    const lpRms = lp.at(-1)!.rmsDb;
    expect(lpRms).toBeLessThan(refRms - 6); // 1 kHz tone strongly attenuated below a 400 Hz LP
    for (const o of lp) expect('bandLimit' in o).toBe(false); // band-limit has no telemetry field
  });
});
