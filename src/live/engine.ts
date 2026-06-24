/**
 * Wires a CaptureAdapter to the live beamformer + meter, emitting a BeamOutput
 * per captured block. Pure orchestration (no node:* / no audio I/O of its own).
 */
import type { CaptureAdapter, LiveConfig, BeamOutput, AutoSteerMode, CleaningConfig, AecConfig, AgcConfig } from './types.js';
import { StreamingVoiceGate } from './voice-gate.js';
import type { PeqBand } from '../model/dsp-blocks.js';
import { TargetLoudnessAgc } from './agc.js';
import { StreamingPeq } from './peq.js';
import { StreamingAec } from './aec.js';
import { ReferenceRing } from './reference-ring.js';
import { StreamingDelaySumBeam } from './beam.js';
import { LevelMeter } from './meter.js';
import { StreamingCovarianceAccumulator } from './covariance.js';
import { detect, type DoaResult, type DetectOptions } from './doa.js';
import { AutoSteerController, type AutoSteerOptions } from './autosteer.js';
import { seatAzimuthForArray } from '../seat-mapper/seat-mapper.js';
import { StreamingSpectralProcessor } from './spectral-processor.js';
import { OmlsaProcessor } from './omlsa.js';
import { LevelPreservingCleaner, type Cleaner } from './level-preserving-cleaner.js';
import { StreamingDereverb } from './dereverb.js';
import { ChainedCleaner } from './cleaner-chain.js';

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
  private cleaner: Cleaner | null = null;
  private cleaningInfo: { engine: string; preserved: boolean; dereverb?: boolean } | null = null;
  private aec: StreamingAec | null = null;
  private refRing: ReferenceRing | null = null;
  private refScratch: Float32Array = new Float32Array(0);
  private aecActive = false;
  private agc: TargetLoudnessAgc | null = null;
  private peq: StreamingPeq | null = null;
  private bandLimit: StreamingPeq | null = null;
  private voiceGate: StreamingVoiceGate | null = null;

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
    // --- Phase 3a/3b: optional post-beam cleaning chain (dereverb → denoise) ---
    const cc: CleaningConfig | undefined = config.cleaning;
    const engine = cc?.engine ?? 'off';
    if (cc !== undefined && (engine !== 'off' || cc.dereverb !== undefined)) {
      const sr = config.sampleRate ?? 44100;
      const strength = cc.strength ?? 1;
      const stages: Cleaner[] = [];
      if (cc.dereverb !== undefined) stages.push(new StreamingDereverb(sr, cc.dereverb));
      if (engine !== 'off') {
        stages.push(
          engine === 'gate'
            ? new StreamingSpectralProcessor(sr, { amount: strength })
            : new OmlsaProcessor(sr, { amount: strength, mode: engine }),
        );
      }
      const inner: Cleaner = stages.length === 1 ? stages[0]! : new ChainedCleaner(stages);
      this.cleaner = cc.preserveLevel ? new LevelPreservingCleaner(inner) : inner;
      this.cleaningInfo = {
        engine,
        preserved: cc.preserveLevel === true,
        ...(cc.dereverb !== undefined ? { dereverb: true } : {}),
      };
    }
    const ac: AecConfig | undefined = config.aec;
    if (ac !== undefined) {
      const sr = config.sampleRate ?? 44100;
      this.aec = new StreamingAec(sr, {
        ...(ac.nTaps !== undefined ? { nTaps: ac.nTaps } : {}),
        ...(ac.mu !== undefined ? { mu: ac.mu } : {}),
        ...(ac.leak !== undefined ? { leak: ac.leak } : {}),
        ...(ac.refFloor !== undefined ? { refFloor: ac.refFloor } : {}),
      });
      this.refRing = new ReferenceRing(sr, ac.refSeconds ?? 2);
      this.aecActive = true;
    }
    if (config.bandLimit) {
      const bands: PeqBand[] = [];
      if (config.bandLimit.highpassHz !== undefined) {
        bands.push({ type: 'highpass', freqHz: config.bandLimit.highpassHz, gainDb: 0, q: 0.7071067811865476 });
      }
      if (config.bandLimit.lowpassHz !== undefined) {
        bands.push({ type: 'lowpass', freqHz: config.bandLimit.lowpassHz, gainDb: 0, q: 0.7071067811865476 });
      }
      if (bands.length > 0) this.bandLimit = new StreamingPeq(config.sampleRate ?? 44100, bands);
    }
    if (config.peq && config.peq.bands.length > 0) {
      this.peq = new StreamingPeq(config.sampleRate ?? 44100, config.peq.bands);
    }
    const agcCfg: AgcConfig | undefined = config.agc;
    if (agcCfg !== undefined) {
      this.agc = new TargetLoudnessAgc(config.sampleRate ?? 44100, agcCfg);
    }
    if (config.voiceGate) {
      this.voiceGate = new StreamingVoiceGate(config.sampleRate ?? 44100, config.voiceGate);
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

  /** Feed one block of the far-end reference (what the loudspeakers are playing). No-op when AEC is off. */
  pushReference(block: Float32Array): void {
    this.refRing?.push(block);
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
        let mono: Float32Array = this.beam.process(channels);
        // Phase 3c: cancel far-end echo first (before dereverb/denoise + the meter).
        if (this.aec && this.refRing) {
          if (this.refScratch.length !== mono.length) this.refScratch = new Float32Array(mono.length);
          const ref = this.refRing.recent(this.refScratch);
          mono = this.aec.process(mono, ref, false);
        }
        // Phase 3a: optional post-beam noise suppression (the meter sees the cleaned signal).
        if (this.cleaner) {
          const noiseGate = this.lastDoa ? !this.lastDoa.active : false; // VAD from the PREVIOUS DOA cycle (up to ~detectionHops blocks stale) — fine: the min-stat floor is VAD-independent and the makeup tracks slowly
          mono = this.cleaner.process(mono, noiseGate);
        }
        // Phase 3d-3: speech band-limit (reuses the PEQ) — trim out-of-band rumble/hiss before tone + level.
        if (this.bandLimit) mono = this.bandLimit.process(mono);
        // Phase 3d-2: parametric EQ — tone-shape the clean signal before the AGC levels it.
        if (this.peq) mono = this.peq.process(mono);
        // Phase 3d-1: target-loudness AGC on the cleaned mono (before the meter).
        if (this.agc) mono = this.agc.process(mono, false);
        // Phase 3d-3: voice-only output gate — duck non-speech (runs LAST, after the AGC).
        if (this.voiceGate) mono = this.voiceGate.process(mono);
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
          ...(this.cleaningInfo !== null ? { cleaning: this.cleaningInfo } : {}),
          ...(this.aecActive && this.aec ? { aec: { erleDb: this.aec.erleDb, farendActive: this.aec.farendActive } } : {}),
          ...(this.agc ? { agc: { gainLinear: this.agc.gainLinear } } : {}),
          ...(this.voiceGate ? { voiceGate: { open: this.voiceGate.gateOpen, reductionDb: this.voiceGate.reductionDb, score: this.voiceGate.score } } : {}),
        });
      },
    });
  }

  stop(): Promise<void> {
    return this.adapter.stop();
  }
}
