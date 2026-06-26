import { describe, it, expect } from 'vitest';
import { estimateRtfGevd, rtfCosine, RTF_DOA_MIN_COS } from '../src/live/rtf-mvdr.js';
import { LiveEngine } from '../src/live/engine.js';
import { MockCaptureAdapter } from '../src/live/mock-adapter.js';
import { sensibel8, complex, type Complex } from '../src/beamformer/geometry.js';
import { steeringVector, bearingDirection } from '../src/beamformer/beamformer.js';
import type { BeamOutput } from '../src/live/types.js';

const GEOM = sensibel8(0.04);

/** A rank-1 target covariance `P·a aᴴ + εI` from a source at `deg` (+ identity noise). */
function rank1(deg: number, f: number, P: number): Complex[][] {
  const a = steeringVector(GEOM, bearingDirection(deg).unit, f);
  const M = GEOM.nChannels;
  return Array.from({ length: M }, (_r, i) =>
    Array.from({ length: M }, (_c, j) =>
      complex(P * (a[i]!.re * a[j]!.re + a[i]!.im * a[j]!.im) + (i === j ? 1e-3 : 0), P * (a[i]!.im * a[j]!.re - a[i]!.re * a[j]!.im)),
    ),
  );
}

function identity(): Complex[][] {
  const M = GEOM.nChannels;
  return Array.from({ length: M }, (_r, i) => Array.from({ length: M }, (_c, j) => complex(i === j ? 1 : 0, 0)));
}

describe('estimateRtfGevd / rtfCosine (RTF-MVDR core)', () => {
  it('recovers the target direction from a rank-1 target vs white noise', () => {
    const f = 1500;
    const target = rank1(60, f, 100);
    const h = estimateRtfGevd(target, identity(), 1e-3);
    const aTrue = steeringVector(GEOM, bearingDirection(60).unit, f);
    const aOther = steeringVector(GEOM, bearingDirection(150).unit, f);
    expect(rtfCosine(h, aTrue)).toBeGreaterThan(0.99); // the RTF locks onto the actual source manifold
    expect(rtfCosine(h, aTrue)).toBeGreaterThan(rtfCosine(h, aOther)); // ...far more than another bearing
    expect(rtfCosine(h, aTrue)).toBeGreaterThan(RTF_DOA_MIN_COS); // would pass the cross-check gate
  });

  it('returns a unit-norm RTF', () => {
    const h = estimateRtfGevd(rank1(20, 2000, 50), identity(), 1e-3);
    let n = 0;
    for (const c of h) n += c.re * c.re + c.im * c.im;
    expect(Math.sqrt(n)).toBeCloseTo(1, 6);
  });

  it('a degenerate (zero) target falls back to the trivial RTF', () => {
    const M = GEOM.nChannels;
    const zero = Array.from({ length: M }, () => Array.from({ length: M }, () => complex(0, 0)));
    const h = estimateRtfGevd(zero, identity(), 1e-3);
    expect(h[0]!.re).toBeCloseTo(1, 6); // e0
    for (let i = 1; i < M; i++) expect(h[i]!.re).toBeCloseTo(0, 6);
  });
});

describe('LiveEngine beam:"rtfMvdr"', () => {
  async function run(beam: 'freqDomain' | 'rtfMvdr'): Promise<BeamOutput[]> {
    const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 60, blockSize: 512, freqHz: 1500 });
    const engine = new LiveEngine(mock, {
      geom: GEOM, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90, beam,
      autoSteer: { mode: 'follow', sector: { centerDeg: 90, halfWidthDeg: 80 }, detectionHops: 2 },
    });
    const outs: BeamOutput[] = [];
    engine.onOutput((o) => outs.push(o));
    await engine.start();
    return outs;
  }

  it('runs the RTF-MVDR beam (target + noise gated covariances) without throwing', async () => {
    const outs = await run('rtfMvdr');
    expect(outs.length).toBeGreaterThan(0);
    const last = outs.at(-1)!;
    expect(Number.isFinite(last.rmsDb)).toBe(true);
    expect(last.mono.length).toBe(512);
    for (const v of last.mono) expect(Number.isFinite(v)).toBe(true);
  });

  it('emits the same BeamOutput shape as the plain freqDomain beam', async () => {
    const fd = await run('freqDomain');
    const rt = await run('rtfMvdr');
    expect(Object.keys(rt.at(-1)!).sort()).toEqual(Object.keys(fd.at(-1)!).sort());
  });
});
