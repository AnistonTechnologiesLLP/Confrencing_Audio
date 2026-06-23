/**
 * Live audio — the backend-agnostic, zero-dependency, browser-safe core.
 * Real-time fractional-delay-and-sum beamforming over a pluggable capture adapter.
 * The Node-native capture backend lives behind the separate `./live-node` subpath.
 */
export {
  directionUnit,
  fracDelayKernel,
  steerRealDelays,
  StreamingDelaySumBeam,
  DEFAULT_FRACDELAY_TAPS,
} from './beam.js';
export { LevelMeter } from './meter.js';
export { LiveEngine } from './engine.js';
export { MockCaptureAdapter, planeWaveChannels } from './mock-adapter.js';
export type {
  CaptureAdapter,
  CaptureDevice,
  CaptureStartOptions,
  BeamOutput,
  LiveConfig,
} from './types.js';
export { FftRadix2, naiveDft } from './fft.js';
export { StreamingCovarianceAccumulator, COV_FRAME, COV_HOP } from './covariance.js';
export {
  detect,
  circularSep,
  inSector,
  sectorGate,
  DEFAULT_DOA,
  type Detection,
  type DoaResult,
  type DetectOptions,
} from './doa.js';
export { TalkerTracker } from './tracker.js';
export { AutoSteerController, type AutoSteerOptions, type SectorSpec } from './autosteer.js';
export type { AutoSteerMode, AutoSteerConfig } from './types.js';
