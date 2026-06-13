import { describe, it, expect } from 'vitest';
import { createConfig } from '../src/config/create.js';
import { createProcessor } from '../src/devices/factories.js';
import { createMicrophoneArray } from '../src/coverage/coverage.js';
import type {
  CoverageZone,
  Device,
  Point2D,
  RoomLayout,
  SystemConfig,
  Talker,
} from '../src/model/index.js';
import {
  sensibel8,
  withActiveChannels,
  steeringVector,
  delayAndSumWeights,
  lcmvWeights,
  superdirectiveWeights,
  diffuseCoherence,
  directivityIndexDb,
  whiteNoiseGainDb,
  responseDb,
  beamPatternAzimuth,
  analyzeLobes,
  talkerLeakageDb,
  designZoneBeams,
  designFromBearings,
  bearingDirection,
  beamDesignSummary,
  lookDirection,
  cabs,
  MODE_DELAYSUM,
  MODE_SUPERDIRECTIVE,
} from '../src/beamformer/index.js';
import type { Direction, Complex } from '../src/beamformer/index.js';

const GEOM = sensibel8(0.05);
const F = 2000.0; // higher band → more directivity for a small array

function dir(azDeg: number, offNadirDeg = 70.0): Direction {
  const az = (azDeg * Math.PI) / 180;
  const n = (offNadirDeg * Math.PI) / 180;
  const s = Math.sin(n);
  return {
    unit: [s * Math.sin(az), s * Math.cos(az), -Math.cos(n)],
    azimuthDeg: azDeg,
    offNadirDeg,
    distanceM: 2.0,
    label: '',
  };
}

const isZero = (c: Complex) => c.re === 0 && c.im === 0;

// Local pure config helpers (mirror src/index.ts), so these tests do not import
// the index barrel — which transitively loads in-progress sibling modules.
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
function createTalker(id: string, label: string, position: Point2D): Talker {
  return { id, label, position };
}
function addTalker(c: SystemConfig, talker: Talker): SystemConfig {
  return { ...c, talkers: [...c.talkers, talker] };
}

