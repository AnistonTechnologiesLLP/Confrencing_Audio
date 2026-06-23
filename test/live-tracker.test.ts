import { describe, it, expect } from 'vitest';
import { TalkerTracker } from '../src/live/tracker.js';

const det = (az: number) => ({ azimuthDeg: az, salienceDb: 10 });

describe('TalkerTracker', () => {
  it('commits to the first target and ignores sub-margin jitter', () => {
    const t = new TalkerTracker({ switchMarginDeg: 20, holdHops: 3 });
    expect(t.update(det(90)).azimuthDeg).toBe(90);
    expect(t.update(det(100)).azimuthDeg).toBe(90); // 10° < 20° margin → hold committed
    expect(t.update(det(82)).azimuthDeg).toBe(90);
  });

  it('switches once a target moves past the margin', () => {
    const t = new TalkerTracker({ switchMarginDeg: 20, holdHops: 3 });
    t.update(det(90));
    expect(t.update(det(130)).azimuthDeg).toBe(130); // 40° ≥ 20° → switch
  });

  it('holds through a brief silence then releases', () => {
    const t = new TalkerTracker({ switchMarginDeg: 20, holdHops: 2 });
    t.update(det(90));
    const a = t.update(null);
    expect(a.azimuthDeg).toBe(90);
    expect(a.held).toBe(true);
    expect(t.update(null).azimuthDeg).toBe(90); // 2nd hold
    expect(t.update(null).azimuthDeg).toBeNull(); // released
  });

  it('wraps correctly near 0/360', () => {
    const t = new TalkerTracker({ switchMarginDeg: 20, holdHops: 3 });
    t.update(det(350));
    expect(t.update(det(5)).azimuthDeg).toBe(350); // sep 15° < 20° → hold
  });
});
