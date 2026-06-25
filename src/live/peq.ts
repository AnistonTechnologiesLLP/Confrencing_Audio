import type { PeqBand, PeqBandType } from '../model/dsp-blocks.js';

/** Flush filter state below this magnitude to zero (denormal-stall guard). */
export const PEQ_DENORMAL_FLOOR = 1e-25;

/** One normalized RBJ second-order section (a0 divided out, so a0 = 1). */
interface Section {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * Design one normalized RBJ-cookbook section, or `null` when the band is a no-op
 * (frequency outside the open band `0 < f0 < Nyquist`, `q ≤ 0`, or a 0 dB bell/shelf).
 * Port of `peq.py:_biquad`.
 */
function biquad(kind: PeqBandType, f0: number, gainDb: number, q: number, fs: number): Section | null {
  if (!(f0 > 0 && f0 < 0.5 * fs * 0.999) || q <= 0) return null;
  if ((kind === 'bell' || kind === 'lowShelf' || kind === 'highShelf') && Math.abs(gainDb) < 1e-6) {
    return null; // a 0 dB bell/shelf is identity → skip
  }
  const w0 = (2 * Math.PI * f0) / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (kind === 'bell') {
    const A = Math.pow(10, gainDb / 40);
    b0 = 1 + alpha * A;
    b1 = -2 * cw;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cw;
    a2 = 1 - alpha / A;
  } else if (kind === 'lowShelf' || kind === 'highShelf') {
    const A = Math.pow(10, gainDb / 40);
    const sq = 2 * Math.sqrt(A) * alpha;
    const ap1 = A + 1;
    const am1 = A - 1;
    if (kind === 'lowShelf') {
      b0 = A * (ap1 - am1 * cw + sq);
      b1 = 2 * A * (am1 - ap1 * cw);
      b2 = A * (ap1 - am1 * cw - sq);
      a0 = ap1 + am1 * cw + sq;
      a1 = -2 * (am1 + ap1 * cw);
      a2 = ap1 + am1 * cw - sq;
    } else {
      b0 = A * (ap1 + am1 * cw + sq);
      b1 = -2 * A * (am1 + ap1 * cw);
      b2 = A * (ap1 + am1 * cw - sq);
      a0 = ap1 - am1 * cw + sq;
      a1 = 2 * (am1 - ap1 * cw);
      a2 = ap1 - am1 * cw - sq;
    }
  } else if (kind === 'highpass') {
    b0 = (1 + cw) / 2;
    b1 = -(1 + cw);
    b2 = (1 + cw) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cw;
    a2 = 1 - alpha;
  } else if (kind === 'lowpass') {
    b0 = (1 - cw) / 2;
    b1 = 1 - cw;
    b2 = (1 - cw) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cw;
    a2 = 1 - alpha;
  } else {
    return null; // unknown type → skip (defensive)
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/**
 * Real-time parametric-EQ cascade — a chain of RBJ biquads (one per enabled band),
 * applied to the cleaned mono after the noise reducer and before the AGC.
 *
 * Hand-rolled Direct-Form-II-transposed recursion (the scipy `sosfilt` state form) with
 * carried Float64 state, so a high-Q notch doesn't time-alias the way a per-frame STFT
 * multiply would. The OFF path (no enabled band) returns the **same input object** — a
 * bit-exact pass-through, so the stage is invisible when idle.
 *
 * Port of `conf_pipeline_control/peq.py:StreamingPeq`.
 */
export class StreamingPeq {
  private readonly fs: number;
  private sections: Section[] = [];
  /** Per-section `[s1, s2]` state, flat: `state[2*s]`, `state[2*s+1]`. */
  private state = new Float64Array(0);

  constructor(sampleRate: number, bands?: readonly PeqBand[]) {
    this.fs = sampleRate;
    this.setBands(bands);
  }

  /**
   * (Re)build the section cascade. Keeps the running state when the section count is
   * unchanged (a small live tweak doesn't click); otherwise allocates fresh zero state.
   */
  setBands(bands?: readonly PeqBand[]): void {
    const rows: Section[] = [];
    for (const b of bands ?? []) {
      const sec = biquad(b.type, b.freqHz, b.gainDb, b.q, this.fs);
      if (sec) rows.push(sec);
    }
    const sameCount = this.sections.length === rows.length;
    this.sections = rows;
    if (!sameCount) this.state = new Float64Array(rows.length * 2);
  }

  /**
   * Filter one mono block. `noiseGate` is accepted for a uniform stage signature and
   * ignored (the EQ is not VAD-driven). Returns the SAME object when no band is enabled.
   */
  process(block: Float32Array, noiseGate?: boolean): Float32Array {
    void noiseGate;
    const sec = this.sections;
    if (sec.length === 0) return block; // true no-op: same object, no copy
    const n = block.length;
    const out = new Float32Array(n);
    const st = this.state;
    for (let i = 0; i < n; i++) {
      let x = block[i]!; // promote to Float64 for the recursion
      for (let s = 0; s < sec.length; s++) {
        const c = sec[s]!;
        const i0 = 2 * s;
        const i1 = i0 + 1;
        const y = c.b0 * x + st[i0]!;
        st[i0] = c.b1 * x - c.a1 * y + st[i1]!;
        st[i1] = c.b2 * x - c.a2 * y;
        x = y;
      }
      out[i] = x; // Float32 store
    }
    for (let k = 0; k < st.length; k++) {
      if (Math.abs(st[k]!) < PEQ_DENORMAL_FLOOR) st[k] = 0; // flush denormals (stall guard)
    }
    return out;
  }

  /** Zero the filter state. */
  reset(): void {
    this.state.fill(0);
  }

  /** Test hook: the designed normalized sections. */
  debugSections(): readonly Section[] {
    return this.sections;
  }

  /** Test hook: the live filter state. */
  debugState(): Float64Array {
    return this.state;
  }
}
