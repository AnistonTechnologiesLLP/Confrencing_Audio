/**
 * DSP block factories with sensible defaults, and pure parameter range-checking
 * (used by validation and the UI). No audio is processed.
 */
import {
  DSP_RANGES,
  PEQ_MAX_BANDS,
  type DspBlockConfig,
  type DspBlockKind,
  type PeqBand,
} from '../model/dsp-blocks.js';

function inRange(v: number, range: readonly [number, number]): boolean {
  return Number.isFinite(v) && v >= range[0] && v <= range[1];
}

/** A default PEQ band (bell @ 1 kHz, flat). */
export function defaultPeqBand(): PeqBand {
  return { freqHz: 1000, gainDb: 0, q: 1, type: 'bell' };
}

/**
 * Create a DSP block of `kind` with default parameters. `id` must be unique
 * within the device's chain.
 */
export function createDspBlock(kind: DspBlockKind, id: string): DspBlockConfig {
  const base = { id, enabled: true } as const;
  switch (kind) {
    case 'gain':
      return { ...base, kind, params: { gainDb: 0 } };
    case 'mute':
      return { ...base, kind, params: { muted: false } };
    case 'peq4':
      return { ...base, kind, params: { bands: [defaultPeqBand()] } };
    case 'agc':
      return { ...base, kind, params: { targetDb: -18, maxGainDb: 12 } };
    case 'compressor':
      return {
        ...base,
        kind,
        params: { thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 200, makeupDb: 0 },
      };
    case 'delay':
      return { ...base, kind, params: { delayMs: 0 } };
    case 'noiseReduction':
      return { ...base, kind, params: { amountDb: 12 } };
    case 'deverb':
      return { ...base, kind, params: { amount: 0.3 } };
  }
}

/**
 * Return human-readable problems with a block's parameters (empty if valid).
 * Used by validation to raise `DSP_BLOCK_INVALID`.
 */
export function dspBlockParamIssues(block: DspBlockConfig): string[] {
  const issues: string[] = [];
  const r = DSP_RANGES;
  const check = (ok: boolean, msg: string): void => {
    if (!ok) issues.push(msg);
  };
  switch (block.kind) {
    case 'gain':
      check(inRange(block.params.gainDb, r.gainDb), `gainDb out of range ${r.gainDb.join('..')}`);
      break;
    case 'mute':
      check(typeof block.params.muted === 'boolean', 'muted must be boolean');
      break;
    case 'peq4': {
      const bands = block.params.bands;
      check(bands.length <= PEQ_MAX_BANDS, `peq4 allows at most ${PEQ_MAX_BANDS} bands`);
      bands.forEach((b, i) => {
        check(inRange(b.freqHz, r.peqFreqHz), `band ${i + 1} freqHz out of range`);
        check(inRange(b.gainDb, r.peqGainDb), `band ${i + 1} gainDb out of range`);
        check(inRange(b.q, r.peqQ), `band ${i + 1} q out of range`);
      });
      break;
    }
    case 'agc':
      check(inRange(block.params.targetDb, r.agcTargetDb), 'agc targetDb out of range');
      check(inRange(block.params.maxGainDb, r.agcMaxGainDb), 'agc maxGainDb out of range');
      break;
    case 'compressor':
      check(inRange(block.params.thresholdDb, r.compThresholdDb), 'compressor thresholdDb out of range');
      check(inRange(block.params.ratio, r.compRatio), 'compressor ratio out of range');
      check(inRange(block.params.attackMs, r.compAttackMs), 'compressor attackMs out of range');
      check(inRange(block.params.releaseMs, r.compReleaseMs), 'compressor releaseMs out of range');
      check(inRange(block.params.makeupDb, r.compMakeupDb), 'compressor makeupDb out of range');
      break;
    case 'delay':
      check(inRange(block.params.delayMs, r.delayMs), 'delayMs out of range');
      break;
    case 'noiseReduction':
      check(inRange(block.params.amountDb, r.nrAmountDb), 'noiseReduction amountDb out of range');
      break;
    case 'deverb':
      check(inRange(block.params.amount, r.deverbAmount), 'deverb amount out of range 0..1');
      break;
  }
  return issues;
}
