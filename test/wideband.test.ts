import { describe, it, expect } from 'vitest';
import { createConfig } from '../src/config/create.js';
import { createMicrophoneArray } from '../src/coverage/coverage.js';
import type { CoverageZone, Device, Point2D, RoomLayout, SystemConfig } from '../src/model/index.js';
import {
  sensibel8,
  withActiveChannels,
  designZoneBeams,
  designFromBearings,
  designMultiBearings,
  frequencyCurves,
  beamDesignSummary,
  beamFrequencyCurveTable,
  SPEECH_OCTAVE_CENTERS_HZ,
  SPEECH_THIRD_OCTAVE_CENTERS_HZ,
  RESPONSE_FLOOR_DB,
  MODE_DELAYSUM,
} from '../src/beamformer/index.js';
import type { Complex } from '../src/beamformer/index.js';

const GEOM = sensibel8(0.05);
const F_REF = 1000.0;

const isZero = (c: Complex) => c.re === 0 && c.im === 0;

// Local pure config helpers (mirror src/index.ts) to avoid importing the index
// barrel, which transitively loads in-progress sibling modules.
function rectangularRoom(width: number, depth: number, height = 3): RoomLayout {
  return {
    vertices: [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: depth },
      { x: 0, y: depth },
    ],
    height,
    units: 'meters',
    objects: [],
  };
}
function setRoom(c: SystemConfig, room: RoomLayout): SystemConfig {
  return { ...c, room };
}
function addDevice(c: SystemConfig, device: Device): SystemConfig {
  return { ...c, devices: [...c.devices, device] };
}
function setDevicePosition(c: SystemConfig, deviceId: string, position: Point2D): SystemConfig {
  return {
    ...c,
    devices: c.devices.map((d) => (d.id === deviceId ? { ...d, position } : d)),
  };
}

function sceneWithZones() {
  let c = createConfig({ name: 'Room', createdAt: '2026-06-12T00:00:00Z' });
  c = setRoom(c, rectangularRoom(8, 6, 3));
  const zones: CoverageZone[] = [
    {
      id: 'p1',
      type: 'dynamic',
      shape: { kind: 'rect', origin: { x: 6.5, y: 2.5 }, width: 1, height: 1 },
      alwaysOn: false,
      label: 'Presenter',
    },
    {
      id: 'x1',
      type: 'exclusion',
      shape: { kind: 'rect', origin: { x: 0.5, y: 2.5 }, width: 1, height: 1 },
      alwaysOn: false,
      label: 'Hallway',
    },
  ];
  c = addDevice(c, createMicrophoneArray('A', 'Ceiling Array', 'automatic', zones));
  c = setDevicePosition(c, 'A', { x: 4, y: 3 });
  return c;
}

// --- the wideband default ---
describe('wideband — default design', () => {
  it('carries octave bands by default', () => {
    const design = designZoneBeams(sceneWithZones(), 'A', GEOM);
    expect(design.bandFreqs).toEqual(SPEECH_OCTAVE_CENTERS_HZ);
    const beam = design.beams[0]!;
    expect(beam.bandMetrics.map((m) => m.freqHz)).toEqual([...SPEECH_OCTAVE_CENTERS_HZ]);
    expect(beam.bandMetrics.every((m) => m.weights.length === GEOM.nChannels)).toBe(true);
  });

  it('pickup holds across bands (unity gain at every band center)', () => {
    const beam = designZoneBeams(sceneWithZones(), 'A', GEOM).beams[0]!;
    for (const m of beam.bandMetrics) {
      expect(m.pickupGainDb).toBeCloseTo(0.0, 5);
    }
  });

  it('nulls hold across bands', () => {
    const beam = designZoneBeams(sceneWithZones(), 'A', GEOM).beams[0]!;
    expect(beam.nulled).toBe(true);
    for (const m of beam.bandMetrics) {
      expect(m.note).toBe('');
      expect(m.exclusionAttenDb[0]!).toBeLessThan(-40.0);
    }
  });

  it('bearing design nulls across bands', () => {
    const design = designFromBearings(GEOM, [0.0, 90.0], [[180.0, 90.0]]);
    const beam = design.beams[0]!;
    expect(beam.bandMetrics.length).toBe(SPEECH_OCTAVE_CENTERS_HZ.length);
    for (const m of beam.bandMetrics) {
      expect(m.pickupGainDb).toBeCloseTo(0.0, 5);
      expect(m.exclusionAttenDb[0]!).toBeLessThan(-40.0);
    }
  });

  it('delaysum mode pickup across bands', () => {
    const design = designFromBearings(GEOM, [45.0, 90.0], [], { mode: MODE_DELAYSUM });
    for (const m of design.beams[0]!.bandMetrics) {
      expect(m.pickupGainDb).toBeCloseTo(0.0, 9);
    }
  });

  it('band metrics report physics not hide it (WNG worse at 250 Hz than 4 kHz)', () => {
    const beam = designZoneBeams(sceneWithZones(), 'A', GEOM).beams[0]!;
    const byF = new Map(beam.bandMetrics.map((m) => [m.freqHz, m]));
    expect(byF.get(250.0)!.wngDb).toBeLessThan(byF.get(4000.0)!.wngDb);
    expect(beam.bandMetrics.every((m) => m.wngDb > RESPONSE_FLOOR_DB)).toBe(true);
  });
});

