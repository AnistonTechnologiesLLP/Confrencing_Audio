import { KitSelector, type KitSelectorOptions } from './kit-selector.js';
import { SpeechPresenceScorer } from './speech-presence.js';
import { FenceDecider, type KitPose, type KitReading } from './triangulation.js';
import { TargetLoudnessAgc, type AgcOptions } from './agc.js';
import type { Point2D } from '../model/geometry.js';

/** Equal-power ramp length (blocks) on a kit switch (~0.2 s @ 32 ms). */
export const DEFAULT_CROSSFADE_BLOCKS = 6;

/** Equal-power crossfade gains `(gOut, gIn)` at fade `step` of `total` (cos²+sin²=1). */
export function crossfadeGains(step: number, total: number): [number, number] {
  if (total <= 0) return [0, 1];
  const p = Math.min(Math.max(step, 0), total) / total;
  return [Math.cos((p * Math.PI) / 2), Math.sin((p * Math.PI) / 2)];
}

/** One kit's current block + DOA reading. */
export interface KitBlock {
  mono: Float32Array;
  azimuthDeg: number | null;
  salienceDb: number;
}

/** The combiner's per-tick result. */
export interface CombinedOutput {
  mono: Float32Array;
  active: number;
  switching: boolean;
  speechPresent: boolean;
  scores: number[];
  fenceKeep: boolean | null;
}

export interface MultiArrayCombinerOptions {
  nKits?: number;
  crossfadeBlocks?: number;
  agc?: AgcOptions | null;
  fence?: { holdTicks?: number; marginM?: number; insideDb?: number } | null;
  selector?: KitSelectorOptions;
  scorerHopSeconds?: number;
}

function rmsOf(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return x.length ? Math.sqrt(s / x.length) : 0;
}

/**
 * Combine N kits (arrays) into one glitch-free output: per-kit speech-presence scores → kit selection
 * (hysteresis) → equal-power cross-fade on a switch → one combined AGC, with an optional triangulation
 * fence veto. Port of `multikit.py:MultiKitController._produce` (the stream-free testable core).
 */
export class MultiArrayCombiner {
  private readonly n: number;
  private readonly crossfadeBlocks: number;
  private readonly selector: KitSelector;
  private readonly scorers: SpeechPresenceScorer[];
  private readonly fence: FenceDecider | null;
  private readonly agc: TargetLoudnessAgc | null;
  private _active = 0;
  private fading = false;
  private fadeStep = 0;
  private fadeFrom = 0;

  constructor(sampleRate: number, opts: MultiArrayCombinerOptions = {}) {
    this.n = opts.nKits ?? 2;
    this.crossfadeBlocks = Math.max(1, opts.crossfadeBlocks ?? DEFAULT_CROSSFADE_BLOCKS);
    this.selector = new KitSelector({ nKits: this.n, ...(opts.selector ?? {}) });
    const hop = opts.scorerHopSeconds ?? 0.0116;
    this.scorers = Array.from({ length: this.n }, () => new SpeechPresenceScorer({ hopSeconds: hop }));
    this.fence = opts.fence ? new FenceDecider(opts.fence) : null;
    this.agc = opts.agc ? new TargetLoudnessAgc(sampleRate, opts.agc) : null;
  }

  get active(): number {
    return this._active;
  }

  process(
    kits: readonly KitBlock[],
    t: number,
    fenceCtx?: { poses: readonly [KitPose, KitPose]; polygon: readonly Point2D[] },
  ): CombinedOutput {
    const n = this.n;
    const len = kits[0]!.mono.length;
    // per-kit speech-presence scores from each kit's output RMS
    const scores: number[] = [];
    for (let i = 0; i < n; i++) scores.push(this.scorers[i]!.update(rmsOf(kits[i]!.mono)));

    // optional fence veto (drops the vetoed kit from contention)
    const eff = [...scores];
    let fenceKeep: boolean | null = null;
    if (this.fence && fenceCtx && n >= 2) {
      const mk = (i: number): KitReading => ({
        azimuthDeg: kits[i]!.azimuthDeg,
        salienceDb: kits[i]!.salienceDb,
        level: rmsOf(kits[i]!.mono),
        active: i === this._active,
      });
      const dec = this.fence.update(mk(0), mk(1), fenceCtx.poses[0], fenceCtx.poses[1], fenceCtx.polygon, t);
      fenceKeep = dec.keep;
      if (dec.vetoKit !== null) eff[dec.vetoKit] = 0;
    }

    const state = this.selector.update(eff, t);
    if (state.switching) {
      this.fadeFrom = this._active;
      this._active = state.active;
      this.fading = true;
      this.fadeStep = 0;
    }

    // mix: equal-power cross-fade while fading, else the active kit
    const out = new Float32Array(len);
    if (this.fading && this.fadeFrom !== this._active) {
      const [gOut, gIn] = crossfadeGains(this.fadeStep, this.crossfadeBlocks);
      const from = kits[this.fadeFrom]!.mono;
      const to = kits[this._active]!.mono;
      for (let i = 0; i < len; i++) out[i] = gOut * from[i]! + gIn * to[i]!;
      this.fadeStep += 1;
      if (this.fadeStep >= this.crossfadeBlocks) this.fading = false;
    } else {
      const a = kits[this._active]!.mono;
      for (let i = 0; i < len; i++) out[i] = a[i]!;
    }

    const mono = this.agc ? this.agc.process(out, false) : out;
    return { mono, active: this._active, switching: state.switching, speechPresent: state.speechPresent, scores: state.scores, fenceKeep };
  }

  reset(): void {
    this._active = 0;
    this.fading = false;
    this.fadeStep = 0;
    this.fadeFrom = 0;
    this.selector.reset();
    for (const s of this.scorers) s.reset();
    if (this.fence) this.fence.reset();
    if (this.agc) this.agc.reset();
  }
}
