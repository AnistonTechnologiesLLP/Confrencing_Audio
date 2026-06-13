import { describe, it, expect } from 'vitest';
// NOTE: the config-builder helpers normally re-exported from `../src/index.js`
// are reconstructed locally here so this suite does not transitively import
// `../src/index.js` (and thus whatever modules other in-progress agents add to
// it). Everything below is a thin, pure clone of the corresponding index/editing
// helper, importing only from leaf modules the simulation engine itself uses.
import { createConfig } from '../src/config/create.js';
import { serialize } from '../src/persistence/serialize.js';
import {
  createMicrophoneArray,
  dynamicZone,
  exclusionZone,
  addCoverageZone as arrayAddCoverageZone,
} from '../src/coverage/coverage.js';
import {
  type CoverageZone,
  type Device,
  type MicrophoneArray,
  type Point2D,
  type RectShape,
  type RoomLayout,
  type SystemConfig,
  type Talker,
  pointInShape,
  pointInPolygon,
} from '../src/model/index.js';
import {
  recommendPlacement,
  scoreHeatmap,
  scorePlacement,
  estimatedRt60,
  validateRecommendation,
  availableBackends,
  numpyAvailable,
  defaultSimParams,
  type Candidate,
} from '../src/sim/index.js';
import { criticalDistance, drrDb } from '../src/sim/scoring.js';

// --------------------------------------------------------------------------- //
// local pure config builders (clones of the `../src/index.js` editing helpers)
// --------------------------------------------------------------------------- //
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
  if (c.devices.some((d) => d.id === device.id)) {
    throw new Error(`Duplicate device id: ${device.id}`);
  }
  return { ...c, devices: [...c.devices, device] };
}

function setDevicePosition(c: SystemConfig, deviceId: string, position: Point2D): SystemConfig {
  return {
    ...c,
    devices: c.devices.map((d) => (d.id === deviceId ? { ...d, position } : d)),
  };
}

function createTalker(id: string, label: string, position: Point2D, elevation?: number): Talker {
  const t: Talker = { id, label, position };
  if (elevation !== undefined) t.elevation = elevation;
  return t;
}

function addTalker(c: SystemConfig, talker: Talker): SystemConfig {
  if (c.talkers.some((t) => t.id === talker.id)) {
    throw new Error(`Duplicate talker id: ${talker.id}`);
  }
  return { ...c, talkers: [...c.talkers, talker] };
}

function addCoverageZone(c: SystemConfig, arrayId: string, zone: CoverageZone): SystemConfig {
  return {
    ...c,
    devices: c.devices.map((d) => {
      if (d.id !== arrayId) return d;
      if (d.type !== 'microphoneArray') {
        throw new Error(`Device ${arrayId} is not a microphone array.`);
      }
      return arrayAddCoverageZone(d as MicrophoneArray, zone);
    }),
  };
}

// --------------------------------------------------------------------------- //
// helpers
// --------------------------------------------------------------------------- //
function config(width = 8, depth = 6, height = 3.0): SystemConfig {
  let c = createConfig({ name: 'sim', createdAt: '2026-06-09T00:00:00Z' });
  c = setRoom(c, rectangularRoom(width, depth, height));
  c = addDevice(c, createMicrophoneArray('A', 'Array', 'automatic'));
  return c;
}

function rect(x: number, y: number, width: number, height: number): RectShape {
  return { kind: 'rect', origin: { x, y }, width, height };
}

// --------------------------------------------------------------------------- //
// 1. array sits ~above a single talker (array-only mode)
// --------------------------------------------------------------------------- //
describe('array recommended above single talker', () => {
  it('places array roughly above the talker at ceiling height', () => {
    let c = config();
    c = addTalker(c, createTalker('T1', 'Presenter', { x: 5, y: 3 }));
    const rec = recommendPlacement(c, 'A', null, defaultSimParams({ gridStepM: 0.5 }));
    expect(Math.abs(rec.arrayPos.x - 5)).toBeLessThanOrEqual(0.6);
    expect(Math.abs(rec.arrayPos.y - 3)).toBeLessThanOrEqual(0.6);
    // array elevation defaults to the ceiling (room height)
    expect(rec.arrayElev).toBeCloseTo(3.0, 6);
  });
});

// --------------------------------------------------------------------------- //
// 2. recommended seat avoids an exclusion zone; array ends up above the seat
// --------------------------------------------------------------------------- //
describe('seat recommended avoids exclusion and aligns with array', () => {
  it('seats outside the dead zone and inside the room with array above', () => {
    let c = config(10, 8);
    const excl = exclusionZone('x1', 'dead', rect(0, 0, 4, 8));
    c = addCoverageZone(c, 'A', excl);
    c = addTalker(c, createTalker('T1', 'Speaker', { x: 7, y: 4 }));
    const rec = recommendPlacement(c, 'A', 'T1', defaultSimParams({ gridStepM: 0.5 }));

    expect(rec.talkerPos).not.toBeNull();
    expect(pointInShape(rec.talkerPos!, excl.shape)).toBe(false); // not in the dead zone
    expect(pointInPolygon(rec.talkerPos!, c.room!.vertices)).toBe(true); // inside the room
    // the joint optimum mounts the array straight above the seat
    expect(Math.abs(rec.arrayPos.x - rec.talkerPos!.x)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(rec.arrayPos.y - rec.talkerPos!.y)).toBeLessThanOrEqual(0.2);
  });
});

