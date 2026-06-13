/**
 * Host-side **microphone control & beamforming** design layer for the
 * conferencing app — the pure-stdlib offline design/verification math.
 *
 * Port of the `conf_pipeline_control` package's design layer (geometry,
 * steering, beamformer). The planning engine (`src/model`) decides *what
 * connects to what*; this package describes the actual capsule layout of an
 * array and turns pickup/exclusion zones (or raw bearings) into beamformer
 * weights that steer toward the areas you want and null the areas you want left
 * out — then evaluates the resulting beam pattern to prove it.
 *
 * No numpy, no hardware: this is the always-importable design/verification
 * layer. (The live/audio layer is intentionally not ported.)
 */
export {
  // geometry
  SOUND_SPEED_MPS,
  ArrayGeometry,
  circularArray,
  sensibel8,
  withActiveChannels,
  // complex helpers
  complex,
  cadd,
  csub,
  cmul,
  cscale,
  cconj,
  cdiv,
  cabs,
  cexpj,
} from './geometry.js';
export type { Complex, Element } from './geometry.js';

export {
  DEFAULT_DESIGN_FREQ_HZ,
  DEFAULT_TARGET_ELEVATION_M,
  RESPONSE_FLOOR_DB,
  SPEECH_BAND_HI_HZ,
  SPEECH_BAND_LO_HZ,
  SPEECH_OCTAVE_CENTERS_HZ,
  SPEECH_THIRD_OCTAVE_CENTERS_HZ,
} from './model.js';

export {
  zoneCentroid,
  zoneLookDirection,
  lookDirection,
  pickupDirections,
  exclusionDirections,
} from './steering.js';
export type { Direction } from './steering.js';

export {
  MODE_DELAYSUM,
  MODE_SUPERDIRECTIVE,
  steeringVector,
  diffuseCoherence,
  delayAndSumWeights,
  superdirectiveWeights,
  lcmvWeights,
  response,
  responseDb,
  whiteNoiseGainDb,
  directivityIndexDb,
  beamPatternAzimuth,
  analyzeLobes,
  talkerLeakageDb,
  bearingDirection,
  designZoneBeams,
  designFromBearings,
  designMultiBearings,
  beamDesignSummary,
  frequencyCurves,
  beamFrequencyCurveTable,
} from './beamformer.js';
export type {
  LobeReport,
  TalkerLeakage,
  BandMetrics,
  ZoneBeam,
  BeamDesign,
  BeamFrequencyCurve,
  DirectionLike,
} from './beamformer.js';
