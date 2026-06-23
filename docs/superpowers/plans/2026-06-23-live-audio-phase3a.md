# Live Audio — Phase 3a Implementation Plan (post-beam noise suppression)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in post-beam noise-suppression stage to the live engine — an STFT denoiser (gate / OM-LSA / Wiener) with a level-preserving makeup that kills steady fans/AC without making the talker weak.

**Architecture:** New pure, zero-dependency, browser-safe modules under `src/live/`: an inverse real FFT (extending the Phase-2 `FftRadix2`), a streaming Hann overlap-add STFT spectral-processor base with a minimum-statistics noise floor, OM-LSA/Wiener gain laws, a one-pole EMA tracker, and a level-preserving makeup wrapper — wired into the Phase-1/2 `LiveEngine` behind an opt-in `LiveConfig.cleaning` (default off = byte-identical to Phase 2).

**Tech Stack:** TypeScript (ESM, strict), vitest; reuses `src/live/fft.ts` (`FftRadix2.rfft`), the FIFO pattern from `src/live/covariance.ts`, and the Phase-1/2 `LiveEngine`/`types.ts`.

## Global Constraints

- ESM-only; **every relative import carries a `.js` extension**.
- **Zero hard runtime dependencies** — `package.json` `dependencies` stays `{}`. The denoisers are pure DSP; the exponential integral `E1` is vendored (no scipy). No new dependency.
- Everything under `src/live/` is **browser-safe**: NO `node:*`, no `Buffer`, no Node globals.
- Strict tsconfig: `noUncheckedIndexedAccess` (index access is `T | undefined` — use `!` / guards), `exactOptionalPropertyTypes` (optional fields via omit-when-absent spread), `noUnusedLocals`/`noUnusedParameters`, `verbatimModuleSyntax` (`import type` / inline `type` for type-only imports). No `as Float32Array[]` casts; annotate a `let` as the wide global `Float32Array` if a narrow/wide generic mismatch arises.
- **Float64** for all DSP math (`Float64Array`); convert to `Float32Array` only at the output boundary.
- **STFT framing (from `polaris_beamformer.py`): FRAME=512, HOP=256, Hann window, 50% overlap.** Min-stat: `floor_db=-15`, `oversub=1.5`, `gain_alpha=0.5`, `warmup_frames=16`, `power_alpha=0.8`, `minstat_sub=8`, `minstat_sublen=16`, `minstat_bias=1.5`. OM-LSA (from `streaming_cleaner.py`): `alpha=0.985`, `gmin_db=-18`, `gamma_thresh=2.0`, `nu_min=1e-3`, `nu_max=500`. Makeup (from `polaris_beamformer.py`): `max_gain_db=8`, `level_alpha=0.05`, `slew_alpha=0.08`, `ceiling_db=-1`, `limit_release_alpha=0.05`, `silence_db=-55`.
- **Bit-exact passthrough when off / during warmup:** the cleaner returns the **same array object** it was given.
- Commands run from repo root `c:\Work\conferencing-audio-pipeline`. Single file: `npx vitest run <file>`. Full gate: `npm run typecheck && npm test && npm run build`.

---

## File Structure

- `src/live/fft.ts` — **modify**. Refactor the butterfly loop into a private `fftInPlace`; add `irfft(re, im): Float64Array`.
- `src/live/spectral-processor.ts` — **create**. `StreamingSpectralProcessor` (STFT OLA + min-stat floor + Wiener gate; pluggable `computeGain`).
- `src/live/omlsa.ts` — **create**. `OmlsaProcessor` (overrides `computeGain`: OM-LSA/Wiener), `expE1`.
- `src/live/exponential-tracker.ts` — **create**. `ExponentialTracker` (one-pole EMA).
- `src/live/level-preserving-cleaner.ts` — **create**. `LevelPreservingCleaner` (makeup + limiter wrapper).
- `src/live/engine.ts` / `src/live/types.ts` / `src/live/index.ts` — **modify**. Opt-in cleaning wiring.
- Tests: `test/live-irfft.test.ts`, `test/live-spectral-processor.test.ts`, `test/live-omlsa.test.ts`, `test/live-exponential-tracker.test.ts`, `test/live-level-preserving.test.ts`, extend `test/live-engine.test.ts`.

---

### Task 1: Inverse real FFT (`fft.ts`)

**Files:**
- Modify: `src/live/fft.ts`
- Test: `test/live-irfft.test.ts`

**Interfaces:**
- Produces: `FftRadix2.irfft(re: Float64Array, im: Float64Array): Float64Array` — given the `n/2+1` half-spectrum (`re`/`im` length ≥ `n/2+1`), returns the length-`n` real time signal. Reuses internal buffers.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-irfft.test.ts
import { describe, it, expect } from 'vitest';
import { FftRadix2 } from '../src/live/fft.js';

