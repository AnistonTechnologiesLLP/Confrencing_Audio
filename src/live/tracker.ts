/**
 * Wrap-aware talker hold/switch machine. Smooths the steered direction by
 * arbitrating which discrete talker to follow — NOT by EMA-ing the raw azimuth
 * (that would smear across the 0/360 seam and across talker switches). Port of
 * the Python _TalkerTracker. Pure, zero-dep.
 */
import { circularSep, type Detection } from './doa.js';

export class TalkerTracker {
  private readonly switchMarginDeg: number;
  private readonly holdHops: number;
  private heldAz: number | null = null;
  private holdLeft = 0;

  constructor(opts: { switchMarginDeg?: number; holdHops?: number } = {}) {
    this.switchMarginDeg = opts.switchMarginDeg ?? 20;
    this.holdHops = opts.holdHops ?? 5;
  }

  /** Feed the strongest in-sector detection (or null on silence). */
  update(strongestInSector: Detection | null): { azimuthDeg: number | null; held: boolean } {
    if (strongestInSector) {
      const az = strongestInSector.azimuthDeg;
      if (this.heldAz === null || circularSep(az, this.heldAz) >= this.switchMarginDeg) this.heldAz = az;
      this.holdLeft = this.holdHops;
      return { azimuthDeg: this.heldAz, held: false };
    }
    // silence: coast on the committed talker, then release
    if (this.heldAz !== null && this.holdLeft > 0) {
      this.holdLeft -= 1;
      return { azimuthDeg: this.heldAz, held: true };
    }
    this.heldAz = null;
    return { azimuthDeg: null, held: false };
  }

  reset(): void {
    this.heldAz = null;
    this.holdLeft = 0;
  }
}