// --------------------------------------------------------------------------- //
// 3. fairness pulls the array toward the midpoint of two opposed talkers
// --------------------------------------------------------------------------- //
describe('fairness places array between two talkers', () => {
  it('lands near the midpoint and serves both similarly', () => {
    let c = config(10, 6);
    c = addTalker(c, createTalker('T1', 'Left', { x: 2, y: 3 }));
    c = addTalker(c, createTalker('T2', 'Right', { x: 8, y: 3 }));
    const rec = recommendPlacement(c, 'A', null, defaultSimParams({ gridStepM: 0.5 }));
    expect(Math.abs(rec.arrayPos.x - 5)).toBeLessThanOrEqual(0.6);
    expect(Math.abs(rec.arrayPos.y - 3)).toBeLessThanOrEqual(0.6);
    // both talkers end up similarly well served
    const totals = Object.values(rec.perTalker).map((s) => s.total);
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThan(0.1);
  });
});

// --------------------------------------------------------------------------- //
// 4. RT60 / DRR monotonicity (pure arithmetic)
// --------------------------------------------------------------------------- //
describe('RT60 / DRR', () => {
  it('RT60 grows with volume', () => {
    const small = setRoom(createConfig({ name: 's', createdAt: 'x' }), rectangularRoom(4, 3, 2.5));
    const big = setRoom(createConfig({ name: 'b', createdAt: 'x' }), rectangularRoom(12, 10, 4));
    expect(estimatedRt60(big)).toBeGreaterThan(estimatedRt60(small));
  });

  it('DRR decreases with distance', () => {
    const c = config();
    const dc = criticalDistance(c, defaultSimParams());
    const near = drrDb(1.5, dc);
    const far = drrDb(5.0, dc);
    expect(near).not.toBeNull();
    expect(far).not.toBeNull();
    expect(near!).toBeGreaterThan(far!);
  });

  it('estimatedRt60 uses the supplied value', () => {
    const c = config();
    expect(estimatedRt60(c, defaultSimParams({ rt60S: 0.9 }))).toBeCloseTo(0.9, 9);
  });
});

// --------------------------------------------------------------------------- //
// 5. purity + determinism
// --------------------------------------------------------------------------- //
describe('purity + determinism', () => {
  it('recommend does not mutate config', () => {
    let c = config();
    c = addTalker(c, createTalker('T1', 'P', { x: 4, y: 3 }));
    const before = serialize(c);
    recommendPlacement(c, 'A', 'T1');
    scoreHeatmap(c, 'A');
    expect(serialize(c)).toBe(before);
  });

  it('recommend is deterministic', () => {
    let c = config();
    c = addTalker(c, createTalker('T1', 'P', { x: 4, y: 3 }));
    const r1 = recommendPlacement(c, 'A', 'T1');
    const r2 = recommendPlacement(c, 'A', 'T1');
    expect(r1).toEqual(r2);
  });
});

// --------------------------------------------------------------------------- //
// 6. edge cases
// --------------------------------------------------------------------------- //
describe('edge cases', () => {
  it('no room still recommends', () => {
    let c = createConfig({ name: 'nr', createdAt: 'x' });
    c = addDevice(c, createMicrophoneArray('A', 'Array', 'automatic'));
    c = addTalker(c, createTalker('T1', 'P', { x: 3, y: 2 }));
    const rec = recommendPlacement(c, 'A', 'T1');
    expect(rec.arrayPos).not.toBeNull();
    expect(rec.talkerPos).not.toBeNull();
  });

  it('no talkers sets note and does not crash', () => {
    const c = config();
    const rec = recommendPlacement(c, 'A', null);
    expect(rec.note.length).toBeGreaterThan(0); // non-empty caveat
    const hm = scoreHeatmap(c, 'A');
    expect(hm.nx).toBeGreaterThan(0);
    expect(hm.ny).toBeGreaterThan(0);
  });

  it('talker outside room is seated inside', () => {
    let c = config(8, 6);
    c = addTalker(c, createTalker('T1', 'Stray', { x: 100, y: 100 }));
    const rec = recommendPlacement(c, 'A', 'T1');
    expect(pointInPolygon(rec.talkerPos!, c.room!.vertices)).toBe(true);
  });

  it('no array raises', () => {
    const c = createConfig({ name: 'na', createdAt: 'x' });
    expect(() => recommendPlacement(c, null)).toThrowError();
  });
});

