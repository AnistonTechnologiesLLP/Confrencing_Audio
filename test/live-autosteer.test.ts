import { describe, it, expect } from 'vitest';
import { AutoSteerController } from '../src/live/autosteer.js';
import type { DoaResult } from '../src/live/doa.js';

function doa(azs: number[], active = true): DoaResult {
  return { detections: azs.map((a) => ({ azimuthDeg: a, salienceDb: 10 })), gridDeg: [], powerDb: [], active };
}

describe('AutoSteerController', () => {
  it('follow: steers to the dominant in-sector detection, ignores out-of-sector', () => {
    const c = new AutoSteerController({ mode: 'follow', sector: { centerDeg: 0, halfWidthDeg: 45 } });
    expect(c.decide(doa([20, 200])).lookAzimuthDeg).toBe(20); // 200° out of sector
  });

  it('follow: returns null when nothing is in-sector and hold elapses', () => {
    const c = new AutoSteerController({ mode: 'follow', sector: { centerDeg: 0, halfWidthDeg: 30 }, holdHops: 1 });
    c.decide(doa([10]));
    c.decide(doa([], false)); // hold 1
    expect(c.decide(doa([], false)).lookAzimuthDeg).toBeNull();
  });

  it('follow: deadband suppresses a tiny re-aim', () => {
    const c = new AutoSteerController({ mode: 'follow', sector: { centerDeg: 0, halfWidthDeg: 90 }, deadbandDeg: 5, switchMarginDeg: 2 });
    expect(c.decide(doa([10])).lookAzimuthDeg).toBe(10);
    expect(c.decide(doa([13])).lookAzimuthDeg).toBeNull(); // 3° < 5° deadband → no re-aim
  });

  it('lockSeat: returns the fixed azimuth regardless of detections', () => {
    const c = new AutoSteerController({ mode: 'lockSeat', lockAzimuthDeg: 137 });
    expect(c.decide(doa([10, 200])).lookAzimuthDeg).toBe(137);
    expect(c.decide(doa([], false)).lookAzimuthDeg).toBeNull(); // already there → deadband
  });

  it('follow: picks the higher-salience in-sector detection', () => {
    const c = new AutoSteerController({ mode: 'follow', sector: { centerDeg: 0, halfWidthDeg: 90 } });
    const r: DoaResult = { detections: [{ azimuthDeg: 10, salienceDb: 4 }, { azimuthDeg: 60, salienceDb: 12 }], gridDeg: [], powerDb: [], active: true };
    expect(c.decide(r).lookAzimuthDeg).toBe(60); // higher salience wins, both in sector
  });
});
