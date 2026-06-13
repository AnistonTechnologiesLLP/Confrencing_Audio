import { describe, it, expect } from 'vitest';
import {
  createConfig,
  addDevice,
  addCoverageZone,
  addMuteGroup,
  createMuteGroup,
  addScene,
  createScene,
  addSceneSchedule,
  createSceneSchedule,
  removeSceneSchedule,
  setSceneScheduleEnabled,
  getScene,
  serialize,
  deserialize,
  validate,
  findDevice,
  dynamicZone,
  WEEKDAYS,
  CONFIG_VERSION,
  type SystemConfig,
  type SceneSchedule,
} from '../src/index.js';
import { ConfigHolder, ControlApiServer } from '../src/node.js';
import { createMicrophoneArray } from '../src/coverage/coverage.js';
import { SceneScheduler, nextFire } from '../src/scheduler/scheduler.js';

/**
 * Mirror of conf_pipeline-py/tests/test_scheduler.py.
 *
 * Scene scheduler: schedule round-trip + validation, and deterministic
 * clock-driven firing (no sleeps — the scheduler takes an injectable clock).
 *
 * NOTE Python `datetime.weekday()` is Monday=0; JS `Date.getDay()` is Sunday=0.
 * The TS port handles this internally, so we pass JS Dates whose intended
 * weekday is correct. JS months are 0-indexed (June = 5). June 16, 2026 is a
 * Tuesday; June 23, 2026 is the following Tuesday.
 */

// a Tuesday, mid-minute (Python: datetime(2026, 6, 16, 9, 0, 12))
const TUE_0900 = new Date(2026, 5, 16, 9, 0, 12);

function config(): SystemConfig {
  let c = createConfig({ name: 'Room', createdAt: '2026-06-12T00:00:00Z' });
  c = addDevice(c, createMicrophoneArray('A', 'Array'));
  // CoverageZone("z1", "dynamic", RectShape(Point2D(1, 1), 2, 2), False, "T")
  c = addCoverageZone(
    c,
    'A',
    dynamicZone('z1', 'T', { kind: 'rect', origin: { x: 1, y: 1 }, width: 2, height: 2 }),
  );
  c = addMuteGroup(c, createMuteGroup('mg1', 'Room', { deviceIds: ['A'] }));
  c = addScene(
    c,
    createScene('meeting', 'Meeting', {
      muteStates: { mg1: false },
      zoneStates: [{ arrayId: 'A', zoneId: 'z1', gainDb: -2.0 }],
    }),
  );
  c = addScene(c, createScene('lecture', 'Lecture', { muteStates: { mg1: true } }));
  return c;
}

function scheduled(
  opts: { time?: string; days?: string[]; enabled?: boolean; scene?: string } = {},
): SystemConfig {
  const time = opts.time ?? '09:00';
  const days = opts.days ?? ['tue'];
  const enabled = opts.enabled ?? true;
  const scene = opts.scene ?? 'lecture';
  return addSceneSchedule(config(), createSceneSchedule('t1', scene, time, { days, enabled }));
}

// --- schema (additive on v3) ---
describe('schedule schema', () => {
  it('round-trips and is additive', () => {
    const c = scheduled();
    const d = JSON.parse(serialize(c)) as Record<string, any>;
    expect(d['version']).toBe(CONFIG_VERSION); // schedules are additive
    expect(d['control']['schedules']).toEqual([
      { id: 't1', sceneId: 'lecture', time: '09:00', days: ['tue'], enabled: true },
    ]);
    const restored = deserialize(serialize(c));
    expect(serialize(restored)).toBe(serialize(c));
    const s = restored.control!.schedules[0]!;
    expect(s.sceneId).toBe('lecture');
    expect(s.days).toEqual(['tue']);
    expect(s.enabled).toBe(true);
    // a v3 file written before schedules existed still loads
    delete d['control']['schedules'];
    const older = deserialize(JSON.stringify(d));
    expect(older.control!.schedules).toEqual([]);
  });

  it('builders and dup guard', () => {
    let c = scheduled();
    expect(() => addSceneSchedule(c, createSceneSchedule('t1', 'meeting', '10:00'))).toThrow();
    c = setSceneScheduleEnabled(c, 't1', false);
    expect(c.control!.schedules[0]!.enabled).toBe(false);
    expect(getScene(c, 'lecture')).not.toBeUndefined(); // scenes untouched
    c = removeSceneSchedule(c, 't1');
    expect(c.control!.schedules).toEqual([]);
    expect(removeSceneSchedule(c, 't1')).toBe(c); // idempotent no-op
  });

  it('default days are every day', () => {
    const s = createSceneSchedule('d', 'meeting', '08:00');
    expect(s.days).toEqual([...WEEKDAYS]);
  });
});

