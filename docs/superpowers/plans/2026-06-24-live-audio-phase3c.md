# Live Audio — Phase 3c Implementation Plan (real-time AEC)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in acoustic-echo-cancellation stage to the live engine — a frequency-domain partitioned-block NLMS filter that cancels the loudspeaker echo using a host-pushed far-end reference, run before the cleaning chain.

**Architecture:** A new `StreamingAec` (pure-TS complex adaptive filter over the existing Hann 512/256 STFT, reusing `FftRadix2.rfft`/`irfftInto`) + a pure-TS `ReferenceRing` fed by a new `LiveEngine.pushReference(block)`; wired into `LiveEngine` behind opt-in `LiveConfig.aec`, running after the beam and before the cleaner. Default off = byte-identical to Phase 3b.

**Tech Stack:** TypeScript (ESM, strict), vitest; reuses `src/live/fft.ts` (`rfft`, `irfftInto`), the STFT-framing + pre-allocated-scratch patterns from `src/live/spectral-processor.ts`, and the Phase-1/2/3 `LiveEngine`/`types.ts`.

## Global Constraints

- ESM-only; **every relative import carries a `.js` extension**.
- **Zero hard runtime dependencies** — `package.json` `dependencies` stays `{}`. Pure DSP, reuse the built-in FFT; no new dep.
- Everything under `src/live/` is **browser-safe**: NO `node:*`, no `Buffer`, no Node globals.
- Strict tsconfig: `noUncheckedIndexedAccess` (`!`/guards), `exactOptionalPropertyTypes` (optional fields via the **omit-when-absent spread** `...(x !== undefined ? { x } : {})`, never `{ x: undefined }`), `noUnusedLocals`/`noUnusedParameters` (unused params get a `_` prefix), `verbatimModuleSyntax` (`import type`/inline `type`). NO `as` casts; annotate a `let` as the wide global `Float32Array` if a generic mismatch arises.
- **Float64** for all DSP math; convert to `Float32Array` only at the output boundary.
- **No hot-path allocation:** pre-allocate all per-hop scratch + the complex weight/FIFO arrays in the constructor (mirror `spectral-processor.ts:96-102`).
- **`FftRadix2.rfft` returns REUSED internal buffers** — calling `rfft` a second time overwrites the first result. The AEC must **snapshot `Mt` into its own buffers before calling `rfft` for the reference**.
- **Constants (from `streaming_aec.py:45-50`; runtime callers use nTaps=16):** `AEC_FRAME=512`, `AEC_NTAPS=16`, `AEC_MU=0.3`, `AEC_LEAK=0.999`, `AEC_REF_FLOOR=1e-7`, `AEC_ERLE_ALPHA=0.95`; weight clamp ±10; `1e-12`/`1e-20` epsilons. `hop = frame/2`, `nb = frame/2+1`.
- **`nearEndActive` is always `false`** at the engine call site (the DOA VAD sees the echo). Do NOT wire the cleaning `noiseGate` to AEC freezing.
- **Default off = byte-identical to Phase 3b**: no `LiveConfig.aec` ⇒ the AEC object is never built ⇒ `mono` untouched ⇒ no `aec` field emitted. The new `BeamOutput.aec?` is **omit-when-absent** so existing Phase-3a/3b engine-shape tests stay green.
- Commands from repo root `c:\Work\conferencing-audio-pipeline`. Single file: `npx vitest run <file>`. Full gate: `npm run typecheck && npm test && npm run build` (currently 464 tests / 47 files).

---

## File Structure

- `src/live/reference-ring.ts` — **create**. `ReferenceRing` (mono circular buffer, `push`/`recent`/`reset`).
- `src/live/aec.ts` — **create**. `StreamingAec` (frequency-domain partitioned-block NLMS) + constants + `AecOptions`.
- `src/live/types.ts` — **modify**. `AecConfig`; `LiveConfig.aec?`; `BeamOutput.aec?`.
- `src/live/engine.ts` — **modify**. `pushReference`, build the AEC, run it after the beam / before the cleaner, emit `aec` telemetry.
- `src/live/index.ts` — **modify**. Export the new surface.
- Tests: `test/live-reference-ring.test.ts`, `test/live-aec.test.ts`, extend `test/live-engine.test.ts`.

---

### Task 1: Far-end reference ring (`reference-ring.ts`)

**Files:**
- Create: `src/live/reference-ring.ts`
- Test: `test/live-reference-ring.test.ts`

