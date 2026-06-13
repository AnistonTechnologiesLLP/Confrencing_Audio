/**
 * Scene scheduler — recall scenes on the config's weekly schedule.
 *
 * Executes the {@link SceneSchedule} entries stored in `config.control.schedules`:
 * at each entry's local `"HH:MM"` on its weekdays, the scene is recalled through
 * the same `getConfig` / `apply` pair the control API uses, so the GUI, the HTTP
 * API, and the scheduler all mutate one consistent config.
 *
 * Deterministic by construction: the clock is injectable (`now`) and
 * {@link SceneScheduler.runPending} is a manual tick, so tests (or a UI timer)
 * can drive it without timers. {@link SceneScheduler.start} adds a small polling
 * loop for headless use. An entry fires at most once per scheduled minute; a
 * schedule whose scene has vanished is skipped (validation flags it as
 * `SCHEDULE_INVALID`).
 */

import type { SystemConfig } from '../model/config.js';
import { type SceneSchedule, WEEKDAYS, parseHhmm } from '../model/control.js';
import { recallScene } from '../scenes/scenes.js';

/** A clock function returning "now". Injectable for deterministic tests. */
export type SchedulerClock = () => Date;

/** A pure config transform. */
type Transform = (config: SystemConfig) => SystemConfig;

/** Monday-first weekday index (0=mon..6=sun) for a JS `Date` (whose `getDay()` is Sunday-first). */
function weekdayKey(d: Date): string {
  return WEEKDAYS[(d.getDay() + 6) % 7]!;
}

/** Local "YYYY-MM-DD HH:MM" stamp (the firing-dedup key per scheduled minute). */
function minuteStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function matches(schedule: SceneSchedule, now: Date): boolean {
  const hm = parseHhmm(schedule.time);
  if (!hm || !schedule.enabled) return false;
  return schedule.days.includes(weekdayKey(now)) && now.getHours() === hm[0] && now.getMinutes() === hm[1];
}

/** The next moment any enabled entry is due, scanning a week ahead. `null` if none. */
export function nextFire(schedules: SceneSchedule[], now: Date): Date | null {
  let best: Date | null = null;
  const nowFloor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0);
  for (const s of schedules) {
    const hm = parseHhmm(s.time);
    if (!hm || !s.enabled || s.days.length === 0) continue;
    for (let ahead = 0; ahead < 8; ahead++) {
      const day = new Date(now.getTime());
      day.setDate(day.getDate() + ahead);
      if (!s.days.includes(weekdayKey(day))) continue;
      const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hm[0], hm[1], 0, 0);
      if (candidate.getTime() < nowFloor.getTime()) continue;
      if (best === null || candidate.getTime() < best.getTime()) best = candidate;
      break;
    }
  }
  return best;
}

/** Drives scene recalls from the config's schedule entries. */
export class SceneScheduler {
  private readonly getConfig: () => SystemConfig;
  private readonly apply: (t: Transform) => SystemConfig;
  private readonly now: SchedulerClock;
  private fired = new Map<string, string>(); // schedule id → minute stamp last fired
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    getConfig: () => SystemConfig,
    apply: (t: Transform) => SystemConfig,
    opts: { now?: SchedulerClock } = {},
  ) {
    this.getConfig = getConfig;
    this.apply = apply;
    this.now = opts.now ?? ((): Date => new Date());
  }

  /**
   * Recall every entry due *now* (once per scheduled minute). Returns the scene
   * ids recalled this tick.
   */
  runPending(): string[] {
    const now = this.now();
    const stamp = minuteStamp(now);
    const config = this.getConfig();
    const schedules = config.control?.schedules ?? [];
    const recalled: string[] = [];
    for (const s of schedules) {
      if (!matches(s, now) || this.fired.get(s.id) === stamp) continue;
      this.fired.set(s.id, stamp); // at most once per scheduled minute
      try {
        this.apply((c) => recallScene(c, s.sceneId));
      } catch {
        continue; // scene vanished — validation's problem
      }
      recalled.push(s.sceneId);
    }
    // drop stale dedup marks so the map can't grow without bound
    const fresh = new Map<string, string>();
    for (const [k, v] of this.fired) if (v === stamp) fresh.set(k, v);
    this.fired = fresh;
    return recalled;
  }

  /** The next moment any enabled entry is due. */
  nextFire(): Date | null {
    const config = this.getConfig();
    return nextFire([...(config.control?.schedules ?? [])], this.now());
  }

  /** Whether the background polling loop is running. */
  get running(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Poll {@link runPending} on a timer. Sub-minute polling is enough — firing is
   * deduplicated per scheduled minute.
   */
  start(pollSeconds = 15): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.runPending(), pollSeconds * 1000);
  }

  /** Stop the background polling loop. */
  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
