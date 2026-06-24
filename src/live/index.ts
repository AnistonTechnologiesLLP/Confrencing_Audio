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
export type { AutoSteerMode, AutoSteerConfig, CleaningConfig } from './types.js';
export { StreamingSpectralProcessor, NR_FRAME, NR_HOP, type SpectralOptions } from './spectral-processor.js';
export { OmlsaProcessor, expE1, type OmlsaOptions } from './omlsa.js';
export { ExponentialTracker } from './exponential-tracker.js';
export { LevelPreservingCleaner, type Cleaner } from './level-preserving-cleaner.js';
export { StreamingDereverb, DEREVERB_T60, DEREVERB_BETA, DEREVERB_GMIN_DB, DEREVERB_EARLY_MS, type DereverbOptions } from './dereverb.js';
export { ChainedCleaner } from './cleaner-chain.js';