function sceneWithZones() {
  let c = createConfig({ name: 'Room', createdAt: '2026-06-10T00:00:00Z' });
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

// --- core operations ---
describe('beamformer — core operations', () => {
  it('steering vector has unit magnitude and length 8', () => {
    const v = steeringVector(GEOM, dir(30).unit, F);
    expect(v.length).toBe(8);
    for (const c of v) {
      expect(cabs(c)).toBeCloseTo(1.0, 9);
    }
  });

  it('delay-and-sum has unit gain at the look direction', () => {
    const look = dir(45);
    const w = delayAndSumWeights(GEOM, look, F);
    expect(responseDb(w, GEOM, look.unit, F)).toBeCloseTo(0.0, 9);
  });

  it('delay-and-sum main lobe is the global max at the look azimuth', () => {
    const look = dir(90);
    const w = delayAndSumWeights(GEOM, look, F);
    const pat = beamPatternAzimuth(w, GEOM, F, { offNadirDeg: 70.0, steps: 180 });
    const peakAz = pat.reduce((best, t) => (t[1] > best[1] ? t : best))[0];
    expect(Math.min(Math.abs(peakAz - 90.0), 360 - Math.abs(peakAz - 90.0))).toBeLessThanOrEqual(6.0);
    const maxDb = Math.max(...pat.map(([, db]) => db));
    expect(maxDb).toBeLessThanOrEqual(0.05);
  });

  it('LCMV keeps pickup and nulls the exclusion', () => {
    const look = dir(90);
    const nullD = dir(270);
    const w = lcmvWeights(GEOM, look, [nullD], F);
    expect(responseDb(w, GEOM, look.unit, F)).toBeCloseTo(0.0, 6);
    expect(responseDb(w, GEOM, nullD.unit, F)).toBeLessThan(-60.0);
  });

  it('LCMV forms two nulls', () => {
    const look = dir(0);
    const nulls = [dir(120), dir(240)];
    const w = lcmvWeights(GEOM, look, nulls, F);
    expect(responseDb(w, GEOM, look.unit, F)).toBeCloseTo(0.0, 6);
    for (const n of nulls) {
      expect(responseDb(w, GEOM, n.unit, F)).toBeLessThan(-60.0);
    }
  });

  it('too many nulls raises', () => {
    const look = dir(0);
    const nulls: Direction[] = [];
    for (let a = 20; a < 360; a += 20) nulls.push(dir(a)); // > 7
    expect(() => lcmvWeights(GEOM, look, nulls, F)).toThrow();
  });

  it('a null coincident with the look raises', () => {
    const look = dir(50);
    expect(() => lcmvWeights(GEOM, look, [dir(50)], F)).toThrow();
  });

  it('white-noise gain of delay-and-sum is near 10·log10(M)', () => {
    const look = dir(60);
    const w = delayAndSumWeights(GEOM, look, F);
    const wng = whiteNoiseGainDb(w, GEOM, look, F);
    expect(wng).toBeCloseTo(10.0 * Math.log10(8), 1); // abs=0.5 → 1 digit ample
    expect(Math.abs(wng - 10.0 * Math.log10(8))).toBeLessThan(0.5);
  });
});

// --- zone-driven design (app entry point) ---
describe('beamformer — zone-driven design', () => {
  it('designZoneBeams picks up and attenuates the exclusion', () => {
    const c = sceneWithZones();
    const design = designZoneBeams(c, 'A', GEOM, { freqHz: F });
    expect(design.beams.length).toBe(1);
    const beam = design.beams[0]!;
    expect(beam.zoneId).toBe('p1');
    expect(beam.pickupGainDb).toBeCloseTo(0.0, 6);
    expect(beam.nulled).toBe(true);
    expect(beam.exclusionAttenDb[0]!).toBeLessThan(-20.0);
    expect(beamDesignSummary(design)).toContain('Presenter');
  });
});

// --- bearing-driven design (desk/table array, no room config needed) ---
describe('beamformer — bearing-driven design', () => {
  it('bearingDirection defaults to horizontal off-nadir', () => {
    const d = bearingDirection(90.0); // default off-nadir = 90° (horizontal)
    expect(d.offNadirDeg).toBe(90.0);
    expect(d.unit[2]).toBeCloseTo(0.0, 9); // purely horizontal look
    expect(Math.abs(d.unit[0])).toBeCloseTo(1.0, 9); // az 90° → +x
  });

  it('designFromBearings: unity on-axis and a deep null', () => {
    const look = bearingDirection(0.0); // front of desk
    const design = designFromBearings(GEOM, look, [[180.0, 90.0]], { freqHz: F });
    expect(design.beams.length).toBe(1);
    const beam = design.beams[0]!;
    expect(beam.pickupGainDb).toBeCloseTo(0.0, 5);
    expect(beam.nulled).toBe(true);
    expect(beam.nNulls).toBe(1);
    expect(responseDb([...beam.weights], GEOM, bearingDirection(180.0).unit, F)).toBeLessThan(-40.0);
  });

  it('designFromBearings accepts tuples', () => {
    const design = designFromBearings(GEOM, [0.0, 90.0], [[120.0, 90.0], [240.0, 90.0]], { freqHz: F });
    expect(design.beams[0]!.nNulls).toBe(2);
    expect(design.beams[0]!.pickupGainDb).toBeCloseTo(0.0, 5);
  });

  it('designFromBearings respects a dead capsule and the null budget', () => {
    const g = withActiveChannels(GEOM, [true, true, true, true, false, true, true, true]); // capsule 5 dead
    const look = bearingDirection(0.0);
    const nulls: Array<[number, number]> = [];
    for (let a = 20; a < 360; a += 20) nulls.push([a, 90.0]); // 17 nulls > budget (nActive-1 = 6)
    const design = designFromBearings(g, look, nulls, { freqHz: F });
    expect(design.beams[0]!.nNulls).toBe(6); // clamped to budget
    expect(design.beams[0]!.note).toContain('dropped');
    expect(isZero(design.beams[0]!.weights[4]!)).toBe(true); // dead capsule stays zero
  });

  it('designFromBearings delaysum mode has no nulls', () => {
    const design = designFromBearings(GEOM, [45.0, 90.0], [], { freqHz: F, mode: MODE_DELAYSUM });
    expect(design.mode).toBe(MODE_DELAYSUM);
    expect(design.beams[0]!.nulled).toBe(false);
    expect(design.beams[0]!.pickupGainDb).toBeCloseTo(0.0, 9);
  });

  it('a design with no pickup zones is empty', () => {
    let c = createConfig({ name: 'Room', createdAt: 'x' });
    c = setRoom(c, rectangularRoom(8, 6, 3));
    c = addDevice(c, createMicrophoneArray('A', 'Array'));
    c = setDevicePosition(c, 'A', { x: 4, y: 3 });
    const design = designZoneBeams(c, 'A', GEOM, { freqHz: F });
    expect(design.beams.length).toBe(0);
    expect(beamDesignSummary(design)).toContain('no pickup zones');
  });

  it('a design without exclusions uses delay-and-sum', () => {
    let c = createConfig({ name: 'Room', createdAt: 'x' });
    c = setRoom(c, rectangularRoom(8, 6, 3));
    const zones: CoverageZone[] = [
      {
        id: 'p1',
        type: 'dynamic',
        shape: { kind: 'rect', origin: { x: 6.5, y: 2.5 }, width: 1, height: 1 },
        alwaysOn: false,
        label: 'Presenter',
      },
    ];
    c = addDevice(c, createMicrophoneArray('A', 'Ceiling Array', 'automatic', zones));
    c = setDevicePosition(c, 'A', { x: 4, y: 3 });
    const design = designZoneBeams(c, 'A', GEOM, { freqHz: F });
    expect(design.beams[0]!.nulled).toBe(false);
    expect(design.beams[0]!.exclusionAttenDb).toEqual([]);
  });
});

// --- active-capsule mask (exclude a dead/non-audio channel) ---
describe('beamformer — active-capsule mask', () => {
  it('withActiveChannels masks and validates', () => {
    const g = withActiveChannels(GEOM, [...Array(7).fill(true), false]); // drop capsule 8
    expect(g.nChannels).toBe(8);
    expect(g.nActive).toBe(7);
    expect(g.activeIndices()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(() => withActiveChannels(GEOM, [...Array(7).fill(true)])).toThrow(); // wrong length
    expect(() => withActiveChannels(GEOM, [...Array(8).fill(false)])).toThrow(); // none active
  });

  it('delay-and-sum zeroes an inactive capsule and holds pickup', () => {
    const g = withActiveChannels(GEOM, [true, true, true, true, false, true, true, true]); // capsule 5 dead
    const look = dir(90);
    const w = delayAndSumWeights(g, look, F);
    expect(isZero(w[4]!)).toBe(true); // inactive → zero weight
    expect(w.filter((x) => !isZero(x)).length).toBe(7);
    expect(responseDb(w, g, look.unit, F)).toBeCloseTo(0.0, 9); // still unity on-axis
  });

  it('LCMV with a dead capsule still nulls', () => {
    const g = withActiveChannels(GEOM, [true, true, true, true, false, true, true, true]);
    const look = dir(90);
    const nullD = dir(270);
    const w = lcmvWeights(g, look, [nullD], F);
    expect(isZero(w[4]!)).toBe(true);
    expect(responseDb(w, g, look.unit, F)).toBeCloseTo(0.0, 6);
    expect(responseDb(w, g, nullD.unit, F)).toBeLessThan(-60.0);
  });

  it('null limit uses the active count', () => {
    // 3 active capsules can form at most 2 nulls
    const g = withActiveChannels(GEOM, [true, true, true, false, false, false, false, false]);
    const look = dir(0);
    expect(() => lcmvWeights(g, look, [dir(80), dir(160), dir(240)], F)).toThrow(); // 3 nulls > 2
  });

  it('design reports the active count in its summary', () => {
    const c = sceneWithZones();
    const g = withActiveChannels(GEOM, [...Array(7).fill(true), false]);
    const design = designZoneBeams(c, 'A', g, { freqHz: F, mode: MODE_DELAYSUM });
    expect(beamDesignSummary(design)).toContain('7/8 capsules');
    expect(isZero(design.beams[0]!.weights[7]!)).toBe(true);
  });
});

// --- superdirective beamforming (diffuse-noise rejection) ---
const SD_F = 800.0; // low-ish speech freq where superdirectivity helps most

describe('beamformer — superdirective', () => {
  it('diffuse coherence is unit-diagonal and symmetric', () => {
    const g = diffuseCoherence(GEOM, SD_F);
    expect(g.length).toBe(8);
    for (let i = 0; i < 8; i++) expect(g[i]![i]!).toBeCloseTo(1.0, 6);
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        expect(g[i]![j]!).toBeCloseTo(g[j]![i]!, 12);
      }
    }
  });

  it('superdirective has unity gain on-axis', () => {
    const look = dir(70);
    const w = superdirectiveWeights(GEOM, look, [], SD_F, 0.05);
    expect(responseDb(w, GEOM, look.unit, SD_F)).toBeCloseTo(0.0, 6);
  });

  it('superdirective beats delay-and-sum directivity', () => {
    const look = dir(70);
    const wDs = delayAndSumWeights(GEOM, look, SD_F);
    const wSd = superdirectiveWeights(GEOM, look, [], SD_F, 0.02);
    const diDs = directivityIndexDb(wDs, GEOM, look, SD_F);
    const diSd = directivityIndexDb(wSd, GEOM, look, SD_F);
    expect(diSd).toBeGreaterThan(diDs + 2.0);
  });

  it('more loading is more robust, less directive', () => {
    const look = dir(70);
    const wFocus = superdirectiveWeights(GEOM, look, [], SD_F, 0.005);
    const wRobust = superdirectiveWeights(GEOM, look, [], SD_F, 0.5);
    expect(whiteNoiseGainDb(wRobust, GEOM, look, SD_F)).toBeGreaterThan(
      whiteNoiseGainDb(wFocus, GEOM, look, SD_F),
    );
    expect(directivityIndexDb(wRobust, GEOM, look, SD_F)).toBeLessThan(
      directivityIndexDb(wFocus, GEOM, look, SD_F),
    );
  });

  it('superdirective still nulls the exclusion', () => {
    const look = dir(90);
    const nullD = dir(270);
    const w = superdirectiveWeights(GEOM, look, [nullD], SD_F, 0.02);
    expect(responseDb(w, GEOM, look.unit, SD_F)).toBeCloseTo(0.0, 5);
    expect(responseDb(w, GEOM, nullD.unit, SD_F)).toBeLessThan(-40.0);
  });

  it('default mode is superdirective and reports DI', () => {
    const c = sceneWithZones();
    const design = designZoneBeams(c, 'A', GEOM, { freqHz: SD_F });
    expect(design.mode).toBe(MODE_SUPERDIRECTIVE);
    expect(beamDesignSummary(design)).toContain('superdirective');
    expect(design.beams[0]!.diDb).toBeGreaterThan(0.0);
  });
});