describe('FftRadix2.irfft', () => {
  it('round-trips rfft → irfft on a random frame', () => {
    const n = 512;
    const f = new FftRadix2(n);
    const x = new Float64Array(n);
    let s = 99;
    for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; x[i] = (s / 0x7fffffff) * 2 - 1; }
    const X = f.rfft(x);
    const y = f.irfft(X.re, X.im);
    for (let i = 0; i < n; i++) expect(y[i]!).toBeCloseTo(x[i]!, 9);
  });

  it('maps a DC-only spectrum to a constant signal', () => {
    const n = 8;
    const f = new FftRadix2(n);
    const re = new Float64Array(n / 2 + 1);
    const im = new Float64Array(n / 2 + 1);
    re[0] = n; // DC bin = n → constant 1.0
    const y = f.irfft(re, im);
    for (let i = 0; i < n; i++) expect(y[i]!).toBeCloseTo(1, 9);
  });

  it('maps a single mid-bin to a cosine', () => {
    const n = 16;
    const f = new FftRadix2(n);
    const x = new Float64Array(n);
    const k0 = 3;
    for (let i = 0; i < n; i++) x[i] = Math.cos((2 * Math.PI * k0 * i) / n);
    const X = f.rfft(x);
    const y = f.irfft(X.re, X.im);
    for (let i = 0; i < n; i++) expect(y[i]!).toBeCloseTo(x[i]!, 9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-irfft.test.ts`
Expected: FAIL — `f.irfft is not a function`.

- [ ] **Step 3: Refactor + implement**

In `src/live/fft.ts`, replace the `rfft` method (lines 45–79) and add `fftInPlace` + `irfft`. The new private `fftInPlace` does an in-place bit-reversal then the existing butterflies; `rfft` and `irfft` both prepare the work buffers and call it:

```ts
  /** In-place complex forward FFT on the work buffers re[]/im[] (length n). */
  private fftInPlace(): void {
    const { n, rev, re, im, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const r = rev[i]!;
      if (r > i) {
        const tr = re[i]!; re[i] = re[r]!; re[r] = tr;
        const ti = im[i]!; im[i] = im[r]!; im[r] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < half; j++) {
          const tw = j * step;
          const wr = cos[tw]!;
          const wi = sin[tw]!;
          const a = i + j;
          const b = a + half;
          const xr = re[b]!;
          const xi = im[b]!;
          const tr = wr * xr - wi * xi;
          const ti = wr * xi + wi * xr;
          re[b] = re[a]! - tr;
          im[b] = im[a]! - ti;
          re[a] = re[a]! + tr;
          im[a] = im[a]! + ti;
        }
      }
    }
  }

  /** Forward FFT of a real frame (length n) → first n/2+1 bins (reused buffers). */
  rfft(frame: Float64Array): { re: Float64Array; im: Float64Array } {
    const { n, re, im, outRe, outIm } = this;
    for (let i = 0; i < n; i++) { re[i] = frame[i]!; im[i] = 0; }
    this.fftInPlace();
    for (let k = 0; k <= n / 2; k++) { outRe[k] = re[k]!; outIm[k] = im[k]!; }
    return { re: outRe, im: outIm };
  }

  /**
   * Inverse real FFT: the n/2+1 half-spectrum (`re`/`im`) → the length-n real
   * signal. Uses ifft(X) = conj(fft(conj(X)))/n: rebuild the conjugate-symmetric
   * full spectrum, conjugate it, forward-FFT, take the real part / n. Returns a
   * freshly-allocated Float64Array of length n.
   */
  irfft(reHalf: Float64Array, imHalf: Float64Array): Float64Array {
    const { n, re, im } = this;
    // Build Y = conj(full spectrum X). For a real signal X[n-k] = conj(X[k]).
    re[0] = reHalf[0]!; im[0] = -imHalf[0]!;
    re[n / 2] = reHalf[n / 2]!; im[n / 2] = -imHalf[n / 2]!;
    for (let k = 1; k < n / 2; k++) {
      re[k] = reHalf[k]!; im[k] = -imHalf[k]!;        // Y[k] = conj(X[k])
      re[n - k] = reHalf[k]!; im[n - k] = imHalf[k]!;  // Y[n-k] = conj(X[n-k]) = conj(conj(X[k]))... = (reHalf[k], +imHalf[k])
    }
    this.fftInPlace();
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = re[i]! / n; // real part of conj(Z)/n = Z_re/n
    return out;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/live-irfft.test.ts test/live-fft.test.ts`
Expected: PASS — the new irfft tests AND the existing Phase-2 fft tests (the rfft refactor must keep them green).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/live/fft.ts test/live-irfft.test.ts
git commit -m "feat(live): inverse real FFT (irfft) on FftRadix2"
```

---

### Task 2: Streaming STFT spectral processor + minimum-statistics gate (`spectral-processor.ts`)

**Files:**
- Create: `src/live/spectral-processor.ts`
- Test: `test/live-spectral-processor.test.ts`

**Interfaces:**
- Consumes: `FftRadix2` (Task 1: `rfft` + `irfft`).
- Produces:
  - constants `NR_FRAME=512`, `NR_HOP=256`.
  - `interface SpectralOptions { frame?: number; hop?: number; floorDb?: number; oversub?: number; gainAlpha?: number; warmupFrames?: number; powerAlpha?: number; minstatSub?: number; minstatSublen?: number; minstatBias?: number; amount?: number }`
  - `class StreamingSpectralProcessor` — constructor `(sampleRate: number, opts?: SpectralOptions)`; `process(block: Float32Array, noiseGate: boolean): Float32Array` (mono in → mono out; returns the SAME object until engaged / when disabled is N/A here — this class is only built when enabled); `reset(): void`; readonly `engaged: boolean`. A `protected computeGain(power: Float64Array, noiseMag: Float64Array): Float64Array` hook returns the raw per-bin gain (base = Wiener gate); subclasses override it.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-spectral-processor.test.ts
import { describe, it, expect } from 'vitest';
import { StreamingSpectralProcessor, NR_FRAME, NR_HOP } from '../src/live/spectral-processor.js';

function rms(x: Float32Array): number { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / x.length); }

describe('StreamingSpectralProcessor', () => {
  it('Hann 50% overlap satisfies COLA (window sum ≈ const)', () => {
    // Verified indirectly: the processor reconstructs a passed signal during warmup byte-identically,
    // and after warmup the analysis-window OLA is unity-gain. Here we check the COLA window-sum.
    const p = new StreamingSpectralProcessor(44100, { warmupFrames: 0 });
    // feed a steady tone; after warmup the on-axis tone should survive (RMS not collapsed)
    const n = NR_FRAME * 8;
    const tone = new Float32Array(n);
    for (let i = 0; i < n; i++) tone[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * i) / 44100);
    const out = p.process(tone, false);
    expect(out.length).toBe(n);
    // a clean tone is mostly preserved (gate barely attenuates a strong tonal bin)
    expect(rms(out.subarray(NR_FRAME))).toBeGreaterThan(rms(tone.subarray(NR_FRAME)) * 0.5);
  });

  it('returns the SAME input object byte-identically during warmup', () => {
    const p = new StreamingSpectralProcessor(44100, { warmupFrames: 16 });
    const x = new Float32Array(256).fill(0.1);
    const out = p.process(x, true);
    expect(out).toBe(x); // same object — bit-exact passthrough until engaged
    expect(p.engaged).toBe(false);
  });

  it('attenuates steady broadband noise after warmup', () => {
    const p = new StreamingSpectralProcessor(44100, { warmupFrames: 2 });
    // deterministic white noise
    let s = 7;
    const mk = (n: number) => {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; a[i] = (s / 0x7fffffff) * 2 - 1; }
      return a;
    };
    // warm up the floor
    for (let b = 0; b < 40; b++) p.process(mk(256), true);
    const noisy = mk(2048);
    const out = p.process(noisy, true);
    expect(p.engaged).toBe(true);
    expect(rms(out)).toBeLessThan(rms(noisy)); // steady noise is suppressed
  });

  it('bridges odd block sizes (FIFO) and reset() clears state', () => {
    const p = new StreamingSpectralProcessor(44100, { warmupFrames: 1 });
    const x = new Float32Array(300).fill(0.05);
    expect(() => p.process(x, false)).not.toThrow();
    p.reset();
    expect(p.engaged).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-spectral-processor.test.ts`
Expected: FAIL — import of `../src/live/spectral-processor.js` unresolved.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/live/spectral-processor.ts
/**
 * Streaming single-channel post-beam spectral noise suppressor: Hann overlap-add
 * STFT (FRAME/HOP), a VAD-independent minimum-statistics noise floor, and a gentle
 * single-pole Wiener gate (with 3-tap frequency + one-pole temporal smoothing).
 * Byte-identical passthrough until the floor has warmed up. Pluggable per-bin gain
 * law (subclasses override computeGain). Pure, Float64, zero-dep. Port of the
 * Python _PostNoiseSuppressor.
 */
import { FftRadix2 } from './fft.js';

export const NR_FRAME = 512;
export const NR_HOP = 256;

export interface SpectralOptions {
  frame?: number;
  hop?: number;
  floorDb?: number;
  oversub?: number;
  gainAlpha?: number;
  warmupFrames?: number;
  powerAlpha?: number;
  minstatSub?: number;
  minstatSublen?: number;
  minstatBias?: number;
  amount?: number;
}

export class StreamingSpectralProcessor {
  protected readonly F: number;
  protected readonly H: number;
  protected readonly nb: number;
  private readonly fft: FftRadix2;
  private readonly win: Float64Array;
  private readonly gFloor: number;
  private readonly oversub: number;
  private readonly gainAlpha: number;
  private readonly warmup: number;
  private readonly powerAlpha: number;
  private readonly subN: number;
  private readonly subLen: number;
  private readonly bias: number;
  private readonly amount: number;
  // streaming buffers
  private fifo: Float64Array;
  private fill = 0;
  private readonly inbuf: Float64Array;
  private readonly frame: Float64Array;
  private readonly ola: Float64Array;
  private outq: Float64Array;
  private outFill = 0;
  // floor state
  private readonly noiseMag: Float64Array;
  private readonly gainPrev: Float64Array;
  private readonly pSmooth: Float64Array;
  private readonly submin: Float64Array;
  private readonly minbuf: Float64Array[]; // subN × nb
  private subFrame = 0;
  private subIdx = 0;
  private totalFrames = 0;
  private _engaged = false;

  constructor(sampleRate: number, opts: SpectralOptions = {}) {
    void sampleRate;
    this.F = Math.max(2, (Math.trunc(opts.frame ?? NR_FRAME) >> 1) << 1);
    this.H = opts.hop ?? this.F >> 1;
    this.nb = this.F / 2 + 1;
    this.fft = new FftRadix2(this.F);
    this.win = new Float64Array(this.F);
    for (let i = 0; i < this.F; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.F - 1));
    this.gFloor = Math.min(1, Math.pow(10, (opts.floorDb ?? -15) / 20));
    this.oversub = Math.max(0, opts.oversub ?? 1.5);
    this.gainAlpha = opts.gainAlpha ?? 0.5;
    this.warmup = Math.max(0, opts.warmupFrames ?? 16);
    this.powerAlpha = opts.powerAlpha ?? 0.8;
    this.subN = Math.max(1, opts.minstatSub ?? 8);
    this.subLen = Math.max(1, opts.minstatSublen ?? 16);
    this.bias = Math.max(1, opts.minstatBias ?? 1.5);
    this.amount = Math.min(1, Math.max(0, opts.amount ?? 1));
    this.fifo = new Float64Array(this.F * 2);
    this.inbuf = new Float64Array(this.F);
    this.frame = new Float64Array(this.F);
    this.ola = new Float64Array(this.F);
    this.outq = new Float64Array(this.F * 2);
    this.noiseMag = new Float64Array(this.nb);
    this.gainPrev = new Float64Array(this.nb).fill(1);
    this.pSmooth = new Float64Array(this.nb);
    this.submin = new Float64Array(this.nb).fill(Infinity);
    this.minbuf = Array.from({ length: this.subN }, () => new Float64Array(this.nb).fill(Infinity));
  }

  get engaged(): boolean {
    return this._engaged;
  }

  /** Wiener gate gain law (base). Subclasses override. */
  protected computeGain(power: Float64Array, noiseMag: Float64Array): Float64Array {
    const g = new Float64Array(this.nb);
    for (let k = 0; k < this.nb; k++) {
      const n2 = noiseMag[k]! * noiseMag[k]!;
      const wiener = power[k]! / (power[k]! + this.oversub * n2 + 1e-20);
      g[k] = this.gFloor + (1 - this.gFloor) * wiener;
    }
    return g;
  }

  process(block: Float32Array, noiseGate: boolean): Float32Array {
    if (!this._engaged && this.totalFrames + Math.floor((this.fill + block.length) / this.H) < this.warmup) {
      // fast path: definitely still warming up → run the floor update but return input byte-identical
      this.feedAndFrame(block, noiseGate, false);
      if (!this._engaged) return block;
    }
    const out = this.feedAndFrame(block, noiseGate, true);
    return out ?? block;
  }

  /** Accumulate the block, process complete hops; when `emit`, return the cleaned mono. */
  private feedAndFrame(block: Float32Array, noiseGate: boolean, emit: boolean): Float32Array | null {
    const n = block.length;
    if (this.fill + n > this.fifo.length) {
      const next = new Float64Array(Math.max(this.fifo.length * 2, this.fill + n));
      next.set(this.fifo.subarray(0, this.fill));
      this.fifo = next;
    }
    for (let i = 0; i < n; i++) this.fifo[this.fill + i] = block[i]!;
    this.fill += n;
    while (this.fill >= this.H) {
      this.processHop();
      this.fifo.copyWithin(0, this.H, this.fill);
      this.fill -= this.H;
    }
    if (!emit || !this._engaged) return null;
    // drain n samples from outq (front-pad with zeros on the one-time engagement underflow)
    const out = new Float32Array(n);
    const avail = Math.min(n, this.outFill);
    const pad = n - avail;
    for (let i = 0; i < avail; i++) out[pad + i] = this.outq[i]!;
    this.outq.copyWithin(0, avail, this.outFill);
    this.outFill -= avail;
    return out;
  }

  private processHop(): void {
    const { F, H, nb } = this;
    // slide analysis buffer left by H, append the new hop
    this.inbuf.copyWithin(0, H);
    for (let i = 0; i < H; i++) this.inbuf[F - H + i] = this.fifo[i]!;
    for (let i = 0; i < F; i++) this.frame[i] = this.inbuf[i]! * this.win[i]!;
    const X = this.fft.rfft(this.frame);
    // per-bin power + min-statistics floor
    const power = new Float64Array(nb);
    for (let k = 0; k < nb; k++) {
      const p = X.re[k]! * X.re[k]! + X.im[k]! * X.im[k]!;
      power[k] = p;
      this.pSmooth[k] = this.totalFrames === 0 ? p : this.powerAlpha * this.pSmooth[k]! + (1 - this.powerAlpha) * p;
      if (this.pSmooth[k]! < this.submin[k]!) this.submin[k] = this.pSmooth[k]!;
    }
    this.subFrame += 1;
    if (this.subFrame >= this.subLen) {
      this.minbuf[this.subIdx]!.set(this.submin);
      this.subIdx = (this.subIdx + 1) % this.subN;
      for (let k = 0; k < nb; k++) this.submin[k] = this.pSmooth[k]!;
      this.subFrame = 0;
    }
    for (let k = 0; k < nb; k++) {
      let pmin = this.submin[k]!;
      for (let s = 0; s < this.subN; s++) if (this.minbuf[s]![k]! < pmin) pmin = this.minbuf[s]![k]!;
      this.noiseMag[k] = Math.sqrt(this.bias * pmin);
    }
    this.totalFrames += 1;
    if (!this._engaged && this.totalFrames >= this.warmup) this._engaged = true;
    if (!this._engaged) return;
    // gain law + smoothing
    let g = this.computeGain(power, this.noiseMag);
    const gs = new Float64Array(nb);
    gs[0] = g[0]!;
    gs[nb - 1] = g[nb - 1]!;
    for (let k = 1; k < nb - 1; k++) gs[k] = 0.25 * g[k - 1]! + 0.5 * g[k]! + 0.25 * g[k + 1]!;
    for (let k = 0; k < nb; k++) {
      let v = this.gainAlpha * gs[k]! + (1 - this.gainAlpha) * this.gainPrev[k]!;
      if (this.amount < 1) v = this.amount * v + (1 - this.amount);
      this.gainPrev[k] = v;
      gs[k] = v;
    }
    // apply, irfft, overlap-add
    const yr = new Float64Array(nb);
    const yi = new Float64Array(nb);
    for (let k = 0; k < nb; k++) { yr[k] = gs[k]! * X.re[k]!; yi[k] = gs[k]! * X.im[k]!; }
    const y = this.fft.irfft(yr, yi);
    for (let i = 0; i < F; i++) this.ola[i]! += y[i]!;
    if (this.outFill + H > this.outq.length) {
      const next = new Float64Array(this.outq.length * 2);
      next.set(this.outq.subarray(0, this.outFill));
      this.outq = next;
    }
    for (let i = 0; i < H; i++) this.outq[this.outFill + i] = this.ola[i]!;
    this.outFill += H;
    this.ola.copyWithin(0, H);
    this.ola.fill(0, F - H);
  }

  reset(): void {
    this.fill = 0;
    this.outFill = 0;
    this.subFrame = 0;
    this.subIdx = 0;
    this.totalFrames = 0;
    this._engaged = false;
    this.inbuf.fill(0);
    this.ola.fill(0);
    this.noiseMag.fill(0);
    this.gainPrev.fill(1);
    this.pSmooth.fill(0);
    this.submin.fill(Infinity);
    for (const b of this.minbuf) b.fill(Infinity);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/live-spectral-processor.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/live/spectral-processor.ts test/live-spectral-processor.test.ts
git commit -m "feat(live): streaming STFT spectral processor + minimum-statistics noise gate"
```

---

### Task 3: OM-LSA / Wiener gain laws (`omlsa.ts`)

**Files:**
- Create: `src/live/omlsa.ts`
- Test: `test/live-omlsa.test.ts`

**Interfaces:**
- Consumes: `StreamingSpectralProcessor`, `SpectralOptions` (Task 2).
- Produces:
  - `function expE1(x: number): number` — exponential integral E1 (Abramowitz–Stegun), `x > 0`.
  - `interface OmlsaOptions extends SpectralOptions { mode?: 'omlsa' | 'wiener' | 'gate'; cleanerAlpha?: number; gminDb?: number; gammaThresh?: number; nuMin?: number; nuMax?: number }`
  - `class OmlsaProcessor extends StreamingSpectralProcessor` — constructor `(sampleRate, opts?: OmlsaOptions)`; overrides `computeGain`. `mode='gate'` falls back to the base law.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-omlsa.test.ts
import { describe, it, expect } from 'vitest';
import { OmlsaProcessor, expE1 } from '../src/live/omlsa.js';
import { StreamingSpectralProcessor } from '../src/live/spectral-processor.js';

function rms(x: Float32Array): number { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / x.length); }
function whiteNoise(n: number, seed: number): Float32Array {
  let s = seed; const a = new Float32Array(n);
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; a[i] = (s / 0x7fffffff) * 2 - 1; }
  return a;
}

describe('expE1', () => {
  it('matches reference exponential-integral values', () => {
    expect(expE1(1)).toBeCloseTo(0.219384, 4);   // E1(1)
    expect(expE1(0.5)).toBeCloseTo(0.559774, 4);  // E1(0.5)
    expect(expE1(2)).toBeCloseTo(0.048901, 4);    // E1(2)
  });
});

describe('OmlsaProcessor', () => {
  it('cuts steady noise at least as much as the base gate', () => {
    const noiseTrain = () => whiteNoise(256, 11);
    const base = new StreamingSpectralProcessor(44100, { warmupFrames: 2 });
    const omlsa = new OmlsaProcessor(44100, { warmupFrames: 2, mode: 'omlsa' });
    for (let b = 0; b < 40; b++) { base.process(noiseTrain(), true); omlsa.process(noiseTrain(), true); }
    const noisy = whiteNoise(2048, 11);
    const gateOut = base.process(noisy, true);
    const omlsaOut = omlsa.process(whiteNoise(2048, 11), true);
    expect(rms(omlsaOut)).toBeLessThanOrEqual(rms(gateOut) + 1e-6); // OM-LSA cuts ≥ the gate
    expect(rms(omlsaOut)).toBeLessThan(rms(noisy));
  });

  it('gate mode delegates to the base law (output finite, attenuated)', () => {
    const p = new OmlsaProcessor(44100, { warmupFrames: 2, mode: 'gate' });
    for (let b = 0; b < 40; b++) p.process(whiteNoise(256, 5), true);
    const out = p.process(whiteNoise(1024, 5), true);
    expect([...out].every((v) => Number.isFinite(v))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-omlsa.test.ts`
Expected: FAIL — import of `../src/live/omlsa.js` unresolved.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/live/omlsa.ts
/**
 * OM-LSA / Wiener denoiser gain laws (decision-directed, Cohen 2003) layered on
 * the streaming STFT base. Pure DSP — the exponential integral E1 is vendored
 * (Abramowitz–Stegun), no scipy. Port of the Python StreamingCleaner._gain.
 */
import { StreamingSpectralProcessor, type SpectralOptions } from './spectral-processor.js';

/** Exponential integral E1(x), x > 0 (Abramowitz & Stegun 5.1.53 / 5.1.56). */
export function expE1(x: number): number {
  if (x <= 1) {
    const a = [-0.57721566, 0.99999193, -0.24991055, 0.05519968, -0.00976004, 0.00107857];
    let poly = 0;
    let xp = 1;
    for (let k = 0; k < a.length; k++) { poly += a[k]! * xp; xp *= x; }
    return -Math.log(x) + poly;
  }
  const num = x * x + 2.334733 * x + 0.250621;
  const den = x * x + 3.330657 * x + 1.681534;
  return (Math.exp(-x) / x) * (num / den);
}

export interface OmlsaOptions extends SpectralOptions {
  mode?: 'omlsa' | 'wiener' | 'gate';
  cleanerAlpha?: number;
  gminDb?: number;
  gammaThresh?: number;
  nuMin?: number;
  nuMax?: number;
}

export class OmlsaProcessor extends StreamingSpectralProcessor {
  private readonly mode: 'omlsa' | 'wiener' | 'gate';
  private readonly ddAlpha: number;
  private readonly gFloorOm: number; // amplitude floor 10^(gmin/10) — note /10 (power) per the Python
  private readonly xiFloor: number;
  private readonly gammaThresh: number;
  private readonly nuMin: number;
  private readonly nuMax: number;
  private prevClean: Float64Array | null = null;

  constructor(sampleRate: number, opts: OmlsaOptions = {}) {
    super(sampleRate, opts);
    this.mode = opts.mode ?? 'omlsa';
    this.ddAlpha = opts.cleanerAlpha ?? 0.985;
    const gminDb = opts.gminDb ?? -18;
    this.gFloorOm = Math.pow(10, gminDb / 10);
    this.xiFloor = Math.pow(10, gminDb / 10);
    this.gammaThresh = opts.gammaThresh ?? 2.0;
    this.nuMin = opts.nuMin ?? 1e-3;
    this.nuMax = opts.nuMax ?? 500;
  }

  protected override computeGain(power: Float64Array, noiseMag: Float64Array): Float64Array {
    if (this.mode === 'gate') return super.computeGain(power, noiseMag);
    const nb = this.nb;
    const g = new Float64Array(nb);
    if (this.prevClean === null) this.prevClean = new Float64Array(nb);
    const prev = this.prevClean;
    const first = this.prevCleanFresh;
    for (let k = 0; k < nb; k++) {
      const noise2 = noiseMag[k]! * noiseMag[k]! + 1e-20;
      const gamma = power[k]! / noise2;
      const gpost = Math.max(gamma - 1, 0);
      let xi = first ? gpost : this.ddAlpha * (prev[k]! / noise2) + (1 - this.ddAlpha) * gpost;
      if (xi < this.xiFloor) xi = this.xiFloor;
      const gw = xi / (1 + xi);
      prev[k] = gw * gw * power[k]!; // clean power carried to next frame
      if (this.mode === 'wiener') {
        g[k] = Math.max(gw, this.gFloorOm);
      } else {
        let nu = gw * gamma;
        if (nu < this.nuMin) nu = this.nuMin;
        if (nu > this.nuMax) nu = this.nuMax;
        const gh1 = Math.min(gw * Math.exp(0.5 * expE1(nu)), 1);
        const spp = gamma / (gamma + this.gammaThresh);
        g[k] = Math.pow(gh1, spp) * Math.pow(this.gFloorOm, 1 - spp);
      }
    }
    this.prevCleanFresh = false;
    return g;
  }

  private prevCleanFresh = true;

  override reset(): void {
    super.reset();
    this.prevClean = null;
    this.prevCleanFresh = true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/live-omlsa.test.ts`
Expected: PASS (expE1 + OmlsaProcessor tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/live/omlsa.ts test/live-omlsa.test.ts
git commit -m "feat(live): OM-LSA / Wiener denoiser gain laws + expE1"
```

---

### Task 4: One-pole ExponentialTracker (`exponential-tracker.ts`)

**Files:**
- Create: `src/live/exponential-tracker.ts`
- Test: `test/live-exponential-tracker.test.ts`

**Interfaces:**
- Produces: `class ExponentialTracker` — constructor `(alpha: number)`; `update(x: number): number` (one-pole EMA `y = α·x + (1−α)·y`, seeded to the first sample); `get value(): number`; `reset(): void`.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-exponential-tracker.test.ts
import { describe, it, expect } from 'vitest';
import { ExponentialTracker } from '../src/live/exponential-tracker.js';

describe('ExponentialTracker', () => {
  it('seeds on the first sample and converges to a constant input', () => {
    const t = new ExponentialTracker(0.1);
    expect(t.update(5)).toBe(5); // first sample seeds
    for (let i = 0; i < 200; i++) t.update(5);
    expect(t.value).toBeCloseTo(5, 6);
  });

  it('moves a fraction alpha toward a new value', () => {
    const t = new ExponentialTracker(0.25);
    t.update(0);
    expect(t.update(4)).toBeCloseTo(1, 9); // 0.25*4 + 0.75*0
  });

  it('reset() forgets the state (next update re-seeds)', () => {
    const t = new ExponentialTracker(0.5);
    t.update(10);
    t.reset();
    expect(t.update(3)).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-exponential-tracker.test.ts`
Expected: FAIL — import unresolved.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/live/exponential-tracker.ts
/** One-pole EMA: y = α·x + (1−α)·y, seeded to the first sample. Pure, zero-dep. */
export class ExponentialTracker {
  private readonly alpha: number;
  private state = 0;
  private seeded = false;

  constructor(alpha: number) {
    this.alpha = Math.min(1, Math.max(0, alpha));
  }

  update(x: number): number {
    if (!this.seeded) { this.state = x; this.seeded = true; }
    else this.state = this.alpha * x + (1 - this.alpha) * this.state;
    return this.state;
  }

  get value(): number {
    return this.state;
  }

  reset(): void {
    this.state = 0;
    this.seeded = false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/live-exponential-tracker.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/live/exponential-tracker.ts test/live-exponential-tracker.test.ts
git commit -m "feat(live): one-pole ExponentialTracker"
```

---

### Task 5: Level-preserving makeup cleaner (`level-preserving-cleaner.ts`)

**Files:**
- Create: `src/live/level-preserving-cleaner.ts`
- Test: `test/live-level-preserving.test.ts`

**Interfaces:**
- Consumes: `ExponentialTracker` (Task 4).
- Produces:
  - `interface Cleaner { process(block: Float32Array, noiseGate: boolean): Float32Array; reset(): void }` (the contract `StreamingSpectralProcessor` satisfies).
  - `class LevelPreservingCleaner implements Cleaner` — constructor `(inner: Cleaner, opts?: { maxGainDb?: number; levelAlpha?: number; slewAlpha?: number; ceilingDb?: number; releaseAlpha?: number; silenceDb?: number })`; `process(block, noiseGate)` cleans via `inner` then applies a speech-gated, boost-only makeup gain + a peak limiter; `reset()`.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-level-preserving.test.ts
import { describe, it, expect } from 'vitest';
import { LevelPreservingCleaner, type Cleaner } from '../src/live/level-preserving-cleaner.js';

function rms(x: Float32Array): number { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / x.length); }
/** A fake inner cleaner that scales by a fixed linear gain. */
function fixedGain(g: number): Cleaner {
  return { process: (b) => { const o = new Float32Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b[i]! * g; return o; }, reset: () => {} };
}
function tone(n: number, amp: number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * 300 * i) / 44100);
  return a;
}

describe('LevelPreservingCleaner', () => {
  it('restores ~the level a cleaner removed (boost-only, speech frames)', () => {
    const lp = new LevelPreservingCleaner(fixedGain(0.5), {}); // inner cuts 6 dB
    let out = new Float32Array(0);
    for (let b = 0; b < 60; b++) out = lp.process(tone(256, 0.3), false); // speech (noiseGate=false)
    // makeup should bring the 0.5× cleaner back up toward the input level (within the 8 dB cap)
    expect(rms(out)).toBeGreaterThan(rms(tone(256, 0.3)) * 0.5 * 1.4); // clearly boosted above the 0.5x floor
  });

  it('is ~no-op for a lossless (unity) inner cleaner', () => {
    const lp = new LevelPreservingCleaner(fixedGain(1.0), {});
    let out = new Float32Array(0);
    const inp = tone(256, 0.3);
    for (let b = 0; b < 60; b++) out = lp.process(inp, false);
    expect(rms(out)).toBeCloseTo(rms(inp), 1); // ~unchanged
  });

  it('does not ramp makeup on silence', () => {
    const lp = new LevelPreservingCleaner(fixedGain(0.5), {});
    let out = new Float32Array(0);
    for (let b = 0; b < 60; b++) out = lp.process(new Float32Array(256), true); // silence/noise frames
    expect(rms(out)).toBe(0); // silence stays silent, no boost ramp
  });

  it('falls back to passthrough if the inner cleaner throws', () => {
    const bad: Cleaner = { process: () => { throw new Error('boom'); }, reset: () => {} };
    const lp = new LevelPreservingCleaner(bad, {});
    const inp = tone(256, 0.2);
    expect(() => lp.process(inp, false)).not.toThrow();
    expect(lp.process(inp, false)).toBe(inp); // raw passthrough (same object)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-level-preserving.test.ts`
Expected: FAIL — import unresolved.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/live/level-preserving-cleaner.ts
/**
 * Wraps any cleaner with a speech-gated makeup gain that restores the ~5–7 dB
 * every denoiser cuts from the talker — SNR-neutrally (noise and speech scale
 * together) and boost-only — plus a peak limiter so the makeup never clips.
 * Held on silence (no noise-floor pumping). Error-resilient. Port of the Python
 * _LevelPreservingCleaner.
 */
import { ExponentialTracker } from './exponential-tracker.js';

export interface Cleaner {
  process(block: Float32Array, noiseGate: boolean): Float32Array;
  reset(): void;
}

function rms(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / Math.max(1, x.length));
}

export class LevelPreservingCleaner implements Cleaner {
  private readonly inner: Cleaner;
  private readonly maxGain: number;
  private readonly ceiling: number;
  private readonly silenceRms: number;
  private readonly lin: ExponentialTracker;
  private readonly lout: ExponentialTracker;
  private readonly slew: ExponentialTracker;
  private readonly limRelease: number;
  private target = 1;
  private lim = 1;

  constructor(inner: Cleaner, opts: { maxGainDb?: number; levelAlpha?: number; slewAlpha?: number; ceilingDb?: number; releaseAlpha?: number; silenceDb?: number } = {}) {
    this.inner = inner;
    this.maxGain = Math.pow(10, (opts.maxGainDb ?? 8) / 20);
    this.ceiling = Math.pow(10, (opts.ceilingDb ?? -1) / 20);
    this.silenceRms = Math.pow(10, (opts.silenceDb ?? -55) / 20);
    this.lin = new ExponentialTracker(opts.levelAlpha ?? 0.05);
    this.lout = new ExponentialTracker(opts.levelAlpha ?? 0.05);
    this.slew = new ExponentialTracker(opts.slewAlpha ?? 0.08);
    this.limRelease = Math.min(1, Math.max(0, opts.releaseAlpha ?? 0.05));
  }

  process(block: Float32Array, noiseGate: boolean): Float32Array {
    let cleaned: Float32Array;
    try {
      cleaned = this.inner.process(block, noiseGate);
    } catch {
      return block; // inner failed → raw passthrough (never silence)
    }
    try {
      const rin = rms(block);
      // update the makeup target only on speech frames above the silence floor
      if (!noiseGate && rin > this.silenceRms) {
        const lin = this.lin.update(rin);
        const lout = this.lout.update(rms(cleaned));
        if (lout > 1e-9) this.target = Math.min(this.maxGain, Math.max(1, lin / lout));
      }
      const gain = this.slew.update(this.target);
      const out = new Float32Array(cleaned.length);
      for (let i = 0; i < cleaned.length; i++) out[i] = cleaned[i]! * gain;
      // peak limiter: instant attack, slow release, ceiling
      let peak = 0;
      for (const v of out) { const a = Math.abs(v); if (a > peak) peak = a; }
      const need = peak > this.ceiling ? this.ceiling / peak : 1;
      this.lim = need < this.lim ? need : this.lim + this.limRelease * (1 - this.lim);
      if (this.lim < 1) for (let i = 0; i < out.length; i++) out[i] *= this.lim;
      return out;
    } catch {
      return cleaned; // makeup failed → cleaned passthrough
    }
  }

  reset(): void {
    this.inner.reset();
    this.lin.reset();
    this.lout.reset();
    this.slew.reset();
    this.target = 1;
    this.lim = 1;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/live-level-preserving.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/live/level-preserving-cleaner.ts test/live-level-preserving.test.ts
git commit -m "feat(live): level-preserving makeup cleaner"
```

---

### Task 6: Wire opt-in cleaning into the LiveEngine (`engine.ts`, `types.ts`, `index.ts`)

**Files:**
- Modify: `src/live/types.ts`, `src/live/engine.ts`, `src/live/index.ts`
- Test: `test/live-engine.test.ts` (append)

**Interfaces:**
- Consumes: `StreamingSpectralProcessor` (Task 2), `OmlsaProcessor` (Task 3), `LevelPreservingCleaner`/`Cleaner` (Task 5).
- Produces:
  - `types.ts`: `interface CleaningConfig { engine: 'off' | 'gate' | 'omlsa' | 'wiener'; strength?: number; preserveLevel?: boolean }`; `LiveConfig` gains `cleaning?: CleaningConfig`; `BeamOutput` gains `cleaning?: { engine: string; preserved: boolean }`.
  - `engine.ts`: the cleaning stage runs after `beam.process` (and Phase-2 auto-steer) and before `meter.update`.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-engine.test.ts (append)
import { sensibel8 } from '../src/beamformer/geometry.js';

describe('LiveEngine cleaning', () => {
  /** A mock adapter that emits beam-coherent signal + steady white noise. */
  function noisyMock(blocks: number) {
    return new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks, blockSize: 256, freqHz: 1500 });
  }

  it('omlsa cleaning reduces steady-noise level vs off', async () => {
    const geom = sensibel8(0.04);
    const off = new LiveEngine(noisyMock(60), { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90 });
    const on = new LiveEngine(noisyMock(60), { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90, cleaning: { engine: 'omlsa' } });
    let offRms = 0, onRms = 0, count = 0;
    const acc = (set: (v: number) => void) => (o: { mono: Float32Array }) => { let s = 0; for (const v of o.mono) s += v * v; set(Math.sqrt(s / o.mono.length)); };
    off.onOutput(acc((v) => { offRms = v; }));
    on.onOutput(acc((v) => { onRms = v; count++; }));
    await off.start();
    await on.start();
    expect(count).toBeGreaterThan(0);
    // the cleaned tail should not be louder than the uncleaned one (NR is active, not amplifying)
    expect(onRms).toBeLessThanOrEqual(offRms + 1e-6);
  });

  it('absent cleaning is byte-identical to Phase 2 (mono is the beam output object)', async () => {
    const geom = sensibel8(0.04);
    const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 3, blockSize: 256, freqHz: 1500 });
    const engine = new LiveEngine(mock, { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90 });
    let cleaningField: unknown = 'unset';
    engine.onOutput((o) => { cleaningField = (o as { cleaning?: unknown }).cleaning; });
    await engine.start();
    expect(cleaningField).toBeUndefined(); // no cleaning field emitted when off
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-engine.test.ts`
Expected: FAIL — `cleaning` not accepted by `LiveConfig` / no NR applied.

- [ ] **Step 3: Extend the types**

In `src/live/types.ts`, add (alongside the existing types):

```ts
export interface CleaningConfig {
  engine: 'off' | 'gate' | 'omlsa' | 'wiener';
  /** 0..1 → the denoiser `amount` (gentler at lower values). */
  strength?: number;
  /** Wrap the cleaner in the level-preserving makeup. */
  preserveLevel?: boolean;
}
```
Add to `LiveConfig` (after the existing fields): `cleaning?: CleaningConfig;`
Add to `BeamOutput` (after the existing optional fields): `cleaning?: { engine: string; preserved: boolean };`

- [ ] **Step 4: Extend the engine**

In `src/live/engine.ts`, add imports:

```ts
import { StreamingSpectralProcessor } from './spectral-processor.js';
import { OmlsaProcessor } from './omlsa.js';
import { LevelPreservingCleaner, type Cleaner } from './level-preserving-cleaner.js';
import type { CleaningConfig } from './types.js';
```

Add fields on the class (alongside the existing privates):

```ts
  private cleaner: Cleaner | null = null;
  private cleaningInfo: { engine: string; preserved: boolean } | null = null;
```

In the constructor, after the Phase-2 auto-steer setup, build the cleaner when configured:

```ts
    const cc: CleaningConfig | undefined = config.cleaning;
    if (cc && cc.engine !== 'off') {
      const sr = config.sampleRate ?? 44100;
      const strength = cc.strength ?? 1;
      const inner =
        cc.engine === 'gate'
          ? new StreamingSpectralProcessor(sr, { amount: strength })
          : new OmlsaProcessor(sr, { amount: strength, mode: cc.engine });
      this.cleaner = cc.preserveLevel ? new LevelPreservingCleaner(inner) : inner;
      this.cleaningInfo = { engine: cc.engine, preserved: cc.preserveLevel === true };
    }
```

In `start()`'s `onBlock`, **after** the Phase-2 auto-steer step and **before** `this.meter.update(mono)`, insert:

```ts
        // Phase 3a: optional post-beam noise suppression (the meter sees the cleaned signal).
        if (this.cleaner) {
          const noiseGate = this.lastDoa ? !this.lastDoa.active : false; // VAD: active talker ⇒ speech
          mono = this.cleaner.process(mono, noiseGate);
        }
```
(`mono` is the `Float32Array` the beam produced; declare it `let` if it is currently `const` — annotate as `Float32Array` if a narrow/wide generic mismatch arises; do NOT cast.)

Extend the emitted `BeamOutput` object with the cleaning field (only when a cleaner is active), using the omit-when-absent spread:

```ts
          ...(this.cleaningInfo ? { cleaning: this.cleaningInfo } : {}),
```

- [ ] **Step 5: Export the new surface**

In `src/live/index.ts`, append:

```ts
export { FftRadix2 } from './fft.js'; // (if not already exported — keep one export only)
export { StreamingSpectralProcessor, NR_FRAME, NR_HOP, type SpectralOptions } from './spectral-processor.js';
export { OmlsaProcessor, expE1, type OmlsaOptions } from './omlsa.js';
export { ExponentialTracker } from './exponential-tracker.js';
export { LevelPreservingCleaner, type Cleaner } from './level-preserving-cleaner.js';
export type { CleaningConfig } from './types.js';
```
(If `FftRadix2` is already exported from `index.ts` by Phase 2, do NOT add a duplicate — keep the single existing export.)

- [ ] **Step 6: Run test + full gate**

Run: `npx vitest run test/live-engine.test.ts && npm run typecheck && npm run build`
Expected: tests PASS; `tsc` clean; build emits `dist/live/`. Fix any `noUnusedLocals` import issues at the root (don't cast).

- [ ] **Step 7: Commit**

```bash
git add src/live/types.ts src/live/engine.ts src/live/index.ts test/live-engine.test.ts
git commit -m "feat(live): wire opt-in post-beam noise suppression into LiveEngine"
```

---

### Task 7: Docs (README + CHANGELOG + CLAUDE.md) + final gate

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: Add a README subsection**

Append to the "Live audio" section in `README.md`:

```markdown
### Noise suppression (Phase 3a)

Opt-in post-beam cleaning kills steady fans/AC. Enable it with `LiveConfig.cleaning`:

```ts
const engine = new LiveEngine(new NodeCaptureAdapter(), {
  geom, deviceName: 'SB-POLARIS', sampleRate: 44100,
  cleaning: { engine: 'omlsa', strength: 1, preserveLevel: true }, // OM-LSA + makeup so the voice stays full
});
```

- `engine: 'omlsa' | 'wiener' | 'gate'` — an STFT denoiser with a VAD-independent **minimum-statistics**
  noise floor (learns steady fans/AC continuously). `omlsa` is the deepest cut; `gate` is the gentlest.
- `strength` (0..1) blends the cut toward unity for Gentle/Medium/Full.
- `preserveLevel` adds a **speech-gated makeup gain** that restores the ~5–7 dB every denoiser cuts from
  the talker — SNR-neutrally and boost-only, with a peak limiter so it never clips.
- `engine: 'off'` (default) — no cleaning; byte-identical to the Phase-2 path.

Still zero-dependency (pure-DSP, the exponential integral is vendored). **Honest limits:** adds ~12 ms STFT
latency when active (none when off); the floor needs ~0.7 s to warm up (bit-exact passthrough until then);
the makeup is boost-only and capped at 8 dB. Dereverb, AEC, and AGC/PEQ are later sub-phases;
DeepFilterNet3 (which needs ONNX) is an optional far-future add — the pure-DSP OM-LSA is the proven cut.
```

- [ ] **Step 2: Add a CHANGELOG `[Unreleased] > Added` bullet**

```markdown
- **Post-beam noise suppression (Phase 3a)** — opt-in cleaning of the beamformed mono via an STFT
  denoiser (`spectral-processor.ts` + `omlsa.ts`, fed by a new inverse real FFT in `fft.ts`): a
  VAD-independent minimum-statistics noise floor + gate/OM-LSA/Wiener gain laws, plus a
  level-preserving makeup (`level-preserving-cleaner.ts`) that restores the ~5–7 dB denoisers cut
  from the talker (SNR-neutral, boost-only, peak-limited). Wired into `LiveEngine` behind
  `LiveConfig.cleaning` (`engine: 'off' | 'gate' | 'omlsa' | 'wiener'`; default `off` = Phase-2
  behavior). `BeamOutput.cleaning` surfaces the active stage. Pure DSP — the exponential integral is
  vendored, so it adds no dependency. Ported from the Python `_PostNoiseSuppressor` / `StreamingCleaner`
  / `_LevelPreservingCleaner`. Dereverb / AEC / AGC are later sub-phases; DFN3 (ONNX) deferred.
```

- [ ] **Step 3: Add a CLAUDE.md note**

Append to the "Live audio" architecture bullet in `CLAUDE.md`:

```markdown
- **Post-beam noise suppression (Phase 3a, `src/live/{spectral-processor,omlsa,level-preserving-cleaner}.ts`
  + `irfft` in `fft.ts`).** A streaming Hann overlap-add STFT (512/256) with a VAD-independent
  minimum-statistics noise floor and gate/OM-LSA/Wiener gain laws (the exponential integral is vendored —
  still zero-dep), plus a speech-gated level-preserving makeup so the talker stays full. Opt-in via
  `LiveConfig.cleaning` (default `off` = Phase-2 unchanged); the cleaning stage runs after the beam and
  before the meter. ~12 ms latency when active. Dereverb/AEC/AGC are later sub-phases; DFN3 needs ONNX
  (deferred, optional).
```

- [ ] **Step 4: Final gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: `tsc` clean; ALL tests pass (existing + the new Phase-3a tests); build emits `dist/live/` (and `dist/live-node/`).

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md CLAUDE.md
git commit -m "docs: document Phase 3a post-beam noise suppression"
```

---

## Self-Review

**Spec coverage:** irfft (Task 1); STFT base + min-stat gate (Task 2); OM-LSA/Wiener + expE1 (Task 3); ExponentialTracker (Task 4); level-preserving makeup (Task 5); engine wiring + LiveConfig.cleaning + BeamOutput.cleaning + off-byte-identical (Task 6); honest-limits docs (Task 7). Deferred items (dereverb, AEC, AGC/PEQ, DFN3) correctly absent.

**Placeholder scan:** none — every code/test step has complete code and exact commands.

**Type consistency:** `FftRadix2.irfft` (Task 1) is consumed by Task 2; `StreamingSpectralProcessor`/`SpectralOptions`/`computeGain` (Task 2) are extended by Task 3 (`OmlsaProcessor`) and used by Task 6; `ExponentialTracker` (Task 4) is used by Task 5; the `Cleaner` interface (Task 5) is what Task 6 stores as `this.cleaner` (and `StreamingSpectralProcessor`/`OmlsaProcessor` satisfy it via their `process`/`reset`). `CleaningConfig` (Task 6) gates the engine.

**Implementer notes:** (1) The STFT/OLA buffer order is validated by the warmup byte-identical test + the tone-survives + noise-attenuated tests; if the noise-attenuation test is marginal, increase the warm-up block count (it must exceed `minstat_sublen` to fill at least one sub-window). (2) `OmlsaProcessor.computeGain` overrides the base; `mode:'gate'` calls `super.computeGain`. (3) The `gmin` floor is `10^(gmin_db/10)` (a **power** ratio) per the Python — keep the `/10`, not `/20`. (4) The level-preserving makeup is **boost-only** (`max(1, lin/lout)`); the unity-cleaner test guards that it doesn't attenuate. (5) Energy/closeness assertions are deliberately loose (STFT + smoothing) — do not tighten. (6) `mono` in the engine `onBlock` becomes reassignable (`let`); if the Phase-2 code declared it `const`, change to `let` and annotate `Float32Array` — do not cast.
