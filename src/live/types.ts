import type { ArrayGeometry } from '../beamformer/geometry.js';
import type { SystemConfig } from '../model/index.js';
import type { DetectOptions } from './doa.js';

/** A capture device discovered by an adapter (selected by NAME, never index). */
export interface CaptureDevice {
  id: string;
  name: string;
  maxInputChannels: number;
  defaultSampleRate: number;
}

/** Parameters for a capture session. `onBlock` receives de-interleaved channels. */
export interface CaptureStartOptions {
  deviceName: string;
  channels: number;
  sampleRate: number;
  onBlock: (channels: Float32Array[], sampleRate: number) => void;
}

export type AutoSteerMode = 'manual' | 'follow' | 'lockSeat';

export interface AutoSteerConfig {
  mode: AutoSteerMode;
  sector?: { centerDeg: number; halfWidthDeg: number; frontOffsetDeg?: number };
  /** Room config + which array/seat, for mode 'lockSeat'. */
  room?: SystemConfig;
  arrayId?: string;
  seatId?: string;
  /** Run detect every K covariance hops (default 11 ≈ 8 Hz at 44.1 kHz). */
  detectionHops?: number;
  doa?: DetectOptions;
  switchMarginDeg?: number;
  holdHops?: number;
}

/** A pluggable real-time multichannel capture backend. */
export interface CaptureAdapter {
  enumerate(): Promise<CaptureDevice[]>;
  start(opts: CaptureStartOptions): Promise<void>;
  stop(): Promise<void>;
}

/** One beamformed block + its meter readout and the look direction that produced it. */
export interface BeamOutput {
  mono: Float32Array;
  rmsDb: number;
  peakDb: number;
  clipped: boolean;
  azimuthDeg: number;
  offNadirDeg: number;
  detected?: { azimuths: number[]; salienceDb: number[] } | null;
  doaActive?: boolean;
  mode?: AutoSteerMode;
  lockedTarget?: { azimuthDeg: number; seatId?: string } | null;
  cleaning?: { engine: string; preserved: boolean; dereverb?: boolean };
  aec?: { erleDb: number; farendActive: boolean };
}

export interface AecConfig {
  nTaps?: number;
  mu?: number;
  leak?: number;
  refFloor?: number;
  /** Reference-ring length in seconds (default 2). */
  refSeconds?: number;
}

/** Opt-in post-beam noise suppression config. */
export interface CleaningConfig {
  engine?: 'off' | 'gate' | 'omlsa' | 'wiener';
  /** 0..1 → the denoiser `amount` (gentler at lower values). */
  strength?: number;
  /** Wrap the cleaner in the level-preserving makeup. */
  preserveLevel?: boolean;
  /** Opt-in dereverb stage; runs BEFORE the denoiser. */
  dereverb?: { t60?: number; beta?: number; gminDb?: number; earlyMs?: number };
}

/** Engine configuration. */
export interface LiveConfig {
  geom: ArrayGeometry;
  deviceName: string;
  sampleRate?: number;
  azimuthDeg?: number;
  offNadirDeg?: number;
  taps?: number;
  autoSteer?: AutoSteerConfig;
  cleaning?: CleaningConfig;
  aec?: AecConfig;
}