// --- validation ---
describe('schedule validation', () => {
  it('validation matrix', () => {
    const c = scheduled();
    expect(validate(c).errors.filter((e) => e.code === 'SCHEDULE_INVALID')).toEqual([]);
    let bad = c;
    bad = addSceneSchedule(bad, createSceneSchedule('ghost', 'nope', '09:00'));
    bad = addSceneSchedule(bad, createSceneSchedule('badtime', 'meeting', '24:00'));
    bad = addSceneSchedule(bad, createSceneSchedule('badtime2', 'meeting', '9:5'));
    bad = addSceneSchedule(bad, createSceneSchedule('nodays', 'meeting', '09:00', { days: [] }));
    bad = addSceneSchedule(bad, createSceneSchedule('badday', 'meeting', '09:00', { days: ['funday'] }));
    const msgs = validate(bad)
      .errors.filter((e) => e.code === 'SCHEDULE_INVALID')
      .map((e) => e.message)
      .join(' | ');
    expect(msgs).toContain('missing scene "nope"');
    expect(msgs).toContain('invalid time "24:00"');
    expect(msgs).toContain('invalid time "9:5"');
    expect(msgs).toContain('has no days');
    expect(msgs).toContain('unknown day "funday"');
  });

  it('duplicate schedule ids flagged', () => {
    const c = scheduled();
    // c.control.schedules = [*c.control.schedules, create_scene_schedule("t1", "meeting", "10:00")]
    const dup: SystemConfig = {
      ...c,
      control: {
        ...c.control!,
        schedules: [...c.control!.schedules, createSceneSchedule('t1', 'meeting', '10:00')],
      },
    };
    const msgs = validate(dup)
      .errors.filter((e) => e.code === 'SCHEDULE_INVALID')
      .map((e) => e.message);
    expect(msgs.some((m) => m.includes('Duplicate schedule id'))).toBe(true);
  });
});

// --- firing (clock-driven, no sleeps) ---
interface Clock {
  now: Date;
}

function buildScheduler(
  cfg: SystemConfig,
  now: Date,
): { sched: SceneScheduler; holder: ConfigHolder; clock: Clock } {
  const holder = new ConfigHolder(cfg);
  const clock: Clock = { now };
  const sched = new SceneScheduler(
    () => holder.get(),
    (t) => holder.apply(t),
    { now: () => clock.now },
  );
  return { sched, holder, clock };
}

