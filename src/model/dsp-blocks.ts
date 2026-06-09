/**
 * DSP **block** configuration (v1.7.0). A device may carry an ordered chain of
 * processing blocks. These store settings only — no audio is processed (see
 * README §Scope). Each block kind has a typed, range-checked parameter set.
 *
 * A block may optionally name a `targetBusId` (a processor bus it applies to);
 * for non-processor devices the block processes that device's own signal and
 * `targetBusId` must be omitted.
 */

/** Supported DSP block kinds. */
export type DspBlockKind =
  | 'gain'
  | 'mute'
  | 'peq4'
  | 'agc'
  | 'compressor'
  | 'delay'
  | 'noiseReduction'
  | 'deverb';

/** Parametric-EQ band filter shape. */
export type PeqBandType = 'bell' | 'lowShelf' | 'highShelf' | 'highpass' | 'lowpass';

/** One parametric-EQ band. */
export interface PeqBand {
  freqHz: number;
  gainDb: number;
  q: number;
  type: PeqBandType;
}

export interface GainParams {
  gainDb: number;
}
export interface MuteParams {
  muted: boolean;
}
export interface Peq4Params {
  /** Up to {@link PEQ_MAX_BANDS} bands. */
  bands: PeqBand[];
}
export interface AgcParams {
  targetDb: number;
  maxGainDb: number;
}
export interface CompressorParams {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
}
export interface DelayParams {
  delayMs: number;
}
export interface NoiseReductionParams {
  amountDb: number;
}
export interface DeverbParams {
  /** Strength, 0..1. */
  amount: number;
}

interface DspBlockBase {
  id: string;
  enabled: boolean;
  /** Processor bus this block applies to; omit for a device's own signal. */
  targetBusId?: string;
}

export interface GainBlock extends DspBlockBase {
  kind: 'gain';
  params: GainParams;
}
export interface MuteBlock extends DspBlockBase {
  kind: 'mute';
  params: MuteParams;
}
export interface Peq4Block extends DspBlockBase {
  kind: 'peq4';
  params: Peq4Params;
}
export interface AgcBlock extends DspBlockBase {
  kind: 'agc';
  params: AgcParams;
}
export interface CompressorBlock extends DspBlockBase {
  kind: 'compressor';
  params: CompressorParams;
}
export interface DelayBlock extends DspBlockBase {
  kind: 'delay';
  params: DelayParams;
}
export interface NoiseReductionBlock extends DspBlockBase {
  kind: 'noiseReduction';
  params: NoiseReductionParams;
}
export interface DeverbBlock extends DspBlockBase {
  kind: 'deverb';
  params: DeverbParams;
}

/** Discriminated union of all DSP block configs. */
export type DspBlockConfig =
  | GainBlock
  | MuteBlock
  | Peq4Block
  | AgcBlock
  | CompressorBlock
  | DelayBlock
  | NoiseReductionBlock
  | DeverbBlock;

/** All block kinds, for catalogs/menus. */
export const DSP_BLOCK_KINDS: readonly DspBlockKind[] = [
  'gain',
  'mute',
  'peq4',
  'agc',
  'compressor',
  'delay',
  'noiseReduction',
  'deverb',
];

/** Max bands in a `peq4` block. */
export const PEQ_MAX_BANDS = 4;

/** Inclusive `[min, max]` ranges for numeric parameters (used by validation/UI). */
export const DSP_RANGES = {
  gainDb: [-60, 12],
  peqFreqHz: [20, 20000],
  peqGainDb: [-15, 15],
  peqQ: [0.1, 10],
  agcTargetDb: [-40, 0],
  agcMaxGainDb: [0, 30],
  compThresholdDb: [-60, 0],
  compRatio: [1, 20],
  compAttackMs: [0, 200],
  compReleaseMs: [10, 2000],
  compMakeupDb: [0, 24],
  delayMs: [0, 500],
  nrAmountDb: [0, 30],
  deverbAmount: [0, 1],
} as const;

export const PEQ_BAND_TYPES: readonly PeqBandType[] = [
  'bell',
  'lowShelf',
  'highShelf',
  'highpass',
  'lowpass',
];
