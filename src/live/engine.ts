/**
 * Wires a CaptureAdapter to the live beamformer + meter, emitting a BeamOutput
 * per captured block. Pure orchestration (no node:* / no audio I/O of its own).
 */
import type { CaptureAdapter, LiveConfig, BeamOutput, AutoSteerMode } from './types.js';
import { StreamingDelaySumBeam } from './beam.js';
import { LevelMeter } from './meter.js';
import { StreamingCovarianceAccumulator } from './covariance.js';
import { detect, type DoaResult, type DetectOptions } from './doa.js';
import { AutoSteerController, type AutoSteerOptions } from './autosteer.js';
import { seatAzimuthForArray } from '../seat-mapper/seat-mapper.js';

export class LiveEngine {
  private readonly adapter: CaptureAdapter;
  private readonly config: LiveConfig;
  private readonly beam: StreamingDelaySumBeam;
  private readonly meter = new LevelMeter();
  private _azimuthDeg: number;
  private _offNadirDeg: number;
  private cb: ((out: BeamOutput) => void) | null = null;
  private cov: StreamingCovarianceAccumulator | null = null;
  private autosteer: AutoSteerController | null = null;
  private detectionHops = 11;
  private lastFrames = 0;
  private doaOpts: DetectOptions = {};
  private _mode: AutoSteerMode | undefined = 'manual';
  private _lockedTarget: { azimuthDeg: number; seatId?: string } | null = null;
  private lastDoa: DoaResult | null = null;

  constructor(adapter: CaptureAdapter, config: LiveConfig) {
    this.adapter = adapter;
    this.config = config;
    this._azimuthDeg = config.azimuthDeg ?? 0;
    this._offNadirDeg = config.offNadirDeg ?? 90;
    this.beam = new StreamingDelaySumBeam(config.geom, config.sampleRate ?? 44100, {
      ...(config.taps !== undefined ? { taps: config.taps } : {}),
    });
    this.beam.setLook(this._azimuthDeg, this._offNadirDeg);
    // --- Phase 2: optional auto-steer ---
    const as = config.autoSteer;
    if (as && as.mode !== 'manual') {
      this._mode = as.mode;
      this.cov = new StreamingCovarianceAccumulator({ channels: config.geom.nChannels, sampleRate: config.sampleRate ?? 44100 });
      this.detectionHops = as.detectionHops ?? 11;
      // Resolve the seat azimuth once for lock-seat; fall back to follow if unresolved.
      let mode: 'follow' | 'lockSeat' = as.mode;
      let lockAz: number | undefined;
      if (as.mode === 'lockSeat') {
        const az = as.room && as.arrayId && as.seatId ? seatAzimuthForArray(as.room, as.arrayId, as.seatId) : null;
        if (az === null || az === undefined) mode = 'follow';
        else {
          lockAz = az;
          this._lockedTarget = { azimuthDeg: az, ...(as.seatId !== undefined ? { seatId: as.seatId } : {}) };
        }
      }
      const opts: AutoSteerOptions = {
        mode,
        ...(as.sector !== undefined ? { sector: as.sector } : {}),
        ...(lockAz !== undefined ? { lockAzimuthDeg: lockAz } : {}),
        ...(as.switchMarginDeg !== undefined ? { switchMarginDeg: as.switchMarginDeg } : {}),
        ...(as.holdHops !== undefined ? { holdHops: as.holdHops } : {}),
      };
      this.autosteer = new AutoSteerController(opts);
      this.doaOpts = as.doa ?? {};
    }
  }

  get azimuthDeg(): number {
    return this._azimuthDeg;
  }
  get offNadirDeg(): number {
    return this._offNadirDeg;
  }

  onOutput(cb: (out: BeamOutput) => void): void {
    this.cb = cb;
  }

  /** Re-aim the beam (drops beam history to avoid stale samples). */
  setLook(azimuthDeg: number, offNadirDeg = 90): void {
    this._azimuthDeg = azimuthDeg;
    this._offNadirDeg = offNadirDeg;
    this.beam.setLook(azimuthDeg, offNadirDeg);
  }

  start(): Promise<void> {
    return this.adapter.start({
      deviceName: this.config.deviceName,
      channels: this.config.geom.nChannels,
      sampleRate: this.config.sampleRate ?? 44100,
      onBlock: (channels) => {
        const mono: Float32Array = this.beam.process(channels);
        this.meter.update(mono);
        // Phase 2: feed covariance + run DOA/steer on the configured hop cadence.
        if (this.cov && this.autosteer) {
          this.cov.accumulate(channels);
          if (this.cov.framesSeen - this.lastFrames >= this.detectionHops) {
            this.lastFrames = this.cov.framesSeen;
            const snap = this.cov.snapshot();
            if (snap) {
              this.lastDoa = detect(snap.rBand, snap.freqs, this.config.geom, this.doaOpts);
              const decision = this.autosteer.decide(this.lastDoa);
              if (decision.lookAzimuthDeg !== null) this.setLook(decision.lookAzimuthDeg);
            }
          }
        }
        this.cb?.({
          mono,
          rmsDb: this.meter.rmsDb,
          peakDb: this.meter.peakDb,
          clipped: this.meter.clipped,
          azimuthDeg: this._azimuthDeg,
          offNadirDeg: this._offNadirDeg,
          ...(this.cov
            ? {
                detected: this.lastDoa
                  ? { azimuths: this.lastDoa.detections.map((d) => d.azimuthDeg), salienceDb: this.lastDoa.detections.map((d) => d.salienceDb) }
                  : null,
                doaActive: this.lastDoa ? this.lastDoa.active : false,
                mode: this._mode as AutoSteerMode,
                lockedTarget: this._lockedTarget,
              }
            : {}),
        });
      },
    });
  }

  stop(): Promise<void> {
    return this.adapter.stop();
  }
}
