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
    expect(rms(out)).toBeLessThan(0.2 * 0.4); // clearly attenuated vs the 0.2-amp input
  });

  it('opens immediately on a sudden loud onset (onset branch)', () => {
    const gate = new StreamingVoiceGate(FS);
    // settle quiet first
    for (let b = 0; b < 10; b++) gate.process(noiseBlock(N, 0.001, b + 1));
    const out = gate.process(noiseBlock(N, 0.5, 999)); // 500x louder → onset
    // the onset block is NOT floored: its output is close to full gain, not ducked
    expect(rms(out)).toBeGreaterThan(0.5 * 0.5);
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
