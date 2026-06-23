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
