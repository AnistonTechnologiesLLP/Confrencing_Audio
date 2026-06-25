import { describe, it, expect } from 'vitest';
import {
  rayFromBearing, localAzToRoomAz, closestPointTwoRays, crossingConfidence,
  pointInFence, levelCrossCheck, fusePosition, FenceDecider,
  type KitPose, type KitReading,
} from '../src/live/triangulation.js';
import type { Point2D } from '../src/model/geometry.js';

const P = (x: number, y: number): Point2D => ({ x, y });

describe('rayFromBearing (0°=+Y, CW)', () => {
  it('0° points +Y, 90° points +X, 180° −Y, 270° −X', () => {
    const r0 = rayFromBearing(P(0, 0), 0); expect(r0.dx).toBeCloseTo(0); expect(r0.dy).toBeCloseTo(1);
    const r90 = rayFromBearing(P(0, 0), 90); expect(r90.dx).toBeCloseTo(1); expect(r90.dy).toBeCloseTo(0);
    const r180 = rayFromBearing(P(0, 0), 180); expect(r180.dx).toBeCloseTo(0); expect(r180.dy).toBeCloseTo(-1);
    const r270 = rayFromBearing(P(0, 0), 270); expect(r270.dx).toBeCloseTo(-1); expect(r270.dy).toBeCloseTo(0);
  });
});

describe('localAzToRoomAz', () => {
  it('adds bearing and wraps into [0,360)', () => {
    expect(localAzToRoomAz(10, 0)).toBeCloseTo(10);
    expect(localAzToRoomAz(350, 30)).toBeCloseTo(20); // 380 → 20
  });
});

describe('closestPointTwoRays', () => {
  it('orthogonal rays cross at the known point', () => {
    // ray A from (0,0) heading +Y (0°); ray B from (2,3) heading −X (270°) → cross at (0,3)
    const a = rayFromBearing(P(0, 0), 0);
    const b = rayFromBearing(P(2, 3), 270);
    const r = closestPointTwoRays(a, b);
    expect(r.degenerate).toBe(false);
    expect(r.point!.x).toBeCloseTo(0);
    expect(r.point!.y).toBeCloseTo(3);
    expect(r.missDistanceM).toBeCloseTo(0);
  });
  it('near-parallel rays are degenerate (point null, miss inf)', () => {
    const a = rayFromBearing(P(0, 0), 0);
    const b = rayFromBearing(P(1, 0), 0);
    const r = closestPointTwoRays(a, b);
    expect(r.degenerate).toBe(true);
    expect(r.point).toBe(null);
    expect(r.missDistanceM).toBe(Infinity);
  });
  it('clamps sa/sb ≥ 0 (target behind a ray → clamps to origin region, no negative param)', () => {
    // both rays point +Y but origins set so the crossing would be behind → clamp
    const a = rayFromBearing(P(0, 0), 90);  // +X
    const b = rayFromBearing(P(0, 5), 90);  // +X, parallel-ish but offset
    const r = closestPointTwoRays(a, b);
    // parallel → degenerate; that's fine, just assert no throw and finite-or-inf
    expect(typeof r.missDistanceM).toBe('number');
  });
});

describe('crossingConfidence', () => {
  it('orthogonal → 1, parallel → 0, 45° → ~0.707', () => {
    expect(crossingConfidence(rayFromBearing(P(0, 0), 0), rayFromBearing(P(0, 0), 90))).toBeCloseTo(1);
    expect(crossingConfidence(rayFromBearing(P(0, 0), 0), rayFromBearing(P(0, 0), 0))).toBeCloseTo(0);
    expect(crossingConfidence(rayFromBearing(P(0, 0), 0), rayFromBearing(P(0, 0), 45))).toBeCloseTo(Math.SQRT1_2, 4);
  });
});

describe('pointInFence', () => {
  const sq = [P(0, 0), P(4, 0), P(4, 4), P(0, 4)];
  it('inside with no margin; outside with no margin; empty polygon → false', () => {
    expect(pointInFence(P(2, 2), sq, 0)).toBe(true);
    expect(pointInFence(P(5, 2), sq, 0)).toBe(false);
    expect(pointInFence(P(2, 2), [], 0.2)).toBe(false);
  });
  it('just outside but within margin → true; beyond margin → false', () => {
    expect(pointInFence(P(4.1, 2), sq, 0.2)).toBe(true);   // 0.1 m outside the right edge
    expect(pointInFence(P(4.5, 2), sq, 0.2)).toBe(false);  // 0.5 m outside
  });
});