**Interfaces:**
- Produces: `class ReferenceRing` — ctor `(sampleRate: number, seconds?: number)` (default 2); `push(block: Float32Array): void`; `recent(out: Float32Array): Float32Array` (fills `out` with the most recent `out.length` samples, **newest last**, zero-**front**-padded; returns `out`); `reset(): void`; `get capacity(): number`.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-reference-ring.test.ts
import { describe, it, expect } from 'vitest';
import { ReferenceRing } from '../src/live/reference-ring.js';

describe('ReferenceRing', () => {
  it('recent() is newest-last, zero-front-padded before the ring fills', () => {
    const r = new ReferenceRing(10, 1); // capacity 10
    r.push(Float32Array.of(1, 2, 3));
    const out = new Float32Array(5);
    r.recent(out);
    expect([...out]).toEqual([0, 0, 1, 2, 3]); // front-padded, newest last
  });

  it('returns the newest n after wrap-around', () => {
    const r = new ReferenceRing(4, 1); // capacity 4
    r.push(Float32Array.of(1, 2, 3, 4, 5, 6)); // wraps; keeps newest 4 = [3,4,5,6]
    const out = new Float32Array(4);
    r.recent(out);
    expect([...out]).toEqual([3, 4, 5, 6]);
  });

  it('a block larger than capacity keeps only the newest capacity samples', () => {
    const r = new ReferenceRing(3, 1); // capacity 3
    r.push(Float32Array.of(1, 2, 3, 4, 5));
    const out = new Float32Array(3);
    r.recent(out);
    expect([...out]).toEqual([3, 4, 5]);
  });

  it('reset() clears the ring', () => {
    const r = new ReferenceRing(4, 1);
    r.push(Float32Array.of(9, 9, 9));
    r.reset();
    const out = new Float32Array(4);
    r.recent(out);
    expect([...out]).toEqual([0, 0, 0, 0]);
  });

  it('capacity = round(sampleRate * seconds)', () => {
    expect(new ReferenceRing(44100, 2).capacity).toBe(88200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-reference-ring.test.ts`
Expected: FAIL — module unresolved.

- [ ] **Step 3: Write the implementation**

```ts
// src/live/reference-ring.ts
/**
 * A single-channel circular buffer of the most-recent far-end reference audio, for
 * the live AEC. The host pushes the program/loudspeaker audio via `push`; the AEC
 * pulls a fixed-size window via `recent` per mic block. Pure, zero-dep, browser-safe.
 * Port of the Python `_Ring` (reference_capture.py). JS is single-threaded — no lock.
 */
export class ReferenceRing {
  private readonly buf: Float32Array;
  private readonly n: number;
  private w = 0; // next write index
  private filled = 0; // total valid samples (capped at n)

  constructor(sampleRate: number, seconds = 2) {
    this.n = Math.max(1, Math.round(sampleRate * seconds));
    this.buf = new Float32Array(this.n);
  }

  get capacity(): number {
    return this.n;
  }

  push(block: Float32Array): void {
    const n = this.n;
    const len = block.length;
    if (len >= n) {
      // keep only the newest n samples
      this.buf.set(block.subarray(len - n));
      this.w = 0;
      this.filled = n;
      return;
    }
    for (let i = 0; i < len; i++) {
      this.buf[this.w] = block[i]!;
      this.w = (this.w + 1) % n;
    }
    this.filled = Math.min(n, this.filled + len);
  }

  /** Fill `out` with the most recent out.length samples (newest last; zero-front-padded). */
  recent(out: Float32Array): Float32Array {
    const m = out.length;
    const n = this.n;
    for (let i = 0; i < m; i++) {
      // position i in `out` (i = m-1 is newest). age from newest = (m-1-i).
      const age = m - 1 - i;
      if (age >= this.filled) {
        out[i] = 0;
      } else {
        // newest written sample is at index (w-1) mod n
        const idx = (((this.w - 1 - age) % n) + n) % n;
        out[i] = this.buf[idx]!;
      }
    }
    return out;
  }

  reset(): void {
    this.buf.fill(0);
    this.w = 0;
    this.filled = 0;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/live-reference-ring.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/live/reference-ring.ts test/live-reference-ring.test.ts
git commit -m "feat(live): far-end reference ring"
```

---

### Task 2: Streaming AEC (`aec.ts`)

**Files:**
- Create: `src/live/aec.ts`
- Test: `test/live-aec.test.ts`

**Interfaces:**
- Consumes: `FftRadix2` (`rfft(frame): {re,im}` — reused buffers; `irfftInto(re,im,out)`).
- Produces:
  - constants `AEC_FRAME=512`, `AEC_NTAPS=16`, `AEC_MU=0.3`, `AEC_LEAK=0.999`, `AEC_REF_FLOOR=1e-7`, `AEC_ERLE_ALPHA=0.95`.
  - `interface AecOptions { frame?: number; nTaps?: number; mu?: number; leak?: number; refFloor?: number; erleAlpha?: number }`
  - `class StreamingAec` — ctor `(sampleRate: number, opts?: AecOptions)`; `process(mic: Float32Array, ref: Float32Array | null, nearEndActive?: boolean): Float32Array`; `reset(): void`; `get erleDb(): number`; `get farendActive(): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-aec.test.ts
import { describe, it, expect } from 'vitest';
import { StreamingAec } from '../src/live/aec.js';

function rms(x: Float32Array): number { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / Math.max(1, x.length)); }
function lcg(seed: number): () => number { let s = seed; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s / 0x7fffffff) * 2 - 1; }; }

describe('StreamingAec', () => {
  it('cancels a synthetic echo: ERLE rises and residual drops', () => {
    const aec = new StreamingAec(44100, {});
    const rnd = lcg(7);
    const D1 = 256, D2 = 512;            // echo delays within the 16-tap span
    const hist = new Float32Array(2048); // ref history for building the echo
    let hi = 0;
    const N = 256, BLOCKS = 400;
    let micEnergy = 0, outEnergy = 0, n = 0;
    for (let b = 0; b < BLOCKS; b++) {
      const ref = new Float32Array(N);
      const mic = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const r = 0.5 * rnd();
        ref[i] = r;
        hist[hi % hist.length] = r;
        // echo = 0.6·ref[-D1] + 0.3·ref[-D2]  (a 2-tap room impulse response)
        const e1 = hist[((hi - D1) % hist.length + hist.length) % hist.length]!;
        const e2 = hist[((hi - D2) % hist.length + hist.length) % hist.length]!;
        mic[i] = 0.6 * e1 + 0.3 * e2;
        hi++;
      }
      const out = aec.process(mic, ref, false);
      if (b >= BLOCKS - 50) { micEnergy += rms(mic) ** 2; outEnergy += rms(out) ** 2; n++; }
    }
    expect(aec.erleDb).toBeGreaterThan(6);                 // learned the echo (>6 dB)
    expect(Math.sqrt(outEnergy / n)).toBeLessThan(Math.sqrt(micEnergy / n) * 0.6); // residual clearly reduced
    expect(aec.farendActive).toBe(true);
  });

  it('ref=null ⇒ no cancellation, finite output, no adaptation', () => {
    const aec = new StreamingAec(44100, {});
    const rnd = lcg(3);
    const x = new Float32Array(2048);
    for (let i = 0; i < x.length; i++) x[i] = 0.3 * rnd();
    const out = aec.process(x, null, false);
    expect(out.length).toBe(x.length);
    expect([...out].every(Number.isFinite)).toBe(true);
    expect(aec.farendActive).toBe(false); // zero reference ⇒ no far-end
  });

  it('reset() drops the filter + ERLE (re-feeding reproduces a fresh run)', () => {
    const mk = () => new StreamingAec(44100, {});
    const rnd = lcg(5);
    const N = 256 * 6;
    const ref = new Float32Array(N), mic = new Float32Array(N);
    for (let i = 0; i < N; i++) { ref[i] = 0.4 * rnd(); mic[i] = 0.5 * (i >= 256 ? ref[i - 256]! : 0); }
    const fresh = mk().process(mic.slice(), ref.slice(), false);
    const re = mk();
    re.process(mic.slice(), ref.slice(), false);
    re.reset();
    const after = re.process(mic.slice(), ref.slice(), false);
    for (let i = 0; i < N; i++) expect(after[i]!).toBeCloseTo(fresh[i]!, 9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-aec.test.ts`
Expected: FAIL — module unresolved.

- [ ] **Step 3: Write the implementation**

```ts
// src/live/aec.ts
/**
 * Real-time acoustic echo canceller: a frequency-domain partitioned-block NLMS
 * adaptive filter over the Hann 512/256 overlap-add STFT (reuses FftRadix2 — zero-dep).
 * Per hop it estimates the echo as a K-tap sum of complex-weighted past reference
 * spectra, subtracts it from the mic spectrum, and adapts the weights by leaky NLMS on
 * far-end-active frames. Pure Float64, no hot-path allocation. Port of the Python
 * StreamingAec.
 */
import { FftRadix2 } from './fft.js';

export const AEC_FRAME = 512;
export const AEC_NTAPS = 16;
export const AEC_MU = 0.3;
export const AEC_LEAK = 0.999;
export const AEC_REF_FLOOR = 1e-7;
export const AEC_ERLE_ALPHA = 0.95;
const CLAMP = 10;

export interface AecOptions {
  frame?: number;
  nTaps?: number;
  mu?: number;
  leak?: number;
  refFloor?: number;
  erleAlpha?: number;
}

export class StreamingAec {
  private readonly F: number;
  private readonly H: number;
  private readonly nb: number;
  private readonly K: number;
  private readonly fft: FftRadix2;
  private readonly win: Float64Array;
  private readonly mu: number;
  private readonly leak: number;
  private readonly refFloor: number;
  private readonly erleAlpha: number;
  // input FIFOs (mic + ref move together; same block length each call)
  private qM: Float64Array;
  private qR: Float64Array;
  private qFill = 0;
  // sliding analysis frames + windowed copies
  private readonly inbufM: Float64Array;
  private readonly inbufR: Float64Array;
  private readonly frameM: Float64Array;
  private readonly frameR: Float64Array;
  // snapshots of the rfft outputs (rfft reuses its buffers — must copy)
  private readonly MtRe: Float64Array;
  private readonly MtIm: Float64Array;
  private readonly RtRe: Float64Array;
  private readonly RtIm: Float64Array;
  // complex filter weights + reference FIFO (row-major [k*nb + f], newest at row 0)
  private readonly Wre: Float64Array;
  private readonly Wim: Float64Array;
  private readonly rfRe: Float64Array;
  private readonly rfIm: Float64Array;
  // per-hop scratch
  private readonly eRe: Float64Array;
  private readonly eIm: Float64Array;
  private readonly irOut: Float64Array;
  // overlap-add synthesis
  private readonly ola: Float64Array;
  private qOut: Float64Array;
  private outFill: number;
  // ERLE state
  private _micPow = 0;
  private _errPow = 0;
  private _erleDb = 0;
  private _farend = false;

  constructor(sampleRate: number, opts: AecOptions = {}) {
    void sampleRate;
    this.F = Math.max(2, (Math.trunc(opts.frame ?? AEC_FRAME) >> 1) << 1);
    this.H = this.F >> 1;
    this.nb = this.F / 2 + 1;
    this.K = Math.max(1, Math.trunc(opts.nTaps ?? AEC_NTAPS));
    this.fft = new FftRadix2(this.F);
    this.win = new Float64Array(this.F);
    for (let i = 0; i < this.F; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.F - 1));
    this.mu = opts.mu ?? AEC_MU;
    this.leak = opts.leak ?? AEC_LEAK;
    this.refFloor = opts.refFloor ?? AEC_REF_FLOOR;
    this.erleAlpha = opts.erleAlpha ?? AEC_ERLE_ALPHA;
    this.qM = new Float64Array(this.F * 2);
    this.qR = new Float64Array(this.F * 2);
    this.inbufM = new Float64Array(this.F);
    this.inbufR = new Float64Array(this.F);
    this.frameM = new Float64Array(this.F);
    this.frameR = new Float64Array(this.F);
    this.MtRe = new Float64Array(this.nb);
    this.MtIm = new Float64Array(this.nb);
    this.RtRe = new Float64Array(this.nb);
    this.RtIm = new Float64Array(this.nb);
    this.Wre = new Float64Array(this.K * this.nb);
    this.Wim = new Float64Array(this.K * this.nb);
    this.rfRe = new Float64Array(this.K * this.nb);
    this.rfIm = new Float64Array(this.K * this.nb);
    this.eRe = new Float64Array(this.nb);
    this.eIm = new Float64Array(this.nb);
    this.irOut = new Float64Array(this.F);
    this.ola = new Float64Array(this.F);
    this.qOut = new Float64Array(this.F * 2);
    this.outFill = this.F; // prime one frame of latency (zeros)
  }

  get erleDb(): number {
    return this._erleDb;
  }

  get farendActive(): boolean {
    return this._farend;
  }

  process(mic: Float32Array, ref: Float32Array | null, nearEndActive = false): Float32Array {
    const n = mic.length;
    if (this.qFill + n > this.qM.length) {
      const sz = Math.max(this.qM.length * 2, this.qFill + n);
      const nm = new Float64Array(sz); nm.set(this.qM.subarray(0, this.qFill)); this.qM = nm;
      const nr = new Float64Array(sz); nr.set(this.qR.subarray(0, this.qFill)); this.qR = nr;
    }
    for (let i = 0; i < n; i++) {
      this.qM[this.qFill + i] = mic[i]!;
      this.qR[this.qFill + i] = ref !== null ? (ref[i] ?? 0) : 0;
    }
    this.qFill += n;
    while (this.qFill >= this.H) {
      this.processHop(nearEndActive);
      this.qM.copyWithin(0, this.H, this.qFill);
      this.qR.copyWithin(0, this.H, this.qFill);
      this.qFill -= this.H;
    }
    const out = new Float32Array(n);
    const avail = Math.min(n, this.outFill);
    const pad = n - avail;
    for (let i = 0; i < avail; i++) out[pad + i] = this.qOut[i]!;
    this.qOut.copyWithin(0, avail, this.outFill);
    this.outFill -= avail;
    return out;
  }

  private processHop(nearEndActive: boolean): void {
    const { F, H, nb, K } = this;
    // slide analysis frames, append the new hop, window
    this.inbufM.copyWithin(0, H);
    this.inbufR.copyWithin(0, H);
    for (let i = 0; i < H; i++) { this.inbufM[F - H + i] = this.qM[i]!; this.inbufR[F - H + i] = this.qR[i]!; }
    for (let i = 0; i < F; i++) { this.frameM[i] = this.inbufM[i]! * this.win[i]!; this.frameR[i] = this.inbufR[i]! * this.win[i]!; }
    // rfft mic, snapshot (rfft reuses its output buffers), then rfft ref
    const M = this.fft.rfft(this.frameM);
    for (let f = 0; f < nb; f++) { this.MtRe[f] = M.re[f]!; this.MtIm[f] = M.im[f]!; }
    const R = this.fft.rfft(this.frameR);
    for (let f = 0; f < nb; f++) { this.RtRe[f] = R.re[f]!; this.RtIm[f] = R.im[f]!; }
    // shift the reference FIFO down one row (newest -> row 0)
    for (let k = K - 1; k >= 1; k--) {
      const dst = k * nb, src = (k - 1) * nb;
      for (let f = 0; f < nb; f++) { this.rfRe[dst + f] = this.rfRe[src + f]!; this.rfIm[dst + f] = this.rfIm[src + f]!; }
    }
    for (let f = 0; f < nb; f++) { this.rfRe[f] = this.RtRe[f]!; this.rfIm[f] = this.RtIm[f]!; }
    // predicted echo yhat[f] = sum_k W[k,f]·rfifo[k,f]; error e = Mt - yhat
    for (let f = 0; f < nb; f++) {
      let yr = 0, yi = 0;
      for (let k = 0; k < K; k++) {
        const idx = k * nb + f;
        const wr = this.Wre[idx]!, wi = this.Wim[idx]!, rr = this.rfRe[idx]!, ri = this.rfIm[idx]!;
        yr += wr * rr - wi * ri;
        yi += wr * ri + wi * rr;
      }
      this.eRe[f] = this.MtRe[f]! - yr;
      this.eIm[f] = this.MtIm[f]! - yi;
    }
    // far-end activity gate
    let rpow = 0;
    for (let f = 0; f < nb; f++) rpow += this.RtRe[f]! * this.RtRe[f]! + this.RtIm[f]! * this.RtIm[f]!;
    rpow /= nb;
    this._farend = rpow > this.refFloor;
    // NLMS adapt (far-end active and not near-end double-talk): W = leak·W + (mu·e/denom)·conj(rfifo)
    if (this._farend && !nearEndActive) {
      for (let f = 0; f < nb; f++) {
        let denom = 1e-12;
        for (let k = 0; k < K; k++) { const idx = k * nb + f; denom += this.rfRe[idx]! * this.rfRe[idx]! + this.rfIm[idx]! * this.rfIm[idx]!; }
        const sr = (this.mu * this.eRe[f]!) / denom;
        const si = (this.mu * this.eIm[f]!) / denom;
        for (let k = 0; k < K; k++) {
          const idx = k * nb + f;
          const rr = this.rfRe[idx]!, ri = this.rfIm[idx]!;
          // step·conj(r): real = sr·rr + si·ri ; imag = si·rr − sr·ri
          let wr = this.leak * this.Wre[idx]! + (sr * rr + si * ri);
          let wi = this.leak * this.Wim[idx]! + (si * rr - sr * ri);
          if (wr > CLAMP) wr = CLAMP; else if (wr < -CLAMP) wr = -CLAMP;
          if (wi > CLAMP) wi = CLAMP; else if (wi < -CLAMP) wi = -CLAMP;
          this.Wre[idx] = wr; this.Wim[idx] = wi;
        }
      }
    }
    // ERLE (far-end active frames)
    if (this._farend) {
      let mp = 0, ep = 0;
      for (let f = 0; f < nb; f++) {
        mp += this.MtRe[f]! * this.MtRe[f]! + this.MtIm[f]! * this.MtIm[f]!;
        ep += this.eRe[f]! * this.eRe[f]! + this.eIm[f]! * this.eIm[f]!;
      }
      mp /= nb; ep /= nb;
      this._micPow = this.erleAlpha * this._micPow + (1 - this.erleAlpha) * mp;
      this._errPow = this.erleAlpha * this._errPow + (1 - this.erleAlpha) * ep;
      this._erleDb = 10 * Math.log10((this._micPow + 1e-20) / (this._errPow + 1e-20));
    }
    // irfft(e) + overlap-add; drain H to the output FIFO
    this.fft.irfftInto(this.eRe, this.eIm, this.irOut);
    for (let i = 0; i < F; i++) this.ola[i]! += this.irOut[i]!;
    if (this.outFill + H > this.qOut.length) { const nq = new Float64Array(this.qOut.length * 2); nq.set(this.qOut.subarray(0, this.outFill)); this.qOut = nq; }
    for (let i = 0; i < H; i++) this.qOut[this.outFill + i] = this.ola[i]!;
    this.outFill += H;
    this.ola.copyWithin(0, H);
    this.ola.fill(0, F - H);
  }

  reset(): void {
    this.qFill = 0;
    this.outFill = this.F;
    this.inbufM.fill(0);
    this.inbufR.fill(0);
    this.ola.fill(0);
    this.qOut.fill(0);
    this.Wre.fill(0);
    this.Wim.fill(0);
    this.rfRe.fill(0);
    this.rfIm.fill(0);
    this._micPow = 0;
    this._errPow = 0;
    this._erleDb = 0;
    this._farend = false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/live-aec.test.ts`
Expected: PASS (3 tests). If the ERLE/residual assertion is marginal, increase `BLOCKS` in the test (more convergence time) — do NOT change `mu`/`leak`/the clamp.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/live/aec.ts test/live-aec.test.ts
git commit -m "feat(live): streaming acoustic echo canceller (frequency-domain partitioned-block NLMS)"
```

---

### Task 3: Wire opt-in AEC + `pushReference` into the LiveEngine (`engine.ts`, `types.ts`, `index.ts`)

**Files:**
- Modify: `src/live/types.ts`, `src/live/engine.ts`, `src/live/index.ts`
- Test: `test/live-engine.test.ts` (append)

**Interfaces:**
- Consumes: `StreamingAec` (Task 2), `ReferenceRing` (Task 1).
- Produces: `AecConfig`; `LiveConfig.aec?`; `BeamOutput.aec?`; `LiveEngine.pushReference(block)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-engine.test.ts (append a new describe)
describe('LiveEngine AEC (Phase 3c)', () => {
  const geom = sensibel8(0.04);
  function mock() { return new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 40, blockSize: 256, freqHz: 1500 }); }

  it('aec absent ⇒ no aec field (byte-identical to Phase 3b)', async () => {
    const engine = new LiveEngine(mock(), { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90 });
    let aecField: unknown = 'unset';
    engine.onOutput((o) => { aecField = (o as { aec?: unknown }).aec; });
    await engine.start();
    expect(aecField).toBeUndefined();
  });

  it('aec config ⇒ BeamOutput.aec is surfaced and runs', async () => {
    const engine = new LiveEngine(mock(), { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90, aec: {} });
    let aec: unknown = 'unset';
    engine.onOutput((o) => { aec = (o as { aec?: unknown }).aec; });
    await engine.start();
    expect(aec).toBeDefined();
    const a = aec as { erleDb: number; farendActive: boolean };
    expect(typeof a.erleDb).toBe('number');
    expect(typeof a.farendActive).toBe('boolean');
  });

  it('pushReference is a no-op when AEC is not configured (does not throw)', () => {
    const engine = new LiveEngine(mock(), { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90 });
    expect(() => engine.pushReference(new Float32Array(256))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-engine.test.ts`
Expected: FAIL — `aec` not accepted / `pushReference` not a function.

- [ ] **Step 3: Extend the types**

In `src/live/types.ts`, add:
```ts
export interface AecConfig {
  nTaps?: number;
  mu?: number;
  leak?: number;
  refFloor?: number;
  /** Reference-ring length in seconds (default 2). */
  refSeconds?: number;
}
```
Add to `LiveConfig` (after `cleaning?`): `aec?: AecConfig;`
Add to `BeamOutput` (after `cleaning?`): `aec?: { erleDb: number; farendActive: boolean };`

- [ ] **Step 4: Extend the engine**

In `src/live/engine.ts`, add imports:
```ts
import { StreamingAec } from './aec.js';
import { ReferenceRing } from './reference-ring.js';
import type { AecConfig } from './types.js';
```
Add fields (alongside the existing privates):
```ts
  private aec: StreamingAec | null = null;
  private refRing: ReferenceRing | null = null;
  private refScratch: Float32Array = new Float32Array(0);
  private aecActive = false;
```
In the constructor, after the cleaner-build block, build the AEC when configured:
```ts
    const ac: AecConfig | undefined = config.aec;
    if (ac !== undefined) {
      const sr = config.sampleRate ?? 44100;
      this.aec = new StreamingAec(sr, {
        ...(ac.nTaps !== undefined ? { nTaps: ac.nTaps } : {}),
        ...(ac.mu !== undefined ? { mu: ac.mu } : {}),
        ...(ac.leak !== undefined ? { leak: ac.leak } : {}),
        ...(ac.refFloor !== undefined ? { refFloor: ac.refFloor } : {}),
      });
      this.refRing = new ReferenceRing(sr, ac.refSeconds ?? 2);
      this.aecActive = true;
    }
```
Add the public method (alongside `onOutput`/`setLook`):
```ts
  /** Feed one block of the far-end reference (what the loudspeakers are playing). No-op when AEC is off. */
  pushReference(block: Float32Array): void {
    this.refRing?.push(block);
  }
```
In `onBlock`, **immediately after** `let mono: Float32Array = this.beam.process(channels);` and **before** the `if (this.cleaner)` block, insert:
```ts
        // Phase 3c: cancel far-end echo first (before dereverb/denoise + the meter).
        if (this.aec && this.refRing) {
          if (this.refScratch.length !== mono.length) this.refScratch = new Float32Array(mono.length);
          const ref = this.refRing.recent(this.refScratch);
          mono = this.aec.process(mono, ref, false);
        }
```
In the emitted `BeamOutput` object, add (using the omit-when-absent spread, next to the `cleaning` spread):
```ts
          ...(this.aecActive && this.aec ? { aec: { erleDb: this.aec.erleDb, farendActive: this.aec.farendActive } } : {}),
```

- [ ] **Step 5: Export the new surface**

In `src/live/index.ts`, append:
```ts
export { StreamingAec, AEC_FRAME, AEC_NTAPS, AEC_MU, AEC_LEAK, AEC_REF_FLOOR, AEC_ERLE_ALPHA, type AecOptions } from './aec.js';
export { ReferenceRing } from './reference-ring.js';
export type { AecConfig } from './types.js';
```

- [ ] **Step 6: Run test + full gate**

Run: `npx vitest run test/live-engine.test.ts && npm run typecheck && npm test && npm run build`
Expected: the 3 new tests PASS; the existing Phase-3a/3b engine tests still PASS (no `aec` key when off); `tsc` clean; full suite green; build emits `dist/`. Fix any unused-import issues at the barrel without casts.

- [ ] **Step 7: Commit**

```bash
git add src/live/types.ts src/live/engine.ts src/live/index.ts test/live-engine.test.ts
git commit -m "feat(live): wire opt-in AEC + pushReference into LiveEngine"
```

---

### Task 4: Docs (README + CHANGELOG + CLAUDE.md) + final gate

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: README — add an AEC subsection**

Append after the Phase-3b dereverb subsection in `README.md`:
```markdown
### Echo cancellation (Phase 3c)

Opt-in AEC removes the loudspeaker echo (the far-end voice the mics pick up from the speakers). It runs
**first** in the cleaning chain and needs the host to feed the far-end reference:

```ts
const engine = new LiveEngine(new NodeCaptureAdapter(), {
  geom, deviceName: 'SB-POLARIS', sampleRate: 44100,
  aec: { nTaps: 16 },            // frequency-domain partitioned-block NLMS
  cleaning: { engine: 'omlsa' }, // AEC runs before the cleaner
});
// from your playback callback, feed exactly what you send to the speakers:
engine.pushReference(farEndBlock);
```

- `aec: { nTaps?, mu?, leak?, refFloor?, refSeconds? }` — a complex adaptive filter that estimates the echo
  from a `nTaps`-tap (≈93 ms) history of the reference and subtracts it; it adapts only on far-end-active
  frames (leaky NLMS, weight-clamped). `BeamOutput.aec.erleDb` is the echo-return-loss-enhancement readout.
- The host supplies the reference via `LiveEngine.pushReference(block)` (the program audio it's playing);
  the AEC pulls the time-aligned window per mic block from an internal ring.
- Omitting `aec` is byte-identical to Phase 3b.

Still zero-dependency (it reuses the built-in FFT). **Honest limits:** the host must provide the reference (the
browser-safe core can't capture loopback); no bulk-delay auto-estimation or clock-drift compensation (the echo
must fit in the ~93 ms tap span); post-beam single-beam (re-steering forces re-convergence); no double-talk
detector. Adds ~12 ms latency when active. AGC/PEQ are the remaining sub-phase (3d).
```

- [ ] **Step 2: CHANGELOG — add an `[Unreleased] > Added` bullet**

```markdown
- **Real-time AEC (Phase 3c)** — opt-in `StreamingAec` (`aec.ts`), a frequency-domain partitioned-block NLMS
  echo canceller over the existing Hann 512/256 STFT (reuses `FftRadix2` — no new dependency), run **first** in
  the chain (before dereverb/denoise). The far-end reference enters via a new `LiveEngine.pushReference(block)`
  feeding a pure-TS `ReferenceRing` (`reference-ring.ts`); the AEC pulls the aligned window per mic block. Wired
  through `LiveConfig.aec` (default off = Phase-3b behavior); `BeamOutput.aec` surfaces ERLE + far-end activity
  (omit-when-absent). AEC is a separate engine stage (not a `Cleaner` — it needs a reference). Ported from the
  Python `StreamingAec` / `reference_capture.py`. AGC/PEQ are the remaining 3d sub-phase.
```

- [ ] **Step 3: CLAUDE.md — add a note**

Append to the live-audio architecture bullets in `CLAUDE.md`:
```markdown
- **Echo cancellation (Phase 3c, `src/live/aec.ts` + `reference-ring.ts`).** A `StreamingAec` frequency-domain
  partitioned-block NLMS filter over the existing STFT (reuses `rfft`/`irfftInto` — zero-dep) cancels the
  loudspeaker echo, running **first** (`beam → AEC → dereverb → denoise`). The far-end reference is host-pushed
  via `LiveEngine.pushReference(block)` into a `ReferenceRing`; the AEC pulls `recent(n)` per block (no
  bulk-delay estimation — the ~93 ms tap span absorbs the latency). Opt-in `LiveConfig.aec` (default off =
  Phase-3b unchanged); `BeamOutput.aec` surfaces ERLE. Not a `Cleaner` (needs a reference arg). AGC/PEQ = 3d.
```

- [ ] **Step 4: Final gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: `tsc` clean; ALL tests pass (existing + the new Phase-3c tests); build emits `dist/live/`.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md CLAUDE.md
git commit -m "docs: document Phase 3c real-time AEC"
```

---

## Self-Review

**Spec coverage:** `ReferenceRing` (Task 1); `StreamingAec` frequency-domain NLMS + ERLE + far-end gate + reset (Task 2); `pushReference` + `LiveConfig.aec` + `BeamOutput.aec` omit-when-absent + the AEC-before-cleaner stage + off-byte-identical (Task 3); honest-limits docs (Task 4). The host-push reference model, the "AEC is not a Cleaner" decision, and `nearEndActive=false` are all covered.

**Placeholder scan:** none — every code/test step has complete code and exact commands.

**Type consistency:** `ReferenceRing` (Task 1: `push`/`recent(out)`/`reset`/`capacity`) is consumed by Task 3; `StreamingAec`/`AecOptions`/`AEC_*` (Task 2) by Task 3; `process(mic, ref, nearEndActive)`/`erleDb`/`farendActive` match between Task 2 and the Task-3 engine use; `AecConfig` (Task 3) gates the engine; `recent(out)` takes a caller buffer (the engine's `refScratch`).

**Implementer notes:** (1) `FftRadix2.rfft` returns REUSED buffers — Task 2 snapshots `Mt` into `MtRe/MtIm` before the second `rfft` (the most likely bug if skipped). (2) The NLMS gradient uses `conj(rfifo)`: `step·conj(r)` real `= sr·rr + si·ri`, imag `= si·rr − sr·ri` — keep these signs. (3) `rfifo` is row-major `[k*nb+f]`, newest at row 0; shift rows DOWN each hop. (4) `outFill` primes to `F` (one frame of latency) in the ctor AND `reset`. (5) `nearEndActive` is always `false` from the engine — do NOT pass the cleaning `noiseGate`. (6) `BeamOutput.aec` MUST be omit-when-absent — the existing Phase-3a/3b engine tests assert no extra keys when those stages are off; if one fails, the spread wasn't used. (7) `mono` in `onBlock` is already `let` — insert the AEC stage between `beam.process` and the cleaner; do not cast.
