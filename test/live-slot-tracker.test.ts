import { describe, it, expect } from 'vitest';
import { BeamSlotTracker, snapTargets, DEFAULT_N_BEAMS, type BeamTarget } from '../src/live/slot-tracker.js';

const tgt = (az: number, sal: number, seat: string | null = null): BeamTarget => ({ azimuthDeg: az, seatId: seat, salienceDb: sal });

describe('BeamSlotTracker', () => {
  it('assigns two targets to two slots (louder first into the first idle slot)', () => {
    const tr = new BeamSlotTracker({ nSlots: 3 });
    const slots = tr.update([tgt(10, 3), tgt(120, 9)], 0);
    const active = slots.filter((s) => s.active);
    expect(active.length).toBe(2);
    // the louder (120°, 9 dB) takes the first idle slot
    expect(slots[0]!.azimuthDeg).toBe(120);
    expect(slots[1]!.azimuthDeg).toBe(10);
  });

  it('keeps a talker on the same slot across ticks (bearing match within radius)', () => {
    const tr = new BeamSlotTracker({ nSlots: 2, matchRadiusDeg: 25 });
    tr.update([tgt(40, 5)], 0);
    const s = tr.update([tgt(50, 5)], 0.1); // 10° move ≤ 25° radius → same slot
    expect(s[0]!.azimuthDeg).toBe(50);
    expect(s.filter((x) => x.active).length).toBe(1);
  });

  it('holds a slot through a brief pause then releases after holdSeconds', () => {
    const tr = new BeamSlotTracker({ nSlots: 1, holdSeconds: 0.6 });
    tr.update([tgt(30, 5)], 0);
    const held = tr.update([], 0.3); // no target, within hold
    expect(held[0]!.active).toBe(false);
    expect(held[0]!.held).toBe(true);
    expect(held[0]!.azimuthDeg).toBe(30); // coasts on its bearing
    const released = tr.update([], 1.0); // past hold (since last_seen 0)
    expect(released[0]!.held).toBe(false);
    expect(released[0]!.azimuthDeg).toBe(null);
  });

  it('matches by seat identity even outside the bearing radius', () => {
    const tr = new BeamSlotTracker({ nSlots: 2, matchRadiusDeg: 10 });
    tr.update([tgt(40, 5, 'seatA')], 0);
    const s = tr.update([tgt(120, 5, 'seatA')], 0.1); // 80° move but same seat → same slot
    const slot = s.find((x) => x.seatId === 'seatA')!;
    expect(slot.azimuthDeg).toBe(120);
    expect(s.filter((x) => x.active).length).toBe(1);
  });

  it('when full, louder talkers win and the quietest unmatched is dropped', () => {
    const tr = new BeamSlotTracker({ nSlots: 2 });
    const s = tr.update([tgt(0, 1), tgt(90, 5), tgt(180, 9)], 0);
    const aims = s.filter((x) => x.active).map((x) => x.azimuthDeg).sort((a, b) => a! - b!);
    expect(s.filter((x) => x.active).length).toBe(2);
    expect(aims).toEqual([90, 180]); // the two loudest; 0°/1dB dropped
  });

  it('reset() clears all slots', () => {
    const tr = new BeamSlotTracker({ nSlots: 2 });
    tr.update([tgt(40, 5)], 0);
    tr.reset();
    const s = tr.update([], 0);
    expect(s.every((x) => x.azimuthDeg === null && !x.active && !x.held)).toBe(true);
  });

  it('snapTargets maps detections to free-DOA targets; DEFAULT_N_BEAMS=3', () => {
    expect(snapTargets([{ azimuthDeg: 45, salienceDb: 6 }])).toEqual([{ azimuthDeg: 45, seatId: null, salienceDb: 6 }]);
    expect(DEFAULT_N_BEAMS).toBe(3);
  });

  it('steal-the-stalest: a louder new talker evicts the stalest slot when all slots are busy', () => {
    const tr = new BeamSlotTracker({ nSlots: 2, matchRadiusDeg: 5 });
    // Fill both slots at t=0
    tr.update([tgt(10, 5), tgt(60, 5)], 0);
    // Advance one slot to t=0.5 (fresher) by presenting only the 60° talker
    tr.update([tgt(60, 5)], 0.5);
    // Now both are occupied; 10° was last seen at t=0 (stalest), 60° at t=0.5 (freshest).
    // A new louder talker at 200° should steal the stalest slot (10°).
    const s = tr.update([tgt(60, 5), tgt(200, 9)], 1.0);
    const azimuths = s.filter((x) => x.active).map((x) => x.azimuthDeg).sort((a, b) => a! - b!);
    // 60° kept (fresher), 200° took the evicted slot
    expect(azimuths).toContain(60);
    expect(azimuths).toContain(200);
    expect(azimuths).not.toContain(10);
  });

  it('two-source persistence: two slots track two talkers and stay unswapped across ticks', () => {
    const tr = new BeamSlotTracker({ nSlots: 2, matchRadiusDeg: 25 });
    // Assign A=10° and B=120° at t=0
    const s0 = tr.update([tgt(10, 5), tgt(120, 5)], 0);
    const slotA = s0.find((x) => x.azimuthDeg === 10)!.index;
    const slotB = s0.find((x) => x.azimuthDeg === 120)!.index;
    // At t=0.1, present A'=15° and B'=125° — small moves, within matchRadiusDeg
    const s1 = tr.update([tgt(15, 5), tgt(125, 5)], 0.1);
    // Each talker should stay in its original slot (not swapped)
    expect(s1[slotA]!.azimuthDeg).toBeCloseTo(15, 0);
    expect(s1[slotB]!.azimuthDeg).toBeCloseTo(125, 0);
  });
});
