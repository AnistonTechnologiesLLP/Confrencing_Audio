/** Running level meter: RMS (dBFS), decaying peak-hold (dBFS), and a latching clip flag. */

const FLOOR_DB = -120;
const CLIP_THRESHOLD = 0.999;

function toDb(linear: number): number {
  if (linear <= 0) return FLOOR_DB;
  return Math.max(FLOOR_DB, 20 * Math.log10(linear));
}

export class LevelMeter {
  private _rmsDb = FLOOR_DB;
  private _peak = 0;
  private _clipped = false;
  /** Peak decay per block (≈ -1.5 dB), so the hold falls when the signal drops. */
  private readonly peakDecay = 0.84;

  update(block: Float32Array): void {
    let sumSq = 0;
    let blockPeak = 0;
    for (const v of block) {
      sumSq += v * v;
      const a = Math.abs(v);
      if (a > blockPeak) blockPeak = a;
      if (a >= CLIP_THRESHOLD) this._clipped = true;
    }
    this._rmsDb = toDb(block.length > 0 ? Math.sqrt(sumSq / block.length) : 0);
    this._peak = Math.max(blockPeak, this._peak * this.peakDecay);
  }

  get rmsDb(): number {
    return this._rmsDb;
  }
  get peakDb(): number {
    return toDb(this._peak);
  }
  get clipped(): boolean {
    return this._clipped;
  }

  reset(): void {
    this._rmsDb = FLOOR_DB;
    this._peak = 0;
    this._clipped = false;
  }
}
