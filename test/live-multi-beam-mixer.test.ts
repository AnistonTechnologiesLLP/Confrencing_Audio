import { describe, it, expect } from 'vitest';
import { MultiBeamMixer, nomAutomix } from '../src/live/multi-beam-mixer.js';
import { planeWaveChannels } from '../src/live/mock-adapter.js';
import { sensibel8 } from '../src/beamformer/geometry.js';
import type { BeamSlot } from '../src/live/slot-tracker.js';

const FS = 44100;
const GEOM = sensibel8(0.04);
const slot = (index: number, az: number | null, active = true): BeamSlot => ({ index, azimuthDeg: az, seatId: null, active, held: false });

describe('nomAutomix', () => {
  it('one open gate passes that mono ~unity; closed gates contribute nothing', () => {
    const a = new Float32Array([1, 1, 1, 1]);
    const b = new Float32Array([2, 2, 2, 2]);
    const mixed = nomAutomix([1, 0], [a, b]);
    // gate sum 1 → denom max(1, sqrt(1)) = 1 → passes a at unity
    expect(Array.from(mixed)).toEqual([1, 1, 1, 1]);
  });
  it('returns silence when all gates are closed', () => {
    expect(Array.from(nomAutomix([0, 0], [new Float32Array(3), new Float32Array(3)]))).toEqual([0, 0, 0]);
  });
  it('NOM-attenuates as more gates open (√Σgate denominator)', () => {
    const m = new Float32Array([1, 1]);
    const mixed = nomAutomix([1, 1], [m, m]); // Σgm = [2,2]; denom = max(1, √2); 2/√2 = √2 ≈ 1.414
    expect(mixed[0]!).toBeCloseTo(Math.SQRT2, 5);
  });
  it('sub-unity gate does NOT amplify — max(1, √Σg) floor keeps output ≤ input', () => {
    // gate=0.5, mono=[1,1] → denom = max(1, sqrt(0.5)) = max(1, 0.707) = 1 → mixed = 0.5·1/1 = 0.5
    // (NOT 1/√0.5 ≈ 1.414, which would be amplification)
    const mixed = nomAutomix([0.5], [Float32Array.of(1, 1)]);
    expect(mixed[0]!).toBeCloseTo(0.5, 5);
    expect(mixed[1]!).toBeCloseTo(0.5, 5);
  });
});

describe('MultiBeamMixer', () => {
  it('runs N beams, returns mixed + per-beam monos + gates, mixed length = block', () => {
    const mixer = new MultiBeamMixer(GEOM, FS, { nBeams: 3 });
    mixer.setSlots([slot(0, 0), slot(1, 120), slot(2, null, false)]);
    let r = mixer.processBlock(planeWaveChannels(GEOM, 0, 1500, 512, 0, FS));
    for (let i = 1; i < 20; i++) r = mixer.processBlock(planeWaveChannels(GEOM, 0, 1500, 512, i, FS));
    expect(r.monos.length).toBe(3);
    expect(r.gates.length).toBe(3);
    expect(r.mixed.length).toBe(512);
    expect(r.gates[2]).toBe(0); // idle slot gated out
    for (const v of r.mixed) expect(Number.isFinite(v)).toBe(true);
    expect(mixer.nBeams).toBe(3);
  });
  it('an idle slot contributes nothing (gate 0) and a live slot can open', () => {
    const mixer = new MultiBeamMixer(GEOM, FS, { nBeams: 2 });
    mixer.setSlots([slot(0, 0), slot(1, null, false)]);
    let r = mixer.processBlock(planeWaveChannels(GEOM, 0, 1500, 512, 0, FS));
    for (let i = 1; i < 30; i++) r = mixer.processBlock(planeWaveChannels(GEOM, 0, 1500, 512, i, FS));
    expect(r.gates[1]).toBe(0);
  });
  it('beam 0 at look-direction is louder than beam 1 off-axis (differential spatial gain)', () => {
    // At 800 Hz the superdirective beam is strongly directional.
    // Measured: beam aimed at 0° on a 0° source ≈ 0.711 RMS; beam aimed at 120° ≈ 0.109 RMS → ratio ≈ 0.153.
    const mixer = new MultiBeamMixer(GEOM, FS, { nBeams: 2 });
    mixer.setSlots([slot(0, 0), slot(1, 120)]);
    let r = mixer.processBlock(planeWaveChannels(GEOM, 0, 800, 512, 0, FS));
    for (let i = 1; i < 24; i++) r = mixer.processBlock(planeWaveChannels(GEOM, 0, 800, 512, i, FS));
    function rms(x: Float32Array): number { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / Math.max(1, x.length)); }
    const beam0Rms = rms(r.monos[0]!);
    const beam1Rms = rms(r.monos[1]!);
    // Beam 0 (aimed at 0°) must be clearly louder than beam 1 (aimed at 120°) for a 0° source.
    expect(beam0Rms).toBeGreaterThan(beam1Rms * 2.0); // measured ratio ~6.5× at 800 Hz
  });

  it('reset() clears the beams + scorers (re-feeding reproduces a fresh run)', () => {
    const mixer = new MultiBeamMixer(GEOM, FS, { nBeams: 2 });
    mixer.setSlots([slot(0, 0), slot(1, 90)]);
    const mk = (i: number): Float32Array[] => planeWaveChannels(GEOM, 0, 1200, 512, i, FS);
    const first: number[] = [];
    for (let i = 0; i < 6; i++) for (const v of mixer.processBlock(mk(i)).mixed) first.push(v);
    for (let i = 0; i < 3; i++) mixer.processBlock(mk(i));
    mixer.reset();
    mixer.setSlots([slot(0, 0), slot(1, 90)]);
    const again: number[] = [];
    for (let i = 0; i < 6; i++) for (const v of mixer.processBlock(mk(i)).mixed) again.push(v);
    for (let i = 0; i < first.length; i++) expect(again[i]).toBeCloseTo(first[i]!, 5);
  });
});
