import { describe, it, expect } from 'vitest';
import { LevelMeter } from '../src/live/meter.js';

describe('LevelMeter', () => {
  it('reports ~ -6 dBFS RMS for a 0.5-amplitude full-block signal', () => {
    const m = new LevelMeter();
    const x = new Float32Array(1024).fill(0.5);
    m.update(x);
    expect(m.rmsDb).toBeCloseTo(-6.0206, 2); // 20*log10(0.5)
    expect(m.peakDb).toBeCloseTo(-6.0206, 2);
    expect(m.clipped).toBe(false);
  });

  it('latches clip on a full-scale sample until reset', () => {
    const m = new LevelMeter();
    const x = new Float32Array(8);
    x[3] = 1.0;
    m.update(x);
    expect(m.clipped).toBe(true);
    m.update(new Float32Array(8)); // silence
    expect(m.clipped).toBe(true); // still latched
    m.reset();
    expect(m.clipped).toBe(false);
  });

  it('floors silence at a finite dB', () => {
    const m = new LevelMeter();
    m.update(new Float32Array(256));
    expect(Number.isFinite(m.rmsDb)).toBe(true);
    expect(m.rmsDb).toBeLessThanOrEqual(-120);
  });
});
