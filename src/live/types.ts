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
}