// --- lobe analysis ---
describe('beamformer — lobe analysis', () => {
  it('main lobe is at the look azimuth with sensible counts', () => {
    const look = dir(90);
    const w = delayAndSumWeights(GEOM, look, 2000.0);
    const rep = analyzeLobes(w, GEOM, 2000.0, { offNadirDeg: 70.0 });
    expect(Math.min(Math.abs(rep.mainAzDeg - 90.0), 360 - Math.abs(rep.mainAzDeg - 90.0))).toBeLessThanOrEqual(6.0);
    expect(rep.nLobes).toBeGreaterThanOrEqual(1);
    expect(rep.beamwidth3dbDeg).toBeGreaterThan(0.0);
    expect(rep.peakSidelobeDb).toBeLessThanOrEqual(0.0);
  });

  it('grating lobes appear at high frequency', () => {
    const look = dir(90);
    const wHi = delayAndSumWeights(GEOM, look, 7000.0);
    const repHi = analyzeLobes(wHi, GEOM, 7000.0, { offNadirDeg: 80.0 });
    const repLo = analyzeLobes(delayAndSumWeights(GEOM, look, 1000.0), GEOM, 1000.0, { offNadirDeg: 80.0 });
    expect(repHi.nLobes).toBeGreaterThanOrEqual(repLo.nLobes);
    expect(Array.isArray(repHi.gratingLobes)).toBe(true);
  });

  it('ZoneBeam carries lobe stats', () => {
    const c = sceneWithZones();
    const b = designZoneBeams(c, 'A', GEOM, { freqHz: 2000.0 }).beams[0]!;
    expect(b.nLobes).toBeGreaterThanOrEqual(1);
    expect(b.peakSidelobeDb).toBeLessThanOrEqual(0.0);
    expect(beamDesignSummary(designZoneBeams(c, 'A', GEOM, { freqHz: 2000.0 }))).toContain('lobes:');
  });
});

