import { describe, it, expect } from 'vitest';
import { ExponentialTracker } from '../src/live/exponential-tracker.js';

describe('ExponentialTracker', () => {
  it('seeds on the first sample and converges to a constant input', () => {
    const t = new ExponentialTracker(0.1);
    expect(t.update(5)).toBe(5); // first sample seeds
    for (let i = 0; i < 200; i++) t.update(5);
    expect(t.value).toBeCloseTo(5, 6);
  });

  it('moves a fraction alpha toward a new value', () => {
    const t = new ExponentialTracker(0.25);
    t.update(0);
    expect(t.update(4)).toBeCloseTo(1, 9); // 0.25*4 + 0.75*0
  });

  it('reset() forgets the state (next update re-seeds)', () => {
    const t = new ExponentialTracker(0.5);
    t.update(10);
    t.reset();
    expect(t.update(3)).toBe(3);
  });
});