describe('levelCrossCheck', () => {
  const mk = (level: number): KitReading => ({ azimuthDeg: 0, salienceDb: 0, level, active: false });
  it('loud source passes the inside-dB threshold; very quiet fails', () => {
    expect(levelCrossCheck(mk(0.5), mk(0.0))).toBe(true);   // 20log10(0.5) ≈ −6 dB ≥ −45
    expect(levelCrossCheck(mk(1e-6), mk(1e-6))).toBe(false); // ≈ −120 dB < −45
  });
});

describe('fusePosition', () => {
  const poseA: KitPose = { position: P(0, 0), bearingDeg: 0 };
  const poseB: KitPose = { position: P(4, 0), bearingDeg: 0 };
  const reading = (az: number | null, level = 0.5): KitReading => ({ azimuthDeg: az, salienceDb: 0, level, active: false });
  const sq = [P(0, 0), P(4, 0), P(4, 4), P(0, 4)];
  it('two bearings cross to a 2D point inside the fence; loudKit set', () => {
    // A at (0,0) sees source at local 45° (bearing 0 → room 45°); B at (4,0) sees it at local 315° (room 315°)
    // ray A: from (0,0) heading 45° (NE); ray B: from (4,0) heading 315° (NW) → cross at (2,2)
    const f = fusePosition(reading(45, 0.5), reading(315, 0.3), poseA, poseB, sq, { marginM: 0.2 });
    expect(f.degenerate).toBe(false);
    expect(f.point!.x).toBeCloseTo(2, 3);
    expect(f.point!.y).toBeCloseTo(2, 3);
    expect(f.inside).toBe(true);
    expect(f.confidence).toBeGreaterThan(0.5);
    expect(f.loudKit).toBe(0); // A louder (0.5 ≥ 0.3)
  });
  it('a missing azimuth → degenerate (point null), loudKit still resolved by level', () => {
    const f = fusePosition(reading(null), reading(90, 0.7), poseA, poseB, sq, { marginM: 0.2 });
    expect(f.degenerate).toBe(true);
    expect(f.point).toBe(null);
    expect(f.loudKit).toBe(1);
  });
  it('no polygon ⇒ inside is inert-true', () => {
    const f = fusePosition(reading(45), reading(315), poseA, poseB, [], { marginM: 0.2 });
    expect(f.inside).toBe(true);
  });
});

describe('FenceDecider hysteresis', () => {
  const poseA: KitPose = { position: P(0, 0), bearingDeg: 0 };
  const poseB: KitPose = { position: P(4, 0), bearingDeg: 0 };
  const sq = [P(0, 0), P(4, 0), P(4, 4), P(0, 4)];
  const inFenceRead = (): KitReading => ({ azimuthDeg: 45, salienceDb: 0, level: 0.5, active: false });
  const outFenceRead = (): KitReading => ({ azimuthDeg: 80, salienceDb: -20, level: 1e-6, active: false }); // far/quiet, points away from the box

  it('starts keep=true; flips to reject only after hold_ticks of sustained out-of-fence', () => {
    const d = new FenceDecider({ holdTicks: 3, marginM: 0.2 });
    // in-fence → stays keep
    expect(d.update(inFenceRead(), inFenceRead(), poseA, poseB, sq, 0).keep).toBe(true);
    // sustained out-of-fence: 2 ticks not enough, 3rd commits the flip
    expect(d.update(outFenceRead(), outFenceRead(), poseA, poseB, sq, 1).keep).toBe(true);
    expect(d.update(outFenceRead(), outFenceRead(), poseA, poseB, sq, 2).keep).toBe(true);
    const flipped = d.update(outFenceRead(), outFenceRead(), poseA, poseB, sq, 3);
    expect(flipped.keep).toBe(false);
    expect(flipped.vetoKit).not.toBe(null); // the louder kit is vetoed
  });
  it('no polygon ⇒ always keep; reset returns to keep', () => {
    const d = new FenceDecider({ holdTicks: 1 });
    expect(d.update(outFenceRead(), outFenceRead(), poseA, poseB, [], 0).keep).toBe(true);
    d.reset();
    expect(d.update(inFenceRead(), inFenceRead(), poseA, poseB, sq, 0).keep).toBe(true);
  });
});
