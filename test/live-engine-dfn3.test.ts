import { describe, it, expect } from 'vitest';
import { LiveEngine } from '../src/live/engine.js';
import { MockCaptureAdapter } from '../src/live/mock-adapter.js';
import { sensibel8 } from '../src/beamformer/geometry.js';
import type { BeamOutput, LiveConfig } from '../src/live/types.js';
import type { Dfn3Session } from '../src/live/dfn3-cleaner.js';

const GEOM = sensibel8(0.04);

/** An identity stub DFN3 session (no real ONNX needed). */
const identitySession: Dfn3Session = { run: (frame, states) => ({ out: frame, states }) };

async function run(cleaning: LiveConfig['cleaning']): Promise<BeamOutput[]> {
  const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 30, blockSize: 512, freqHz: 1500 });
  const engine = new LiveEngine(mock, { geom: GEOM, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90, ...(cleaning ? { cleaning } : {}) });
  const outs: BeamOutput[] = [];
  engine.onOutput((o) => outs.push(o));
  await engine.start();
  return outs;
}

describe('LiveEngine dfn3 cleaning', () => {
  it('engine:"dfn3" with a session runs and reports cleaning.engine = "dfn3"', async () => {
    const outs = await run({ engine: 'dfn3', dfn3Session: identitySession });
    expect(outs.length).toBeGreaterThan(0);
    const last = outs.at(-1)!;
    expect(last.cleaning).toBeDefined();
    expect(last.cleaning!.engine).toBe('dfn3');
    expect(Number.isFinite(last.rmsDb)).toBe(true);
  });

  it('engine:"dfn3" WITHOUT a session falls back to the gate denoiser (never crashes)', async () => {
    const outs = await run({ engine: 'dfn3' }); // no dfn3Session → onnxruntime/model unavailable
    expect(outs.length).toBeGreaterThan(0);
    expect(outs.at(-1)!.cleaning!.engine).toBe('gate'); // fell back, honestly reported
  });

  it('absent cleaning emits no cleaning field (byte-identical)', async () => {
    const outs = await run(undefined);
    for (const o of outs) expect('cleaning' in o).toBe(false);
  });
});
