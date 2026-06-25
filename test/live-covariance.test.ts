import { describe, it, expect } from 'vitest';
import { StreamingCovarianceAccumulator } from '../src/live/covariance.js';
import { planeWaveChannels } from '../src/live/mock-adapter.js';
import { sensibel8 } from '../src/beamformer/geometry.js';

function feed(acc: StreamingCovarianceAccumulator, channels: Float32Array[], chunk: number): void {
  const n = channels[0]!.length;
  for (let s = 0; s < n; s += chunk) {
    const e = Math.min(s + chunk, n);
    acc.accumulate(channels.map((c) => c.subarray(s, e)));
  }
}

describe('StreamingCovarianceAccumulator', () => {
  it('is null until warmed up, then yields a Hermitian band covariance', () => {
    const acc = new StreamingCovarianceAccumulator({ channels: 8, sampleRate: 44100, warmupFrames: 4 });
    const chans = planeWaveChannels(sensibel8(0.04), 90, 1500, 8192, 0, 44100);
    expect(acc.snapshot()).toBeNull(); // nothing fed yet
    feed(acc, chans, 512);
    const snap = acc.snapshot();
    expect(snap).not.toBeNull();
    const { rBand } = snap!;
    expect(rBand.length).toBeGreaterThan(0); // some band bins
    // Hermitian: R[f][i][j] == conj(R[f][j][i]); diagonal real & ≥ 0
    const f = 0;
    for (let i = 0; i < 8; i++) {
      expect(rBand[f]![i]![i]!.im).toBeCloseTo(0, 6);
      expect(rBand[f]![i]![i]!.re).toBeGreaterThanOrEqual(0);
      for (let j = 0; j < 8; j++) {
        expect(rBand[f]![i]![j]!.re).toBeCloseTo(rBand[f]![j]![i]!.re, 6);
        expect(rBand[f]![i]![j]!.im).toBeCloseTo(-rBand[f]![j]![i]!.im, 6);
      }
    }
  });

  it('bridges odd block sizes to the same result as 512-sample blocks', () => {
    const chans = planeWaveChannels(sensibel8(0.04), 45, 1200, 8192, 0, 44100);
    const a = new StreamingCovarianceAccumulator({ channels: 8, sampleRate: 44100, warmupFrames: 1 });
    const b = new StreamingCovarianceAccumulator({ channels: 8, sampleRate: 44100, warmupFrames: 1 });
    feed(a, chans, 512); // hop-aligned
    feed(b, chans, 300); // ragged
    const ra = a.snapshot()!.rBand;
    const rb = b.snapshot()!.rBand;
    // same number of hops processed → identical covariance
    expect(a.framesSeen).toBe(b.framesSeen);
    expect(ra[0]![0]![0]!.re).toBeCloseTo(rb[0]![0]![0]!.re, 6);
    expect(ra[0]![1]![2]!.im).toBeCloseTo(rb[0]![1]![2]!.im, 6);
  });
});
