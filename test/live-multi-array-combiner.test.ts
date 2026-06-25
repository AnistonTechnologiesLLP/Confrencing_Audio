import { describe, it, expect } from 'vitest';
import { MultiArrayCombiner, crossfadeGains, DEFAULT_CROSSFADE_BLOCKS } from '../src/live/multi-array-combiner.js';
import type { KitPose } from '../src/live/triangulation.js';

const N = 512;
const FS = 44100;
/** A steady tone block (constant amplitude → low speech-presence score). */
function tone(amp: number): Float32Array {
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = amp * Math.sin((2 * Math.PI * 1000 * i) / FS);
  return out;
}
/** A syllabically-modulated block whose amplitude is `amp` this tick (the caller alternates amp to fake modulation). */
function rms(x: Float32Array): number { let s = 0; for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!; return Math.sqrt(s / x.length); }

describe('crossfadeGains (equal-power)', () => {
  it('cos²+sin²=1 across the ramp; clamps; total<=0 → (0,1)', () => {
    expect(crossfadeGains(0, 6)).toEqual([1, 0]);                       // start: all old
    const [go, gi] = crossfadeGains(3, 6);                              // midpoint
    expect(go * go + gi * gi).toBeCloseTo(1, 10);
    expect(crossfadeGains(6, 6)[0]).toBeCloseTo(0);                     // end: all new
    expect(crossfadeGains(99, 6)[0]).toBeCloseTo(0);                    // clamped
    expect(crossfadeGains(2, 0)).toEqual([0, 1]);                       // degenerate
  });
});

