import { describe, it, expect } from 'vitest';
import { StreamingVoiceGate } from '../src/live/voice-gate.js';

const FS = 44100;
const N = 1412; // ~32 ms hop at 44.1 kHz (so hopSeconds matches the scorer's default cadence closely)

function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / x.length);
}

/** A block of white-ish noise at a given amplitude (deterministic LCG — no Math.random). */
function noiseBlock(n: number, amp: number, seed: number): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (1664525 * s + 1013904223) >>> 0;
    out[i] = amp * ((s / 0xffffffff) * 2 - 1);
  }
  return out;
}

describe('StreamingVoiceGate', () => {
  it('ducks a STEADY signal toward the floor over time', () => {
    const gate = new StreamingVoiceGate(FS);
    let out: Float32Array = new Float32Array(N);
    for (let b = 0; b < 80; b++) out = gate.process(noiseBlock(N, 0.2, b + 1));
    // steady (non-speech) → score stays low → gain ducks toward 10^(-15/20) ≈ 0.178
    expect(gate.gateOpen).toBe(false);
    expect(gate.reductionDb).toBeGreaterThan(6);
    const floorLevel = 0.2 * Math.pow(10, -15 / 20);
    expect(rms(out)).toBeLessThan(floorLevel * 1.6); // converged near the −15 dB floor
    expect(rms(out)).toBeGreaterThan(floorLevel * 0.5); // a duck, not a mute
  });

  it('opens immediately on a sudden loud onset (onset branch)', () => {
    const gate = new StreamingVoiceGate(FS);
    // settle quiet first
    for (let b = 0; b < 10; b++) gate.process(noiseBlock(N, 0.001, b + 1));
    const out = gate.process(noiseBlock(N, 0.5, 999)); // 500x louder → onset
    // the onset block is NOT floored: its output is close to full gain, not ducked.
    // noiseBlock(amp=0.5) RMS ≈ amp/√3 ≈ 0.289; at full gain that is the output; at floor (-15 dB) it is ≈ 0.051.
    // Assert we are clearly in the full-gain region (> 80 % of the max achievable ≈ 0.289 × 0.8 ≈ 0.231).
    expect(rms(out)).toBeGreaterThan(0.5 / Math.sqrt(3) * 0.8); // near full gain, not merely un-floored
  });

  it('the floor is a duck, not a mute (never silences)', () => {
    const gate = new StreamingVoiceGate(FS, { floorDb: -15 });
    let out: Float32Array = new Float32Array(N);
    for (let b = 0; b < 120; b++) out = gate.process(noiseBlock(N, 0.2, b + 1));
    expect(rms(out)).toBeGreaterThan(0); // ducked, never zero
    // ducked output RMS is on the order of floor * input (well above silence)
    expect(rms(out)).toBeGreaterThan(0.2 * Math.pow(10, -15 / 20) * 0.5);
  });

  it('attack is faster than release (gate opens within a few blocks, closes over many)', () => {
    // Settle the gate closed with steady noise
    const gateClose = new StreamingVoiceGate(FS);
    for (let b = 0; b < 80; b++) gateClose.process(noiseBlock(N, 0.2, b + 1));
    expect(gateClose.gateOpen).toBe(false);

    // Count how many loud blocks it takes to cross the 0.75 gain midpoint (attack)
    let attackBlocks = 0;
    for (let b = 0; b < 50; b++) {
      gateClose.process(loud(N));
      attackBlocks++;
      if (Math.pow(10, -gateClose.reductionDb / 20) > 0.75) break;
    }

    // Now measure release: start from open, count blocks of steady noise to fall below 0.75
    const gateOpen = new StreamingVoiceGate(FS);
    gateOpen.process(loud(N)); // open it
    let releaseBlocks = 0;
    for (let b = 0; b < 300; b++) {
      gateOpen.process(noiseBlock(N, 0.2, b + 1));
      releaseBlocks++;
      if (Math.pow(10, -gateOpen.reductionDb / 20) < 0.75) break;
    }

    // Attack should be much faster (fewer blocks) than release
    expect(attackBlocks).toBeLessThan(releaseBlocks);
  });

  it('uses constant gain on a 1-sample block (no divide-by-zero)', () => {
    const gate = new StreamingVoiceGate(FS);
    const one = new Float32Array([0.5]);
    const out = gate.process(one);
    expect(Number.isFinite(out[0]!)).toBe(true);
  });

  it('returns the same object on an empty block', () => {
    const gate = new StreamingVoiceGate(FS);
    const empty = new Float32Array(0);
    expect(gate.process(empty)).toBe(empty);
  });

  it('ramps gain linearly within a block (de-click), not a step', () => {
    const gate = new StreamingVoiceGate(FS);
    const c = 0.1;
    const dc = (): Float32Array => new Float32Array(N).fill(c); // steady DC → score decays, no real modulation
    // Advance until the gate starts ducking (reductionDb > 0 marks the first transition block).
    let out: Float32Array = new Float32Array(N);
    let transitionFound = false;
    for (let i = 0; i < 50; i++) {
      out = gate.process(dc());
      if (gate.reductionDb > 0) { transitionFound = true; break; }
    }
    expect(transitionFound).toBe(true); // ensure we actually tested a transition block
    // On a transition block the gain ramps from the (high) start gain to the (lower) end gain:
    expect(out[0]!).toBeGreaterThan(out[N - 1]!); // a flat step would make these equal
    expect(out[0]!).toBeCloseTo(c, 2); // started at ~unity gain (transition start gain ≈ 1)
  });

  it('reset() restores an open gate', () => {
    const gate = new StreamingVoiceGate(FS);
    for (let b = 0; b < 80; b++) gate.process(noiseBlock(N, 0.2, b + 1)); // duck it closed
    gate.reset();
    expect(gate.gateOpen).toBe(true);
    expect(gate.reductionDb).toBe(0);
    expect(gate.score).toBe(1);
  });
});

/** A loud full-scale-ish block (triggers the onset branch). */
function loud(n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.8 * Math.sin((2 * Math.PI * 300 * i) / FS);
  return out;
}
