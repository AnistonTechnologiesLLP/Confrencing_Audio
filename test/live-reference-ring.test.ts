import { describe, it, expect } from 'vitest';
import { ReferenceRing } from '../src/live/reference-ring.js';

describe('ReferenceRing', () => {
  it('recent() is newest-last, zero-front-padded before the ring fills', () => {
    const r = new ReferenceRing(10, 1); // capacity 10
    r.push(Float32Array.of(1, 2, 3));
    const out = new Float32Array(5);
    r.recent(out);
    expect([...out]).toEqual([0, 0, 1, 2, 3]); // front-padded, newest last
  });

  it('returns the newest n after wrap-around', () => {
    const r = new ReferenceRing(4, 1); // capacity 4
    r.push(Float32Array.of(1, 2, 3, 4, 5, 6)); // wraps; keeps newest 4 = [3,4,5,6]
    const out = new Float32Array(4);
    r.recent(out);
    expect([...out]).toEqual([3, 4, 5, 6]);
  });

  it('a block larger than capacity keeps only the newest capacity samples', () => {
    const r = new ReferenceRing(3, 1); // capacity 3
    r.push(Float32Array.of(1, 2, 3, 4, 5));
    const out = new Float32Array(3);
    r.recent(out);
    expect([...out]).toEqual([3, 4, 5]);
  });

  it('reset() clears the ring', () => {
    const r = new ReferenceRing(4, 1);
    r.push(Float32Array.of(9, 9, 9));
    r.reset();
    const out = new Float32Array(4);
    r.recent(out);
    expect([...out]).toEqual([0, 0, 0, 0]);
  });

  it('capacity = round(sampleRate * seconds)', () => {
    expect(new ReferenceRing(44100, 2).capacity).toBe(88200);
  });
});