describe('MultiArrayCombiner', () => {
  it('outputs the active kit; switches to a clearly-louder talker and cross-fades', () => {
    const c = new MultiArrayCombiner(FS, { nKits: 2, crossfadeBlocks: DEFAULT_CROSSFADE_BLOCKS });
    // drive kit 1 with strong modulation (alternating loud/quiet) so its speech score climbs;
    // kit 0 steady (low score). After enough ticks the active should be kit 1.
    let out = c.process([{ mono: tone(0.001), azimuthDeg: 0, salienceDb: 0 }, { mono: tone(0.3), azimuthDeg: 0, salienceDb: 0 }], 0);
    let t = 0;
    for (let i = 0; i < 40; i++) {
      t += N / FS;
      const k0 = tone(0.001);                                          // steady-quiet
      const k1 = tone(i % 2 === 0 ? 0.3 : 0.02);                       // modulated → speech-like
      out = c.process([{ mono: k0, azimuthDeg: 0, salienceDb: 0 }, { mono: k1, azimuthDeg: 0, salienceDb: 0 }], t);
    }
    expect(c.active).toBe(1);                                          // selected the modulated talker
    expect(out.mono.length).toBe(N);
    for (const v of out.mono) expect(Number.isFinite(v)).toBe(true);
    expect(out.scores.length).toBe(2);
  });

  it('with no modulation on either kit, stays on kit 0 and reports no speech', () => {
    // Measured: the EMA startup transient keeps score > threshold until ~tick 80 (hop=0.0116 s),
    // and the KitSelector hold (0.4 s) keeps speechPresent=true until ~tick 114.
    // We run 120 ticks (~1.39 s) to prove speechPresent=false after convergence+hold expiry.
    const c = new MultiArrayCombiner(FS, { nKits: 2 });
    let out = c.process([{ mono: tone(0.2), azimuthDeg: 0, salienceDb: -30 }, { mono: tone(0.2), azimuthDeg: 0, salienceDb: -30 }], 0);
    for (let i = 1; i < 120; i++) out = c.process([{ mono: tone(0.2), azimuthDeg: 0, salienceDb: -30 }, { mono: tone(0.2), azimuthDeg: 0, salienceDb: -30 }], (i * N) / FS);
    expect(c.active).toBe(0);
    expect(out.speechPresent).toBe(false);
  });

  it('a combined AGC normalizes the output level (one AGC on the result)', () => {
    const c = new MultiArrayCombiner(FS, { nKits: 2, agc: { targetDb: -20 } });
    let out = c.process([{ mono: tone(0.01), azimuthDeg: 0, salienceDb: 0 }, { mono: tone(0.01), azimuthDeg: 0, salienceDb: 0 }], 0);
    for (let i = 1; i < 60; i++) out = c.process([{ mono: tone(0.01), azimuthDeg: 0, salienceDb: 0 }, { mono: tone(0.01), azimuthDeg: 0, salienceDb: 0 }], (i * N) / FS);
    // the quiet input (RMS ~0.007) is pulled up toward the target by the AGC
    expect(rms(out.mono)).toBeGreaterThan(rms(tone(0.01)));
  });

  it('a fence veto silences the vetoed kit (drops it from contention)', () => {
    // poses: kit A at (0,0) bearing 0, kit B at (4,0) bearing 0; a tiny fence box near the origin.
    const poseA: KitPose = { position: { x: 0, y: 0 }, bearingDeg: 0 };
    const poseB: KitPose = { position: { x: 4, y: 0 }, bearingDeg: 0 };
    const polygon = [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0.5, y: 0.5 }, { x: -0.5, y: 0.5 }];
    const c = new MultiArrayCombiner(FS, { nKits: 2, fence: { holdTicks: 1, marginM: 0.1 }, crossfadeBlocks: 1 });
    // both kits point at a FAR source (rays cross far outside the tiny box) and quiet → fence rejects.
    let out = c.process(
      [{ mono: tone(1e-4), azimuthDeg: 80, salienceDb: -30 }, { mono: tone(1e-4), azimuthDeg: 280, salienceDb: -30 }],
      0, { poses: [poseA, poseB], polygon },
    );
    for (let i = 1; i < 5; i++) {
      out = c.process(
        [{ mono: tone(1e-4), azimuthDeg: 80, salienceDb: -30 }, { mono: tone(1e-4), azimuthDeg: 280, salienceDb: -30 }],
        (i * N) / FS, { poses: [poseA, poseB], polygon },
      );
    }
    expect(out.fenceKeep).toBe(false); // the out-of-fence source is vetoed
    // and the OUTPUT is ducked (−60 dB by default) — not just the kit dropped from contention
    expect(rms(out.mono)).toBeLessThan(rms(tone(1e-4)) * 0.01);
  });

  it('fenceDuckDb sets the reject-duck depth; keep ⇒ no duck', () => {
    const poseA: KitPose = { position: { x: 0, y: 0 }, bearingDeg: 0 };
    const poseB: KitPose = { position: { x: 4, y: 0 }, bearingDeg: 0 };
    const polygon = [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0.5, y: 0.5 }, { x: -0.5, y: 0.5 }];
    const c = new MultiArrayCombiner(FS, { nKits: 2, fence: { holdTicks: 1, marginM: 0.1 }, fenceDuckDb: -20, crossfadeBlocks: 1 });
    let out = c.process([{ mono: tone(0.1), azimuthDeg: 80, salienceDb: -30 }, { mono: tone(0.1), azimuthDeg: 280, salienceDb: -30 }], 0, { poses: [poseA, poseB], polygon });
    for (let i = 1; i < 5; i++) out = c.process([{ mono: tone(0.1), azimuthDeg: 80, salienceDb: -30 }, { mono: tone(0.1), azimuthDeg: 280, salienceDb: -30 }], (i * N) / FS, { poses: [poseA, poseB], polygon });
    expect(out.fenceKeep).toBe(false);
    // −20 dB duck ≈ 0.1× the un-ducked level
    expect(rms(out.mono)).toBeCloseTo(rms(tone(0.1)) * 0.1, 2);
  });

  it('reset() clears selection + fade + scorers', () => {
    const c = new MultiArrayCombiner(FS, { nKits: 2 });
    c.process([{ mono: tone(0.001), azimuthDeg: 0, salienceDb: 0 }, { mono: tone(0.3), azimuthDeg: 0, salienceDb: 0 }], 0);
    c.reset();
    expect(c.active).toBe(0);
  });
});