// --- per-talker leakage + out-of-zone suppression ---
function sceneTwoTalkers() {
  let c = sceneWithZones(); // pickup zone p1 around (7,3) east, exclusion west
  c = addTalker(c, createTalker('T_in', 'InZone', { x: 7.0, y: 3.0 })); // inside pickup
  c = addTalker(c, createTalker('T_out', 'Outsider', { x: 2.0, y: 5.0 })); // not in any zone
  return c;
}

describe('beamformer — talker leakage and out-of-zone suppression', () => {
  it('talkerLeakageDb flags in/out of zone', () => {
    const c = sceneTwoTalkers();
    const b = designZoneBeams(c, 'A', GEOM, { freqHz: 2000.0 }).beams[0]!;
    const leak = talkerLeakageDb(c, 'A', GEOM, [...b.weights], 2000.0);
    const byId = new Map(leak.map((l) => [l.talkerId, l]));
    expect(byId.get('T_in')!.inPickup).toBe(true);
    expect(byId.get('T_out')!.inPickup).toBe(false);
    expect(byId.get('T_in')!.gainDb).toBeGreaterThan(byId.get('T_out')!.gainDb);
  });

  it('suppressOutsideTalkers nulls the outsider', () => {
    const c = sceneTwoTalkers();
    const base = designZoneBeams(c, 'A', GEOM, { freqHz: 2000.0 });
    const supp = designZoneBeams(c, 'A', GEOM, { freqHz: 2000.0, suppressOutsideTalkers: true });
    expect(supp.beams[0]!.nNulls).toBeGreaterThan(base.beams[0]!.nNulls); // added a null for the outsider
    const outDir = lookDirection(c, 'A', { x: 2.0, y: 5.0 });
    const gBase = responseDb([...base.beams[0]!.weights], GEOM, outDir.unit, 2000.0);
    const gSupp = responseDb([...supp.beams[0]!.weights], GEOM, outDir.unit, 2000.0);
    expect(gSupp).toBeLessThan(gBase - 10.0);
    expect(supp.nullDirs.length).toBeGreaterThan(0); // nulls recorded for the live runtime
  });
});

