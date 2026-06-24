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

  it('per-sample modulo wrap across multiple sub-capacity pushes', () => {
    // capacity=4, push([1,2,3]) then push([4,5,6]): 6 total, both < 4 so slow loop runs
    // after first push: buf=[1,2,3,0], w=3, filled=3
    // after second push: buf=[1,2,3,4] then w wraps: buf=[5,6,3,4]? No —
    // push([4,5,6]): i=0 → buf[3]=4, w=0; i=1 → buf[0]=5, w=1; i=2 → buf[1]=6, w=2
    // so buf=[5,6,3,4], w=2, filled=4. recent([_,_,_,_]):
    //   newest=buf[(w-1-0)%n]= buf[1]=6, age=0 → out[3]=6
    //   age=1 → buf[0]=5    → out[2]=5
    //   age=2 → buf[(2-1-2+4)%4]=buf[3]=4 → out[1]=4
    //   age=3 → buf[(2-1-3+4+4)%4]=buf[2]=3 → out[0]=3
    // expected: [3,4,5,6]
    const r = new ReferenceRing(4, 1);
    r.push(Float32Array.of(1, 2, 3));
    r.push(Float32Array.of(4, 5, 6));
    const out = new Float32Array(4);
    r.recent(out);
    expect([...out]).toEqual([3, 4, 5, 6]);
  });
});
