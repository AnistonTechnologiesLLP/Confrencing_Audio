import { describe, it, expect } from 'vitest';
import { ChainedCleaner } from '../src/live/cleaner-chain.js';
import type { Cleaner } from '../src/live/level-preserving-cleaner.js';

function fixedGain(g: number, log?: number[], id?: number): Cleaner {
  return {
    process: (b) => { if (log && id !== undefined) log.push(id); const o = new Float32Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b[i]! * g; return o; },
    reset: () => {},
  };
}

describe('ChainedCleaner', () => {
  it('applies stages in order (composed gain is the product)', () => {
    const order: number[] = [];
    const chain = new ChainedCleaner([fixedGain(0.5, order, 0), fixedGain(0.25, order, 1)]);
    const out = chain.process(Float32Array.of(1, 1, 1), false);
    expect(out[0]!).toBeCloseTo(0.125, 9); // 0.5 * 0.25
    expect(order).toEqual([0, 1]); // stage 0 before stage 1
  });

  it('a single-element chain equals that stage', () => {
    const chain = new ChainedCleaner([fixedGain(0.5)]);
    const out = chain.process(Float32Array.of(2, 4), false);
    expect([out[0]!, out[1]!]).toEqual([1, 2]);
  });

  it('reset() resets every stage', () => {
    let a = 0, b = 0;
    const s1: Cleaner = { process: (x) => x, reset: () => { a++; } };
    const s2: Cleaner = { process: (x) => x, reset: () => { b++; } };
    new ChainedCleaner([s1, s2]).reset();
    expect([a, b]).toEqual([1, 1]);
  });

  it('empty chain is identity (returns the same block reference)', () => {
    const chain = new ChainedCleaner([]);
    const block = Float32Array.of(1, 2, 3);
    expect(chain.process(block, false)).toBe(block);
  });

  it('forwards noiseGate unchanged to every stage for both false and true', () => {
    const received: boolean[] = [];
    const spy = (id: number): Cleaner => ({
      process: (b, ng) => { received.push(ng); void id; return b; },
      reset: () => {},
    });
    const chain = new ChainedCleaner([spy(0), spy(1)]);
    const block = Float32Array.of(1);
    chain.process(block, false);
    chain.process(block, true);
    expect(received).toEqual([false, false, true, true]);
  });
});