// --- steering (zone → look direction) ---
function scene() {
  let c = createConfig({ name: 'Room', createdAt: '2026-06-10T00:00:00Z' });
  c = setRoom(c, rectangularRoom(8, 6, 3));
  c = addDevice(c, createMicrophoneArray('A', 'Ceiling Array'));
  c = setDevicePosition(c, 'A', { x: 4, y: 3 }); // array centred
  return c;
}

describe('steering — zone to look direction', () => {
  it('look direction straight down under the array', () => {
    const c = scene();
    const d = lookDirection(c, 'A', { x: 4, y: 3 }); // directly below the array
    expect(d.offNadirDeg).toBeCloseTo(0.0, 6);
    expect(d.unit[2]).toBeLessThan(0); // pointing down
    expect(d.unit[0]).toBeCloseTo(0.0, 6);
    expect(d.unit[1]).toBeCloseTo(0.0, 6);
  });

  it('look direction to the east has positive x', () => {
    const c = scene();
    const d = lookDirection(c, 'A', { x: 7, y: 3 }); // east of the array
    expect(d.unit[0]).toBeGreaterThan(0.2);
    expect(d.azimuthDeg).toBeCloseTo(90.0, 0); // +X = 90° bearing (abs=1.0)
    const norm = Math.sqrt(d.unit.reduce((acc, v) => acc + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 9);
  });

  it('no position raises', () => {
    let c = createConfig({ name: 'Room', createdAt: 'x' });
    c = setRoom(c, rectangularRoom(8, 6, 3));
    c = addDevice(c, createMicrophoneArray('A', 'Array')); // no position
    expect(() => lookDirection(c, 'A', { x: 1, y: 1 })).toThrow();
  });

  it('not-an-array raises', () => {
    let c = createConfig({ name: 'Room', createdAt: 'x' });
    c = addDevice(c, createProcessor('P', 'DSP'));
    expect(() => lookDirection(c, 'P', { x: 1, y: 1 })).toThrow();
  });
});