// --------------------------------------------------------------------------- //
// 6b. regression guards (from the adversarial review)
// --------------------------------------------------------------------------- //
describe('regression guards', () => {
  it('seat never in exclusion when a valid seat exists', () => {
    let c = config(10, 8);
    const excl = exclusionZone('x1', 'dead', rect(0, 0, 5, 8));
    c = addCoverageZone(c, 'A', excl);
    c = addTalker(c, createTalker('T1', 'Stuck', { x: 2, y: 4 })); // inside exclusion
    const rec = recommendPlacement(c, 'A', 'T1');
    expect(pointInShape(rec.talkerPos!, excl.shape)).toBe(false);
    expect(rec.score.inExclusionZone).toBe(false);
  });

  it('zero refine step does not crash', () => {
    let c = config();
    c = addTalker(c, createTalker('T1', 'P', { x: 4, y: 3 }));
    const rec = recommendPlacement(c, 'A', 'T1', defaultSimParams({ refineStepM: 0.0 }));
    expect(rec.talkerPos).not.toBeNull();
  });

  it('scorePlacement matches recommend after relocation', () => {
    let c = config(10, 6);
    c = addTalker(c, createTalker('T1', 'Mover', { x: 8, y: 3 }));
    c = addTalker(c, createTalker('T2', 'Fixed', { x: 2, y: 3 }));
    const rec = recommendPlacement(c, 'A', 'T1');
    const cand: Candidate = {
      arrayPos: rec.arrayPos,
      arrayElev: rec.arrayElev,
      steerOffNadirDeg: rec.steerOffNadirDeg,
      steerAzDeg: rec.steerAzDeg,
      talkerPos: rec.talkerPos,
      talkerElev: 1.2,
    };
    const ps = scorePlacement(c, 'A', cand, defaultSimParams(), 'T1');
    expect(ps.total).toBeCloseTo(rec.score.total, 9);
    expect(ps.fairness).toBeCloseTo(rec.score.fairness, 9);
  });
});

// --------------------------------------------------------------------------- //
// 9. table-aware seating + multi-array fairness
// --------------------------------------------------------------------------- //
describe('table-aware seating + multi-array fairness', () => {
  it('seat lands at the table when a pickup zone is defined', () => {
    let c = config(12, 8);
    const table = dynamicZone('A-tbl', 'Table', rect(4, 3, 4, 2));
    c = addCoverageZone(c, 'A', table);
    c = addTalker(c, createTalker('T1', 'Presenter', { x: 1, y: 7 })); // currently off the table
    const rec = recommendPlacement(c, 'A', 'T1');
    expect(pointInShape(rec.talkerPos!, table.shape)).toBe(true);
  });

  it('no pickup zone leaves seating unconstrained', () => {
    let c = config(10, 8);
    c = addTalker(c, createTalker('T1', 'P', { x: 8, y: 6 }));
    const rec = recommendPlacement(c, 'A', 'T1');
    expect(pointInPolygon(rec.talkerPos!, c.room!.vertices)).toBe(true);
  });

  it('multi-array fairness uses the best-covering array', () => {
    let c = createConfig({ name: 'ma', createdAt: 'x' });
    c = setRoom(c, rectangularRoom(12, 6, 3));
    c = addDevice(c, createMicrophoneArray('A1', 'A1', 'automatic'));
    c = addDevice(c, createMicrophoneArray('A2', 'A2', 'automatic'));
    c = setDevicePosition(c, 'A2', { x: 10, y: 3 }); // A2 fixed directly above the far talker
    c = addTalker(c, createTalker('T1', 'near A1', { x: 2, y: 3 }));
    c = addTalker(c, createTalker('T2', 'near A2', { x: 10, y: 3 }));
    // array-only mode (talkers fixed) so a single array can't just cluster everyone
    const multi = recommendPlacement(c, 'A1', null);
    const single = recommendPlacement(c, 'A1', null, defaultSimParams({ considerAllArrays: false }));
    expect(multi.perTalker['T2']!.total).toBeGreaterThan(single.perTalker['T2']!.total + 0.15);
  });
});

// --------------------------------------------------------------------------- //
// 7. heatmap shape
// --------------------------------------------------------------------------- //
describe('heatmap shape', () => {
  it('covers the grid', () => {
    let c = config();
    c = addTalker(c, createTalker('T1', 'P', { x: 4, y: 3 }));
    const hm = scoreHeatmap(c, 'A', defaultSimParams({ gridStepM: 0.5 }));
    expect(hm.values.length).toBe(hm.nx * hm.ny);
    expect(hm.vmax).toBeGreaterThanOrEqual(hm.vmin);
    // at least some interior cells scored (non-null)
    expect(hm.values.some((v) => v !== null)).toBe(true);
  });
});

// --------------------------------------------------------------------------- //
// 8. capability probing + (absent) validator
// --------------------------------------------------------------------------- //
describe('capability probing + validator', () => {
  it('backend probing is safe', () => {
    expect(typeof numpyAvailable()).toBe('boolean');
    expect(Array.isArray(availableBackends())).toBe(true);
  });

  it('validator requires a backend', () => {
    let c = config();
    c = addTalker(c, createTalker('T1', 'P', { x: 4, y: 3 }));
    const rec = recommendPlacement(c, 'A', 'T1');
    if (availableBackends().length === 0) {
      expect(() => validateRecommendation(c, rec)).toThrowError();
    }
  });
});
