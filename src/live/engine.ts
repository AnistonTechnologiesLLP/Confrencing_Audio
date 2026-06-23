/**
 * Wires a CaptureAdapter to the live beamformer + meter, emitting a BeamOutput
 * per captured block. Pure orchestration (no node:* / no audio I/O of its own).
 */
import type { CaptureAdapter, LiveConfig, BeamOutput } from './types.js';
import { StreamingDelaySumBeam } from './beam.js';
import { LevelMeter } from './meter.js';

export class LiveEngine {
  private readonly adapter: CaptureAdapter;
  private readonly config: LiveConfig;
  private readonly beam: StreamingDelaySumBeam;
  private readonly meter = new LevelMeter();
  private _azimuthDeg: number;
  private _offNadirDeg: number;
  private cb: ((out: BeamOutput) => void) | null = null;

  constructor(adapter: CaptureAdapter, config: LiveConfig) {
    this.adapter = adapter;
    this.config = config;
    this._azimuthDeg = config.azimuthDeg ?? 0;
    this._offNadirDeg = config.offNadirDeg ?? 90;
    this.beam = new StreamingDelaySumBeam(config.geom, config.sampleRate ?? 44100, {
      ...(config.taps !== undefined ? { taps: config.taps } : {}),
    });
    this.beam.setLook(this._azimuthDeg, this._offNadirDeg);
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
        this.cb?.({
          mono,
          rmsDb: this.meter.rmsDb,
          peakDb: this.meter.peakDb,
          clipped: this.meter.clipped,
          azimuthDeg: this._azimuthDeg,
          offNadirDeg: this._offNadirDeg,
        });
      },
    });
  }

  stop(): Promise<void> {
    return this.adapter.stop();
  }
}