// --- the single-frequency API is the special case ---
describe('wideband — single-frequency special case', () => {
  it('band weights match the single-frequency design', () => {
    const c = sceneWithZones();
    const wide = designZoneBeams(c, 'A', GEOM);
    for (const m of wide.beams[0]!.bandMetrics) {
      const narrow = designZoneBeams(c, 'A', GEOM, { freqHz: m.freqHz, bands: [] });
      const nw = narrow.beams[0]!.weights;
      expect(nw.length).toBe(m.weights.length);
      for (let i = 0; i < nw.length; i++) {
        expect(nw[i]!.re).toBeCloseTo(m.weights[i]!.re, 12);
        expect(nw[i]!.im).toBeCloseTo(m.weights[i]!.im, 12);
      }
    }
  });

  it('bands opt-out keeps legacy shape and scalars', () => {
    const c = sceneWithZones();
    const legacy = designZoneBeams(c, 'A', GEOM, { freqHz: F_REF, bands: [] });
    const wide = designZoneBeams(c, 'A', GEOM, { freqHz: F_REF });
    expect(legacy.bandFreqs).toEqual([]);
    expect(legacy.beams[0]!.bandMetrics).toEqual([]);
    expect(legacy.beams[0]!.weights).toEqual(wide.beams[0]!.weights);
    expect(legacy.beams[0]!.pickupGainDb).toBe(wide.beams[0]!.pickupGainDb);
    expect(legacy.beams[0]!.diDb).toBe(wide.beams[0]!.diDb);
    expect(legacy.beams[0]!.exclusionAttenDb).toEqual(wide.beams[0]!.exclusionAttenDb);
  });

  it('custom band grid is honoured', () => {
    const design = designFromBearings(GEOM, [0.0, 90.0], [[180.0, 90.0]], { bands: [300.0, 3000.0] });
    expect(design.bandFreqs).toEqual([300.0, 3000.0]);
    expect(design.beams[0]!.bandMetrics.map((m) => m.freqHz)).toEqual([300.0, 3000.0]);
  });

  it('invalid band grid raises', () => {
    expect(() => designFromBearings(GEOM, [0.0, 90.0], [], { bands: [1000.0, -200.0] })).toThrow();
  });

  it('multi-bearings band opt-out (used by autosteer)', () => {
    const design = designMultiBearings(GEOM, [[0.0, 90.0], [90.0, 90.0]], [[200.0, 90.0]], { bands: [] });
    expect(design.bandFreqs).toEqual([]);
    expect(design.beams.every((b) => b.bandMetrics.length === 0)).toBe(true);
  });

  it('summary reports band range and worst leak', () => {
    const s = beamDesignSummary(designZoneBeams(sceneWithZones(), 'A', GEOM));
    expect(s).toContain('bands 250–8000 Hz (6)');
    expect(s).toContain('worst excluded leak');
  });

  it('a dead capsule stays zero in every band', () => {
    const g = withActiveChannels(GEOM, [true, true, true, true, false, true, true, true]);
    const design = designFromBearings(g, [0.0, 90.0], [[180.0, 90.0]]);
    for (const m of design.beams[0]!.bandMetrics) {
      expect(isZero(m.weights[4]!)).toBe(true);
    }
  });
});

