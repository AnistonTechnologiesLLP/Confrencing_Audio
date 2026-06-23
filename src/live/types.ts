import type { ArrayGeometry } from '../beamformer/geometry.js';

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
}

/** Engine configuration. */
export interface LiveConfig {
  geom: ArrayGeometry;
  deviceName: string;
  sampleRate?: number;
  azimuthDeg?: number;
  offNadirDeg?: number;
  taps?: number;
}
