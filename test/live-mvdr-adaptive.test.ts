import { describe, it, expect } from 'vitest';
import { StreamingCovarianceAccumulator } from '../src/live/covariance.js';
import { FreqDomainBeam } from '../src/live/freq-domain-beam.js';
import { LiveEngine } from '../src/live/engine.js';
import { MockCaptureAdapter } from '../src/live/mock-adapter.js';
import { planeWaveChannels } from '../src/live/mock-adapter.js';
import { sensibel8, type Complex } from '../src/beamformer/geometry.js';
import { steeringVector } from '../src/beamformer/beamformer.js';
import { bearingDirection } from '../src/beamformer/beamformer.js';
import type { BeamOutput } from '../src/live/types.js';

const FS = 44100;
const GEOM = sensibel8(0.04);

/** A block of deterministic white-ish noise on all M channels. */
function noiseBlock(m: number, n: number, seed: number): Float32Array[] {
  const chans: Float32Array[] = [];
  let s = seed >>> 0;
  for (let c = 0; c < m; c++) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      s = (1664525 * s + 1013904223) >>> 0;
      out[i] = (s / 0xffffffff) * 2 - 1;
    }
    chans.push(out);
  }
  return chans;
}

describe('StreamingCovarianceAccumulator — noise gate + band exposure (A3b)', () => {
  it('gate=false does not fold the covariance (framesSeen / warmup never advance)', () => {
    const cov = new StreamingCovarianceAccumulator({ channels: 8, sampleRate: FS });
    for (let i = 0; i < 60; i++) cov.accumulate(noiseBlock(8, 512, i + 1), false); // all "speech" → never fold
    expect(cov.snapshot()).toBe(null); // still warming up (no frames folded)
  });

  it('gate=true folds the covariance and the snapshot exposes the rfft band-bin indices', () => {
    const cov = new StreamingCovarianceAccumulator({ channels: 8, sampleRate: FS });
    for (let i = 0; i < 60; i++) cov.accumulate(noiseBlock(8, 512, i + 1), true); // noise frames → fold
    const snap = cov.snapshot();
    expect(snap).not.toBe(null);
    expect(snap!.band.length).toBe(snap!.freqs.length); // one bin index per band frequency
    expect(snap!.band.every((k) => Number.isInteger(k) && k >= 0)).toBe(true);
    // the covariance has real energy on the diagonal (auto-power)
    expect(snap!.rBand[0]![0]![0]!.re).toBeGreaterThan(0);
  });
});

describe('FreqDomainBeam.setMeasured (data-adaptive MVDR)', () => {
  it('setMeasured changes the weights and setMeasured(null) reverts to superdirective', () => {
    const beam = new FreqDomainBeam(GEOM, FS);
    beam.setLook(0, 90);
    const superHash = beam.debugWeightsHash();
    const M = GEOM.nChannels;
    // a synthetic rank-1 interferer covariance at 70° across the whole DOA band (bins ~10..85 at frame 1024)
    const bandBins: number[] = [];
    const cov: Complex[][][] = [];
    for (let k = 10; k <= 85; k++) {
      const f = (k * FS) / 1024;
      const a = steeringVector(GEOM, bearingDirection(70).unit, f);
      bandBins.push(k);
      cov.push(
        Array.from({ length: M }, (_r, i) =>
          Array.from({ length: M }, (_c, j) => ({
            re: 50 * (a[i]!.re * a[j]!.re + a[i]!.im * a[j]!.im) + (i === j ? 1e-2 : 0),
            im: 50 * (a[i]!.im * a[j]!.re - a[i]!.re * a[j]!.im),
          })),
        ),
      );
    }
    beam.setMeasured({ bandBins, cov });
    expect(beam.debugWeightsHash()).not.toBe(superHash); // measured-R changed the band-bin weights
    beam.setMeasured(null);
    expect(beam.debugWeightsHash()).toBe(superHash); // reverted to analytic superdirective
  });
});

describe('LiveEngine beam:"mvdr"', () => {
  async function run(beam: 'freqDomain' | 'mvdr'): Promise<BeamOutput[]> {
    const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 40, blockSize: 512, freqHz: 1500 });
    const engine = new LiveEngine(mock, {
      geom: GEOM, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90, beam,
      autoSteer: { mode: 'follow', sector: { centerDeg: 90, halfWidthDeg: 80 }, detectionHops: 2 },
    });
    const outs: BeamOutput[] = [];
    engine.onOutput((o) => outs.push(o));
    await engine.start();
    return outs;
  }

  it('runs the data-adaptive MVDR beam (brings its own noise-gated covariance) without throwing', async () => {
    const outs = await run('mvdr');
    expect(outs.length).toBeGreaterThan(0);
    const last = outs.at(-1)!;
    expect(Number.isFinite(last.rmsDb)).toBe(true);
    expect(last.mono.length).toBe(512);
    void planeWaveChannels; // (helper available; the mock already drives a plane wave)
  });

  it('emits the same BeamOutput shape as the plain freqDomain beam (mvdr is a beam mode, not a new field)', async () => {
    const fd = await run('freqDomain');
    const mv = await run('mvdr');
    expect(Object.keys(mv.at(-1)!).sort()).toEqual(Object.keys(fd.at(-1)!).sort());
  });
});