// --- broadband verification curves: DI / beamwidth vs frequency ---
describe('wideband — frequency curves', () => {
  it('one per beam on the third-octave grid', () => {
    const design = designZoneBeams(sceneWithZones(), 'A', GEOM);
    const curves = frequencyCurves(design);
    expect(curves.length).toBe(design.beams.length);
    expect(curves.length).toBe(1);
    const c = curves[0]!;
    expect(c.freqsHz).toEqual(SPEECH_THIRD_OCTAVE_CENTERS_HZ);
    const n = c.freqsHz.length;
    expect(c.diDb.length).toBe(n);
    expect(c.beamwidth3dbDeg.length).toBe(n);
    expect(c.wngDb.length).toBe(n);
    expect(c.nLobes.length).toBe(n);
    expect(c.nGrating.length).toBe(n);
    expect(c.notes.length).toBe(n);
    expect(c.label).toBe('Presenter');
  });

  it('curve shows known aperture physics (delay-and-sum narrows + gains DI with frequency)', () => {
    const design = designFromBearings(GEOM, [0.0, 90.0], [], { mode: MODE_DELAYSUM });
    const c = frequencyCurves(design)[0]!;
    const lo = c.freqsHz.indexOf(250.0);
    const hi = c.freqsHz.indexOf(8000.0);
    expect(c.diDb[hi]!).toBeGreaterThan(c.diDb[lo]! + 2.0);
    expect(c.beamwidth3dbDeg[hi]!).toBeLessThan(c.beamwidth3dbDeg[lo]! / 2.0);
    expect(c.nLobes[hi]!).toBeGreaterThanOrEqual(c.nLobes[lo]!);
  });

  it('superdirective beats delay-and-sum in the low band', () => {
    const look: [number, number] = [0.0, 90.0];
    const grid = [250.0, 400.0, 630.0];
    const sd = frequencyCurves(designFromBearings(GEOM, look, [], { loading: 0.02 }), { freqs: grid })[0]!;
    const ds = frequencyCurves(designFromBearings(GEOM, look, [], { mode: MODE_DELAYSUM }), { freqs: grid })[0]!;
    for (let i = 0; i < grid.length; i++) {
      expect(sd.diDb[i]!).toBeGreaterThan(ds.diDb[i]! + 2.0);
    }
  });

  it('curve DI consistent with band metrics on the same grid', () => {
    const design = designZoneBeams(sceneWithZones(), 'A', GEOM);
    const curve = frequencyCurves(design, { freqs: SPEECH_OCTAVE_CENTERS_HZ })[0]!;
    design.beams[0]!.bandMetrics.forEach((m, i) => {
      expect(curve.diDb[i]!).toBeCloseTo(m.diDb, 9);
      expect(curve.wngDb[i]!).toBeCloseTo(m.wngDb, 9);
    });
  });

  it('empty design and bad grid', () => {
    let c = createConfig({ name: 'Room', createdAt: 'x' });
    c = setRoom(c, rectangularRoom(8, 6, 3));
    c = addDevice(c, createMicrophoneArray('A', 'Array'));
    c = setDevicePosition(c, 'A', { x: 4, y: 3 });
    const empty = designZoneBeams(c, 'A', GEOM);
    expect(frequencyCurves(empty)).toEqual([]);
    const design = designFromBearings(GEOM, [0.0, 90.0]);
    expect(() => frequencyCurves(design, { freqs: [500.0, 0.0] })).toThrow();
  });

  it('curve table is readable', () => {
    const design = designZoneBeams(sceneWithZones(), 'A', GEOM);
    const t = beamFrequencyCurveTable(frequencyCurves(design)[0]!);
    expect(t).toContain('DI / beamwidth vs frequency (Presenter):');
    expect(t).toContain('250 Hz');
    expect(t).toContain('8000 Hz');
    expect(t).toContain('°');
    expect(t).toContain('dB');
    expect(t.split('\n').length).toBe(2 + SPEECH_THIRD_OCTAVE_CENTERS_HZ.length);
  });
});
