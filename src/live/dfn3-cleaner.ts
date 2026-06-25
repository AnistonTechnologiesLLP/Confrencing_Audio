/**
 * DeepFilterNet3 cleaner over the `process(block, noiseGate)` seam — streams the engine-rate mono through
 * 44.1↔48 kHz resamplers and the 480-sample DFN3 frames (carrying the model state), returning a same-length
 * fixed-latency block. Port of the Python `deepfilter_cleaner.StreamingDeepFilter`.
 *
 * The ONNX **session is injected** (the {@link Dfn3Session} interface) — `src/live/` stays browser-safe and
 * zero-dep, so the streaming plumbing here is fully unit-tested with a stub session; the real `onnxruntime`
 * (node-only) is wired by the host through a session factory and passed in via `LiveConfig`. `noiseGate` is
 * ignored (a full neural denoiser needs no VAD gate). **Realtime-safe:** on prime / underrun / ANY error it
 * passes the raw block through — the listener always hears speech (raw until primed, then cleaned), never
 * silence and never a throw.
 */
import { StreamingResampler } from './resampler.js';
import type { Cleaner } from './level-preserving-cleaner.js';

/** DeepFilterNet operates at 48 kHz. */
export const DFN3_SR = 48000;
/** The model's frame/hop (10 ms @ 48 kHz). */
export const DFN3_HOP = 480;
/** Flattened streaming-state tensor length (from the exported model). */
export const DFN3_STATE_LEN = 45304;
/** Model output lag vs input @ 48 kHz (3 frames) — used to align the dry/wet mix. */
export const DFN3_LOOKAHEAD = 1440;
/** Cap on the model's max suppression (dB). */
export const DEFAULT_ATTEN_LIM_DB = 32.0;
/** Cleaning amount: 1.0 = full clean; < 1 blends the lag-aligned original back in (less muffled). */
export const DEFAULT_DFN3_MIX = 1.0;

/** One DFN3 inference step: a 480-sample 48 kHz frame + carried state → cleaned frame + new state. */
export interface Dfn3Session {
  run(frame: Float32Array, states: Float32Array): { out: Float32Array; states: Float32Array };
}

export interface Dfn3Options {
  /** The inference session (host-provided onnxruntime-backed, or a stub in tests). */
  session: Dfn3Session;
  /** Cleaning amount in [0,1]; < 1 blends the lag-aligned original back in. */
  mix?: number;
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export class Dfn3Cleaner implements Cleaner {
  private readonly sr: number;
  private readonly session: Dfn3Session;
  private readonly mix: number;
  private to48: StreamingResampler | null = null;
  private from48: StreamingResampler | null = null;
  private states: Float32Array = new Float32Array(DFN3_STATE_LEN);
  private in48: Float32Array = new Float32Array(0); // accumulated 48 kHz input awaiting full frames
  private dry48: Float32Array = new Float32Array(DFN3_LOOKAHEAD); // 48 kHz input history to lag-align the dry/wet mix
  private outq: Float32Array = new Float32Array(0); // cleaned output at the engine rate, FIFO
  private primed = false;
  /** Last process() error (passthrough fallback fired), for telemetry. */
  error: string | null = null;

  constructor(sampleRate: number, opts: Dfn3Options) {
    this.sr = sampleRate;
    this.session = opts.session;
    this.mix = Math.min(1, Math.max(0, opts.mix ?? DEFAULT_DFN3_MIX));
    this.initResamplers();
  }

  private initResamplers(): void {
    const needs = this.sr !== DFN3_SR;
    this.to48 = needs ? new StreamingResampler(DFN3_SR, this.sr) : null;
    this.from48 = needs ? new StreamingResampler(this.sr, DFN3_SR) : null;
  }

  process(block: Float32Array, noiseGate: boolean): Float32Array {
    void noiseGate;
    const n = block.length;
    if (n === 0) return block;
    try {
      const x48 = this.to48 ? this.to48.process(block) : block;
      this.in48 = concat(this.in48, x48);
      const nFrames = Math.floor(this.in48.length / DFN3_HOP);
      if (nFrames > 0) {
        const take = nFrames * DFN3_HOP;
        const chunk = this.in48.slice(0, take);
        this.in48 = this.in48.slice(take);
        const enh = new Float32Array(take);
        for (let f = 0; f < nFrames; f++) {
          const fr = chunk.subarray(f * DFN3_HOP, (f + 1) * DFN3_HOP);
          const r = this.session.run(fr, this.states);
          this.states = r.states;
          enh.set(r.out.subarray(0, DFN3_HOP), f * DFN3_HOP);
        }
        let mixed = enh;
        if (this.mix < 1) {
          // blend the LAG-ALIGNED original back in (input delayed by DFN3_LOOKAHEAD → aligned to enh)
          const buf = concat(this.dry48, chunk);
          const dry = buf.subarray(0, take);
          this.dry48 = buf.slice(buf.length - DFN3_LOOKAHEAD);
          mixed = new Float32Array(take);
          for (let i = 0; i < take; i++) mixed[i] = this.mix * enh[i]! + (1 - this.mix) * dry[i]!;
        }
        const y = this.from48 ? this.from48.process(mixed) : mixed;
        this.outq = concat(this.outq, y);
      }
      if (!this.primed) {
        if (this.outq.length < n) return block; // passthrough until primed (never silence)
        this.primed = true;
      }
      if (this.outq.length < n) return block; // underrun (jitter): passthrough rather than a gap
      const out = this.outq.slice(0, n);
      this.outq = this.outq.slice(n);
      return out;
    } catch (exc) {
      this.error = `dfn3 process error: ${String(exc)}`;
      return block; // never throw into the audio path
    }
  }

  reset(): void {
    this.states = new Float32Array(DFN3_STATE_LEN);
    this.in48 = new Float32Array(0);
    this.dry48 = new Float32Array(DFN3_LOOKAHEAD);
    this.outq = new Float32Array(0);
    this.primed = false;
    this.error = null;
    if (this.to48) this.to48.reset();
    if (this.from48) this.from48.reset();
  }
}