describe('schedule firing', () => {
  it('fires at matching minute and day', () => {
    const { sched, holder } = buildScheduler(scheduled(), TUE_0900);
    expect(sched.runPending()).toEqual(['lecture']);
    expect(holder.get().control!.muteGroups[0]!.muted).toBe(true); // scene applied
  });

  it('fires once per scheduled minute then re-arms', () => {
    const { sched, clock } = buildScheduler(scheduled(), TUE_0900);
    expect(sched.runPending()).toEqual(['lecture']);
    clock.now = new Date(2026, 5, 16, 9, 0, 45); // same minute, second=45
    expect(sched.runPending()).toEqual([]); // same minute: deduped
    clock.now = new Date(2026, 5, 23, 9, 0, 3); // next Tuesday
    expect(sched.runPending()).toEqual(['lecture']); // re-armed
  });

  it('respects day filter, disabled flag, and wrong minute', () => {
    const { sched } = buildScheduler(scheduled({ days: ['wed'] }), TUE_0900);
    expect(sched.runPending()).toEqual([]); // Tuesday != wed
    const { sched: sched2 } = buildScheduler(scheduled({ enabled: false }), TUE_0900);
    expect(sched2.runPending()).toEqual([]); // disabled
    const { sched: sched3 } = buildScheduler(scheduled(), new Date(2026, 5, 16, 9, 1, 12));
    expect(sched3.runPending()).toEqual([]); // 09:01 != 09:00
  });

  it('two entries same minute both fire in order', () => {
    let c = scheduled(); // lecture @ 09:00 tue
    c = addSceneSchedule(c, createSceneSchedule('t2', 'meeting', '09:00', { days: ['tue'] }));
    const { sched, holder } = buildScheduler(c, TUE_0900);
    expect(sched.runPending()).toEqual(['lecture', 'meeting']);
    const arr = findDevice(holder.get(), 'A')!;
    if (arr.type !== 'microphoneArray') throw new Error('expected microphone array');
    expect(arr.zones[0]!.gainDb).toBe(-2.0); // meeting's gain landed
  });

  it('dangling scene is skipped without aborting the tick', () => {
    let c = scheduled();
    c = addSceneSchedule(c, createSceneSchedule('t0', 'vanished', '09:00', { days: ['tue'] }));
    // c.control.schedules.reverse() — dangling first
    c = {
      ...c,
      control: { ...c.control!, schedules: [...c.control!.schedules].reverse() },
    };
    const { sched, holder } = buildScheduler(c, TUE_0900);
    expect(sched.runPending()).toEqual(['lecture']); // the good one still fired
    expect(holder.get().control!.muteGroups[0]!.muted).toBe(true);
  });

  it('next fire same day and week wrap', () => {
    const schedules: SceneSchedule[] = [
      createSceneSchedule('a', 's', '10:30', { days: ['tue'] }),
      createSceneSchedule('b', 's', '08:00', { days: ['mon'] }),
    ];
    const nxt = nextFire(schedules, TUE_0900);
    // later today beats next Monday: datetime(2026, 6, 16, 10, 30)
    expect(nxt).toEqual(new Date(2026, 5, 16, 10, 30));
    const nxt2 = nextFire([createSceneSchedule('c', 's', '08:00', { days: ['tue'] })], TUE_0900);
    // already past -> next week: datetime(2026, 6, 23, 8, 0)
    expect(nxt2).toEqual(new Date(2026, 5, 23, 8, 0));
    expect(
      nextFire([createSceneSchedule('d', 's', '08:00', { days: ['tue'], enabled: false })], TUE_0900),
    ).toBeNull();
  });

  it('scheduler lifecycle', () => {
    // Python uses `with sched:` (start/stop). TS exposes start()/stop()/running.
    const { sched } = buildScheduler(scheduled(), TUE_0900);
    sched.start();
    expect(sched.running).toBe(true);
    sched.stop();
    expect(sched.running).toBe(false);
    sched.stop(); // idempotent
    expect(sched.running).toBe(false);
  });
});

// --- status endpoint reports schedules ---
describe('status endpoint', () => {
  it('reports schedules', async () => {
    const holder = new ConfigHolder(scheduled());
    const srv = new ControlApiServer(
      () => holder.get(),
      (t) => holder.apply(t),
    );
    await srv.start();
    try {
      const res = await fetch(srv.url + '/api/status');
      const d = (await res.json()) as Record<string, unknown>;
      expect(d['schedules']).toEqual([
        { id: 't1', sceneId: 'lecture', time: '09:00', days: ['tue'], enabled: true },
      ]);
    } finally {
      await srv.stop();
    }
  });
});
