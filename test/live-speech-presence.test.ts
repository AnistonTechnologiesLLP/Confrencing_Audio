import { describe, it, expect } from 'vitest';
import { SpeechPresenceScorer, alphaFor, VG_MOD_REF } from '../src/live/speech-presence.js';

/** Feed a sequence of per-hop RMS values, return the final score. */
function runScore(scorer: SpeechPresenceScorer, rms: number[]): number {
  let s = 0;
  for (const r of rms) s = scorer.update(r);
  return s;
}

/** A modulated RMS envelope: alternates between hi and lo every `period` hops (syllabic-ish). */
function modulated(hi: number, lo: number, period: number, hops: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < hops; i++) out.push(Math.floor(i / period) % 2 === 0 ? hi : lo);
  return out;
}

describe('alphaFor', () => {
  it('returns 1 for tau <= 0 and a value in (0,1) for positive tau', () => {
    expect(alphaFor(0.032, 0)).toBe(1);
    expect(alphaFor(0.032, -1)).toBe(1);
    const a = alphaFor(0.032, 0.15);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
  });
});

describe('SpeechPresenceScorer', () => {
  it('scores a STEADY envelope near zero (well below the 0.35 speech threshold)', () => {
    const scorer = new SpeechPresenceScorer();
    const steady = new Array(200).fill(0.1);
    expect(runScore(scorer, steady)).toBeLessThan(0.1);
  });

  it('scores a MODULATED (syllabic) envelope high and crosses the threshold', () => {
    const scorer = new SpeechPresenceScorer();
    // ~5 Hz modulation at a 0.032 s hop ≈ a 6-hop period; run long enough for the EMAs to settle.
    const score = runScore(scorer, modulated(0.3, 0.03, 3, 300));
    expect(score).toBeGreaterThan(0.35);
  });

  it('is level-invariant — scaling the envelope 10x leaves the score ~unchanged', () => {
    const seq = modulated(0.3, 0.03, 3, 300);
    const a = runScore(new SpeechPresenceScorer(), seq);
    const b = runScore(new SpeechPresenceScorer(), seq.map((r) => r * 10));
    expect(Math.abs(a - b)).toBeLessThan(0.05);
  });

  it('reset() zeroes state — re-feeding reproduces the run', () => {
    const scorer = new SpeechPresenceScorer();
    const seq = modulated(0.3, 0.03, 3, 120);
    const first = runScore(scorer, seq);
    runScore(scorer, seq); // dirty
    scorer.reset();
    const again = runScore(scorer, seq);
    expect(again).toBeCloseTo(first, 10);
    expect(VG_MOD_REF).toBe(0.25);
  });
});
