/**
 * Single-beam auto-steer: turns a DOA result into the next look azimuth for the
 * Phase-1 fractional-delay-and-sum beam. 'follow' tracks the dominant in-sector
 * talker (via the hold/switch tracker); 'lockSeat' pins a fixed seat azimuth. A
 * deadband suppresses tiny re-aims. Pure, zero-dep. Multi-bearing/nulling is a
 * later (frequency-domain) phase.
 */
import { inSector, circularSep, type DoaResult, type Detection } from './doa.js';
import { TalkerTracker } from './tracker.js';

export interface SectorSpec {
  centerDeg: number;
  halfWidthDeg: number;
  frontOffsetDeg?: number;
}

export interface AutoSteerOptions {
  mode: 'follow' | 'lockSeat';
  sector?: SectorSpec;
  lockAzimuthDeg?: number;
  switchMarginDeg?: number;
  holdHops?: number;
  deadbandDeg?: number;
}

export class AutoSteerController {
  private readonly opts: AutoSteerOptions;
  private readonly tracker: TalkerTracker;
  private readonly deadbandDeg: number;
  private current: number | null = null;

  constructor(opts: AutoSteerOptions) {
    this.opts = opts;
    this.deadbandDeg = opts.deadbandDeg ?? 3;
    this.tracker = new TalkerTracker({
      ...(opts.switchMarginDeg !== undefined ? { switchMarginDeg: opts.switchMarginDeg } : {}),
      ...(opts.holdHops !== undefined ? { holdHops: opts.holdHops } : {}),
    });
  }

  /** Decide the next look azimuth, or null to leave the beam where it is. */
  decide(doa: DoaResult): { lookAzimuthDeg: number | null } {
    let target: number | null;
    if (this.opts.mode === 'lockSeat') {
      target = this.opts.lockAzimuthDeg ?? null;
    } else {
      const sec = this.opts.sector;
      const inAz = doa.detections
        .filter((d: Detection) => (sec ? inSector(d.azimuthDeg, sec.centerDeg, sec.halfWidthDeg, sec.frontOffsetDeg ?? 0) : true))
        .sort((a, b) => b.salienceDb - a.salienceDb);
      const strongest = inAz.length > 0 ? inAz[0]! : null;
      target = this.tracker.update(strongest).azimuthDeg;
    }
    if (target === null) {
      this.current = null;
      return { lookAzimuthDeg: null };
    }
    if (this.current !== null && circularSep(target, this.current) < this.deadbandDeg) {
      return { lookAzimuthDeg: null }; // within deadband — no re-aim
    }
    this.current = target;
    return { lookAzimuthDeg: target };
  }

  reset(): void {
    this.tracker.reset();
    this.current = null;
  }
}
