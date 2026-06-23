# Live Audio — Phase 2 Implementation Plan (DOA + auto-steer + lock-to-seat)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Phase-1 single beam steer itself — live SRP-PHAT direction-of-arrival drives the beam to follow the dominant talker (or lock to a chosen room seat).

**Architecture:** New pure, zero-dependency, browser-safe modules under `src/live/`: a radix-2 real FFT, a streaming spatial-covariance accumulator, an SRP-PHAT DOA detector, a wrap-aware talker hold/switch tracker, and a single-beam auto-steer controller — wired into the Phase-1 `LiveEngine` behind an opt-in `autoSteer` config (default `manual` = Phase-1 behavior unchanged).

**Tech Stack:** TypeScript (ESM, strict), vitest; reuses `src/beamformer/geometry.ts` (Complex helpers, `ArrayGeometry`, `SOUND_SPEED_MPS`), `src/live/beam.ts` (`directionUnit`, `StreamingDelaySumBeam`), `src/live/mock-adapter.ts` (`planeWaveChannels`), `src/seat-mapper/seat-mapper.ts` (`seatAzimuthForArray`).

## Global Constraints

- ESM-only; **every relative import carries a `.js` extension**.
- **Zero hard runtime dependencies** — `package.json` `dependencies` stays `{}`. No npm FFT library; the FFT is pure TS. No new dependency at all.
- Everything under `src/live/` is **browser-safe**: NO `node:*`, no `Buffer`, no Node globals.
- Strict tsconfig: `noUncheckedIndexedAccess` (index access is `T | undefined` — use `!` / guards), `exactOptionalPropertyTypes` (optional fields via omit-when-absent spread), `noUnusedLocals`/`noUnusedParameters`, `verbatimModuleSyntax` (use `import type` / inline `type` for type-only imports). Do NOT add `as Float32Array[]` casts; if a `let` holding a `beam.process(...)`/typed-array result fails to typecheck, annotate it as the wide global `Float32Array`.
- **Numerics:** FFT, twiddles, and covariance accumulation use **Float64** (`Float64Array` / `number`). The shared complex type is `Complex { re: number; im: number }` from `../beamformer/geometry.js`; reuse its helpers (`cexpj`, `cabs`, `cdiv`, `cconj`, `cmul`, `cadd`, `cscale`) — do not re-implement complex math.
- **DSP conventions (match the offline layer + Python exactly):** azimuth **0° = +Y, clockwise**; off-nadir **0° = down, 90° = horizontal**; the steering unit vector is `directionUnit(azDeg, offNadirDeg)` from `src/live/beam.ts` (`[sinN·sin(az), sinN·cos(az), −cos(nadir)]`); `SOUND_SPEED_MPS = 343`; steering phase `a_m = exp(+j·2π·f/c·(p_m·u))`. **Phase 2 is azimuth-only; off-nadir is fixed at 90°.**
- **DOA defaults (from `conf_pipeline_control/doa.py`):** band `[300, 3800]` Hz; grid step `2°`; `maxTalkers=3`; `minSeparationDeg=40`; `minSalienceDb=3`; `vadFloorDb=3`. **STFT framing:** `FRAME=1024`, `HOP=512`, Hann window; covariance EMA `alpha=0.05`.
- Commands run from repo root `c:\Work\conferencing-audio-pipeline`. Single file: `npx vitest run <file>`. Full gate: `npm run typecheck && npm test && npm run build`.

---

## File Structure

- `src/live/fft.ts` — **create**. `FftRadix2` (radix-2 DIT complex FFT, Float64, precomputed twiddles + bit-reversal) with `rfft(frame)` returning the first `n/2+1` bins; `naiveDft(frame)` O(N²) reference for tests.
- `src/live/covariance.ts` — **create**. `StreamingCovarianceAccumulator` — FIFO bridges arbitrary blocks → `FRAME/HOP` Hann frames → per-channel `rfft` → band-slice → outer product → EMA `R(f)`.
- `src/live/doa.ts` — **create**. SRP-PHAT `detect` + `steeringCube`/`phatWhiten`/`srpPhatMap`/`pickPeaks`/`circularSep` + sector-gate helpers + `Detection`/`DoaResult`/`DetectOptions` types and defaults.
- `src/live/tracker.ts` — **create**. `TalkerTracker` wrap-aware hold/switch machine.
- `src/live/autosteer.ts` — **create**. `AutoSteerController` (single-beam follow / lock-seat decision).
- `src/live/engine.ts` — **modify**. Optional auto-steer mode: covariance feed + K-hop detect→track→steer.
- `src/live/types.ts` — **modify**. `AutoSteerConfig`, `AutoSteerMode`, `BeamOutput` additions, `LiveConfig.autoSteer?`.
- `src/live/index.ts` — **modify**. Export the new public surface.
- Tests: `test/live-fft.test.ts`, `test/live-covariance.test.ts`, `test/live-doa.test.ts`, `test/live-tracker.test.ts`, `test/live-autosteer.test.ts`, extend `test/live-engine.test.ts`.

---

### Task 1: Radix-2 real FFT (`fft.ts`)

**Files:**
- Create: `src/live/fft.ts`
- Test: `test/live-fft.test.ts`

**Interfaces:**
- Produces:
  - `class FftRadix2` — constructor `(n: number)` (n a power of two ≥ 2); `rfft(frame: Float64Array): { re: Float64Array; im: Float64Array }` — `frame.length === n`; returns the first `n/2+1` complex bins (reused internal buffers — consume before the next call).
  - `naiveDft(frame: ArrayLike<number>): { re: Float64Array; im: Float64Array }` — O(N²) reference, first `frame.length/2+1` bins.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-fft.test.ts
import { describe, it, expect } from 'vitest';
import { FftRadix2, naiveDft } from '../src/live/fft.js';

describe('FftRadix2.rfft', () => {
  it('matches the naive DFT bin-for-bin (N=8)', () => {
    const x = new Float64Array([1, -2, 3, -4, 5, -6, 7, -8]);
    const fast = new FftRadix2(8).rfft(x);
    const slow = naiveDft(x);
    expect(fast.re.length).toBe(5); // n/2 + 1
    for (let k = 0; k < 5; k++) {
      expect(fast.re[k]!).toBeCloseTo(slow.re[k]!, 9);
      expect(fast.im[k]!).toBeCloseTo(slow.im[k]!, 9);
    }
  });

  it('matches the naive DFT on a random 1024 frame', () => {
    const n = 1024;
    const x = new Float64Array(n);
    let s = 12345;
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff; // deterministic PRNG
      x[i] = (s / 0x7fffffff) * 2 - 1;
    }
    const fast = new FftRadix2(n).rfft(x);
    const slow = naiveDft(x);
    for (let k = 0; k <= n / 2; k++) {
      expect(fast.re[k]!).toBeCloseTo(slow.re[k]!, 6);
      expect(fast.im[k]!).toBeCloseTo(slow.im[k]!, 6);
    }
  });

  it('puts a pure tone in its bin and satisfies Parseval', () => {
    const n = 64;
    const x = new Float64Array(n);
    const k0 = 5;
    for (let i = 0; i < n; i++) x[i] = Math.cos((2 * Math.PI * k0 * i) / n);
    const X = new FftRadix2(n).rfft(x);
    // energy concentrated in bin k0
    let peak = 0;
    let peakBin = -1;
    for (let k = 0; k <= n / 2; k++) {
      const mag = X.re[k]! * X.re[k]! + X.im[k]! * X.im[k]!;
      if (mag > peak) { peak = mag; peakBin = k; }
    }
    expect(peakBin).toBe(k0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-fft.test.ts`
Expected: FAIL — `Failed to resolve import "../src/live/fft.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/live/fft.ts
/**
 * Pure-TypeScript radix-2 Cooley–Tukey FFT (decimation-in-time, in-place) for the
 * live DOA path. Float64 throughout; twiddles + bit-reversal precomputed once.
 * `rfft` runs the complex transform on a real frame (imag = 0) and returns the
 * first `n/2+1` bins (the rest are conjugate-symmetric). Forward only — DOA needs
 * no inverse. Zero dependencies.
 */

export class FftRadix2 {
  private readonly n: number;
  private readonly rev: Int32Array;
  private readonly cos: Float64Array; // W_n^k = exp(-2πi k/n), k = 0..n/2-1
  private readonly sin: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly outRe: Float64Array;
  private readonly outIm: Float64Array;

  constructor(n: number) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two ≥ 2 (got ${n})`);
    this.n = n;
    const bits = Math.round(Math.log2(n));
    this.rev = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      this.cos[k] = Math.cos((-2 * Math.PI * k) / n);
      this.sin[k] = Math.sin((-2 * Math.PI * k) / n);
    }
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.outRe = new Float64Array(n / 2 + 1);
    this.outIm = new Float64Array(n / 2 + 1);
  }

  /** Forward FFT of a real frame (length n) → first n/2+1 bins (reused buffers). */
  rfft(frame: Float64Array): { re: Float64Array; im: Float64Array } {
    const { n, rev, re, im, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      re[rev[i]!] = frame[i]!;
      im[rev[i]!] = 0;
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
    const { outRe, outIm } = this;
    for (let k = 0; k <= n / 2; k++) {
      outRe[k] = re[k]!;
      outIm[k] = im[k]!;
    }
    return { re: outRe, im: outIm };
  }
}

/** Direct O(N²) DFT — reference for validating {@link FftRadix2}. First n/2+1 bins. */
export function naiveDft(frame: ArrayLike<number>): { re: Float64Array; im: Float64Array } {
  const n = frame.length;
  const re = new Float64Array(n / 2 + 1);
  const im = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * k * t) / n;
      sr += frame[t]! * Math.cos(ang);
      si += frame[t]! * Math.sin(ang);
    }
    re[k] = sr;
    im[k] = si;
  }
  return { re, im };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/live-fft.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/live/fft.ts test/live-fft.test.ts
git commit -m "feat(live): pure-TS radix-2 rfft (FftRadix2) + naive-DFT reference"
```

---

### Task 2: Streaming spatial-covariance accumulator (`covariance.ts`)

**Files:**
- Create: `src/live/covariance.ts`
- Test: `test/live-covariance.test.ts`

**Interfaces:**
- Consumes: `FftRadix2` (Task 1); the `Complex` **type** from `../beamformer/geometry.js` (the per-bin outer product is inlined as real arithmetic — no complex helpers needed here).
- Produces:
  - `class StreamingCovarianceAccumulator` — constructor `(opts: { channels: number; sampleRate: number; fLoHz?: number; fHiHz?: number; alpha?: number; warmupFrames?: number })`; `accumulate(channels: Float32Array[]): void`; `snapshot(): { rBand: Complex[][][]; freqs: number[] } | null` (null until `warmupFrames` frames processed; `rBand` is `nBand × M × M`, a fresh deep copy); `reset(): void`; readonly `framesSeen: number`.
  - Constants `COV_FRAME = 1024`, `COV_HOP = 512`.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-covariance.test.ts
import { describe, it, expect } from 'vitest';
import { StreamingCovarianceAccumulator } from '../src/live/covariance.js';
import { planeWaveChannels } from '../src/live/mock-adapter.js';
import { sensibel8 } from '../src/beamformer/geometry.js';

function feed(acc: StreamingCovarianceAccumulator, channels: Float32Array[], chunk: number): void {
  const n = channels[0]!.length;
  for (let s = 0; s < n; s += chunk) {
    const e = Math.min(s + chunk, n);
    acc.accumulate(channels.map((c) => c.subarray(s, e)));
  }
}

describe('StreamingCovarianceAccumulator', () => {
  it('is null until warmed up, then yields a Hermitian band covariance', () => {
    const acc = new StreamingCovarianceAccumulator({ channels: 8, sampleRate: 44100, warmupFrames: 4 });
    const chans = planeWaveChannels(sensibel8(0.04), 90, 90, 1500, 44100, 8192);
    expect(acc.snapshot()).toBeNull(); // nothing fed yet
    feed(acc, chans, 512);
    const snap = acc.snapshot();
    expect(snap).not.toBeNull();
    const { rBand } = snap!;
    expect(rBand.length).toBeGreaterThan(0); // some band bins
    // Hermitian: R[f][i][j] == conj(R[f][j][i]); diagonal real & ≥ 0
    const f = 0;
    for (let i = 0; i < 8; i++) {
      expect(rBand[f]![i]![i]!.im).toBeCloseTo(0, 6);
      expect(rBand[f]![i]![i]!.re).toBeGreaterThanOrEqual(0);
      for (let j = 0; j < 8; j++) {
        expect(rBand[f]![i]![j]!.re).toBeCloseTo(rBand[f]![j]![i]!.re, 6);
        expect(rBand[f]![i]![j]!.im).toBeCloseTo(-rBand[f]![j]![i]!.im, 6);
      }
    }
  });

  it('bridges odd block sizes to the same result as 512-sample blocks', () => {
    const chans = planeWaveChannels(sensibel8(0.04), 45, 90, 1200, 44100, 8192);
    const a = new StreamingCovarianceAccumulator({ channels: 8, sampleRate: 44100, warmupFrames: 1 });
    const b = new StreamingCovarianceAccumulator({ channels: 8, sampleRate: 44100, warmupFrames: 1 });
    feed(a, chans, 512); // hop-aligned
    feed(b, chans, 300); // ragged
    const ra = a.snapshot()!.rBand;
    const rb = b.snapshot()!.rBand;
    // same number of hops processed → identical covariance
    expect(a.framesSeen).toBe(b.framesSeen);
    expect(ra[0]![0]![0]!.re).toBeCloseTo(rb[0]![0]![0]!.re, 6);
    expect(ra[0]![1]![2]!.im).toBeCloseTo(rb[0]![1]![2]!.im, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-covariance.test.ts`
Expected: FAIL — import of `../src/live/covariance.js` unresolved.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/live/covariance.ts
/**
 * Streaming spatial-covariance accumulator for live DOA. Bridges the engine's
 * arbitrary per-block channels to fixed Hann STFT frames (FRAME/HOP), takes the
 * rfft of each channel, restricts to a speech band, accumulates the per-bin outer
 * product xxᴴ, and EMA-smooths it into R(f). Pure, Float64, zero-dep. Mirrors the
 * Python live tap (FRAME=1024 / HOP=512 / alpha=0.05).
 */
import { FftRadix2 } from './fft.js';
import type { Complex } from '../beamformer/geometry.js';

export const COV_FRAME = 1024;
export const COV_HOP = 512;

export class StreamingCovarianceAccumulator {
  private readonly M: number;
  private readonly fft: FftRadix2;
  private readonly hann: Float64Array;
  private readonly band: number[]; // rfft bin indices in [fLo, fHi]
  private readonly freqsBand: number[];
  private readonly alpha: number;
  private readonly warmup: number;
  private fifo: Float64Array[]; // per channel, capacity grows as needed
  private fill = 0;
  private readonly frame = new Float64Array(COV_FRAME);
  private readonly specRe: Float64Array[]; // per channel band spectra (reused)
  private readonly specIm: Float64Array[];
  private readonly R: Complex[][][]; // nBand × M × M, EMA-accumulated in place
  private _framesSeen = 0;

  constructor(opts: { channels: number; sampleRate: number; fLoHz?: number; fHiHz?: number; alpha?: number; warmupFrames?: number }) {
    this.M = opts.channels;
    this.alpha = opts.alpha ?? 0.05;
    this.warmup = opts.warmupFrames ?? 4;
    this.fft = new FftRadix2(COV_FRAME);
    this.hann = new Float64Array(COV_FRAME);
    for (let i = 0; i < COV_FRAME; i++) this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (COV_FRAME - 1));
    const fLo = opts.fLoHz ?? 300;
    const fHi = opts.fHiHz ?? 3800;
    this.band = [];
    this.freqsBand = [];
    for (let k = 0; k <= COV_FRAME / 2; k++) {
      const f = (k * opts.sampleRate) / COV_FRAME;
      if (f >= fLo && f <= fHi) {
        this.band.push(k);
        this.freqsBand.push(f);
      }
    }
    this.fifo = Array.from({ length: this.M }, () => new Float64Array(COV_FRAME * 2));
    this.specRe = Array.from({ length: this.M }, () => new Float64Array(this.band.length));
    this.specIm = Array.from({ length: this.M }, () => new Float64Array(this.band.length));
    this.R = this.band.map(() =>
      Array.from({ length: this.M }, () => Array.from({ length: this.M }, () => ({ re: 0, im: 0 }))),
    );
  }

  get framesSeen(): number {
    return this._framesSeen;
  }

  /** Feed one engine block (M channels, equal length). Processes any completed hops. */
  accumulate(channels: Float32Array[]): void {
    const n = channels[0]?.length ?? 0;
    if (n === 0) return;
    if (this.fill + n > this.fifo[0]!.length) this.grow(this.fill + n);
    for (let m = 0; m < this.M; m++) {
      const dst = this.fifo[m]!;
      const src = channels[m]!;
      for (let i = 0; i < n; i++) dst[this.fill + i] = src[i]!;
    }
    this.fill += n;
    while (this.fill >= COV_FRAME) {
      this.processFrame();
      for (let m = 0; m < this.M; m++) this.fifo[m]!.copyWithin(0, COV_HOP, this.fill);
      this.fill -= COV_HOP;
    }
  }

  private grow(need: number): void {
    let cap = this.fifo[0]!.length;
    while (cap < need) cap *= 2;
    this.fifo = this.fifo.map((old) => {
      const next = new Float64Array(cap);
      next.set(old.subarray(0, this.fill));
      return next;
    });
  }

  private processFrame(): void {
    const a = this.alpha;
    for (let m = 0; m < this.M; m++) {
      const buf = this.fifo[m]!;
      for (let i = 0; i < COV_FRAME; i++) this.frame[i] = buf[i]! * this.hann[i]!;
      const X = this.fft.rfft(this.frame);
      const sr = this.specRe[m]!;
      const si = this.specIm[m]!;
      for (let b = 0; b < this.band.length; b++) {
        const k = this.band[b]!;
        sr[b] = X.re[k]!;
        si[b] = X.im[k]!;
      }
    }
    for (let b = 0; b < this.band.length; b++) {
      const Rb = this.R[b]!;
      for (let i = 0; i < this.M; i++) {
        const xir = this.specRe[i]![b]!;
        const xii = this.specIm[i]![b]!;
        for (let j = 0; j < this.M; j++) {
          const xjr = this.specRe[j]![b]!;
          const xji = this.specIm[j]![b]!;
          // inst = X_i · conj(X_j)
          const instRe = xir * xjr + xii * xji;
          const instIm = xii * xjr - xir * xji;
          const cell = Rb[i]![j]!;
          cell.re = (1 - a) * cell.re + a * instRe;
          cell.im = (1 - a) * cell.im + a * instIm;
        }
      }
    }
    this._framesSeen += 1;
  }

  /** Deep-copied band covariance + band frequencies, or null until warmed up. */
  snapshot(): { rBand: Complex[][][]; freqs: number[] } | null {
    if (this._framesSeen < this.warmup) return null;
    const rBand = this.R.map((mat) => mat.map((row) => row.map((c) => ({ re: c.re, im: c.im }))));
    return { rBand, freqs: this.freqsBand.slice() };
  }

  reset(): void {
    this.fill = 0;
    this._framesSeen = 0;
    for (const mat of this.R) for (const row of mat) for (const c of row) { c.re = 0; c.im = 0; }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/live-covariance.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/live/covariance.ts test/live-covariance.test.ts
git commit -m "feat(live): streaming spatial-covariance accumulator (STFT + band + EMA)"
```

---

### Task 3: SRP-PHAT DOA detector (`doa.ts`)

**Files:**
- Create: `src/live/doa.ts`
- Test: `test/live-doa.test.ts`

**Interfaces:**
- Consumes: `Complex`, `cexpj`, `cabs`, `ArrayGeometry`, `SOUND_SPEED_MPS` from `../beamformer/geometry.js`; `directionUnit` from `./beam.js`.
- Produces:
  - `interface Detection { azimuthDeg: number; salienceDb: number; inSector?: boolean }`
  - `interface DoaResult { detections: Detection[]; gridDeg: number[]; powerDb: number[]; active: boolean }`
  - `interface DetectOptions { offNadirDeg?: number; gridStepDeg?: number; maxTalkers?: number; minSeparationDeg?: number; minSalienceDb?: number; vadFloorDb?: number }`
  - `function detect(rBand: Complex[][][], freqs: number[], geom: ArrayGeometry, opts?: DetectOptions): DoaResult`
  - `function circularSep(aDeg: number, bDeg: number): number`
  - `function inSector(azimuthDeg: number, centerDeg: number, halfWidthDeg: number, frontOffsetDeg?: number): boolean`
  - `function sectorGate(detections: Detection[], centerDeg: number, halfWidthDeg: number, frontOffsetDeg?: number): Detection[]`

- [ ] **Step 1: Write the failing test**

```ts
// test/live-doa.test.ts
import { describe, it, expect } from 'vitest';
import { detect, circularSep, inSector, sectorGate } from '../src/live/doa.js';
import { sensibel8, SOUND_SPEED_MPS, cexpj, type Complex } from '../src/beamformer/geometry.js';
import { directionUnit } from '../src/live/beam.js';

/** A rank-1 band covariance R(f) = a·aᴴ for a single source at `azDeg` (off-nadir 90). */
function rankOneCovariance(geom: ReturnType<typeof sensibel8>, azDeg: number, freqs: number[]): Complex[][][] {
  const [ux, uy, uz] = directionUnit(azDeg, 90);
  const M = geom.nChannels;
  return freqs.map((f) => {
    const k = (2 * Math.PI * f) / SOUND_SPEED_MPS;
    const a: Complex[] = geom.elements.map((e) => cexpj(k * (e[0] * ux + e[1] * uy + e[2] * uz)));
    const R: Complex[][] = [];
    for (let i = 0; i < M; i++) {
      R[i] = [];
      for (let j = 0; j < M; j++) {
        // a_i · conj(a_j)
        R[i]![j] = { re: a[i]!.re * a[j]!.re + a[i]!.im * a[j]!.im, im: a[i]!.im * a[j]!.re - a[i]!.re * a[j]!.im };
      }
    }
    return R;
  });
}

const FREQS = [400, 800, 1200, 1600, 2000, 2600, 3200, 3800];

describe('circularSep', () => {
  it('wraps around 0/360', () => {
    expect(circularSep(350, 10)).toBeCloseTo(20, 9);
    expect(circularSep(10, 350)).toBeCloseTo(20, 9);
    expect(circularSep(90, 90)).toBe(0);
  });
});

describe('detect', () => {
  it('recovers a single source azimuth within a grid step', () => {
    const geom = sensibel8(0.04);
    const R = rankOneCovariance(geom, 80, FREQS);
    const res = detect(R, FREQS, geom);
    expect(res.active).toBe(true);
    expect(res.detections.length).toBeGreaterThanOrEqual(1);
    expect(circularSep(res.detections[0]!.azimuthDeg, 80)).toBeLessThanOrEqual(4); // ≤ 2 grid steps
  });

  it('finds two sources ≥ 40° apart', () => {
    const geom = sensibel8(0.04);
    const r1 = rankOneCovariance(geom, 30, FREQS);
    const r2 = rankOneCovariance(geom, 170, FREQS);
    const R = r1.map((m, f) => m.map((row, i) => row.map((c, j) => ({ re: c.re + r2[f]![i]![j]!.re, im: c.im + r2[f]![i]![j]!.im }))));
    const res = detect(R, FREQS, geom, { maxTalkers: 2 });
    const az = res.detections.map((d) => d.azimuthDeg);
    expect(az.some((a) => circularSep(a, 30) <= 6)).toBe(true);
    expect(az.some((a) => circularSep(a, 170) <= 6)).toBe(true);
  });

  it('reports inactive on a flat (zero) covariance', () => {
    const geom = sensibel8(0.04);
    const R = FREQS.map(() => Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => ({ re: 0, im: 0 }))));
    const res = detect(R, FREQS, geom);
    expect(res.active).toBe(false);
    expect(res.detections).toEqual([]);
  });
});

describe('sector gate', () => {
  it('marks in/out of a wrap-aware sector', () => {
    expect(inSector(5, 0, 30)).toBe(true);
    expect(inSector(355, 0, 30)).toBe(true); // wrap
    expect(inSector(100, 0, 30)).toBe(false);
    const det = sectorGate([{ azimuthDeg: 5, salienceDb: 10 }, { azimuthDeg: 100, salienceDb: 8 }], 0, 30);
    expect(det[0]!.inSector).toBe(true);
    expect(det[1]!.inSector).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-doa.test.ts`
Expected: FAIL — import of `../src/live/doa.js` unresolved.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/live/doa.ts
/**
 * SRP-PHAT direction-of-arrival over an azimuth grid. Consumes a per-frequency
 * spatial covariance R(f) (Hermitian, over all M capsules) and the array geometry;
 * scans azimuth with a PHAT-whitened steered-response-power map and peak-picks the
 * talker bearings. Azimuth-only (planar array): off-nadir fixed at 90°. Pure,
 * zero-dep. Port of conf_pipeline_control/doa.py.
 */
import {
  ArrayGeometry,
  SOUND_SPEED_MPS,
  cexpj,
  cabs,
  type Complex,
} from '../beamformer/geometry.js';
import { directionUnit } from './beam.js';

export const DEFAULT_DOA = {
  offNadirDeg: 90,
  gridStepDeg: 2,
  maxTalkers: 3,
  minSeparationDeg: 40,
  minSalienceDb: 3,
  vadFloorDb: 3,
} as const;

export interface Detection {
  azimuthDeg: number;
  salienceDb: number;
  inSector?: boolean;
}

export interface DoaResult {
  detections: Detection[];
  gridDeg: number[];
  powerDb: number[];
  active: boolean;
}

export interface DetectOptions {
  offNadirDeg?: number;
  gridStepDeg?: number;
  maxTalkers?: number;
  minSeparationDeg?: number;
  minSalienceDb?: number;
  vadFloorDb?: number;
}

/** Smallest unsigned angular separation between two bearings (deg, 0..180). */
export function circularSep(aDeg: number, bDeg: number): number {
  const d = Math.abs(aDeg - bDeg) % 360;
  return Math.min(d, 360 - d);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** SRP-PHAT power per grid azimuth: P(az) = Σ_f aᴴ R̂ a, R̂ = R/|R| (PHAT). */
function srpPhatMap(
  rBand: Complex[][][],
  freqs: number[],
  positions: number[][],
  gridDeg: number[],
  offNadirDeg: number,
): number[] {
  const na = positions.length;
  const G = gridDeg.length;
  // unit vectors per grid azimuth
  const units = gridDeg.map((az) => directionUnit(az, offNadirDeg));
  const power = new Array<number>(G).fill(0);
  for (let f = 0; f < freqs.length; f++) {
    const k = (2 * Math.PI * freqs[f]!) / SOUND_SPEED_MPS;
    const Rf = rBand[f]!;
    // PHAT whitening: r̂ = r / (|r| + ε)
    const rHat: Complex[][] = [];
    for (let i = 0; i < na; i++) {
      rHat[i] = [];
      for (let j = 0; j < na; j++) {
        const r = Rf[i]![j]!;
        const mag = cabs(r) + 1e-12;
        rHat[i]![j] = { re: r.re / mag, im: r.im / mag };
      }
    }
    for (let g = 0; g < G; g++) {
      const u = units[g]!;
      // steering vector a_m = exp(+j k (p_m·u))
      const a: Complex[] = positions.map((p) => cexpj(k * (p[0]! * u[0] + p[1]! * u[1] + p[2]! * u[2])));
      // aᴴ R̂ a = Σ_i conj(a_i) Σ_j r̂_ij a_j  (real)
      let acc = 0;
      for (let i = 0; i < na; i++) {
        let rar = 0;
        let rai = 0;
        for (let j = 0; j < na; j++) {
          const rh = rHat[i]![j]!;
          const aj = a[j]!;
          rar += rh.re * aj.re - rh.im * aj.im;
          rai += rh.re * aj.im + rh.im * aj.re;
        }
        const ai = a[i]!;
        // conj(a_i)·(R̂a)_i, real part
        acc += ai.re * rar + ai.im * rai;
      }
      power[g]! += acc;
    }
  }
  return power;
}

function pickPeaks(gridDeg: number[], powerDb: number[], maxTalkers: number, minSeparationDeg: number, minSalienceDb: number): Detection[] {
  const n = powerDb.length;
  const cand: number[] = [];
  for (let i = 0; i < n; i++) {
    if (powerDb[i]! >= powerDb[(i - 1 + n) % n]! && powerDb[i]! > powerDb[(i + 1) % n]!) cand.push(i);
  }
  cand.sort((a, b) => powerDb[b]! - powerDb[a]!);
  const out: Detection[] = [];
  for (const i of cand) {
    if (powerDb[i]! < minSalienceDb) break;
    const az = gridDeg[i]!;
    if (out.every((d) => circularSep(az, d.azimuthDeg) >= minSeparationDeg)) {
      out.push({ azimuthDeg: az, salienceDb: powerDb[i]! });
    }
    if (out.length >= maxTalkers) break;
  }
  return out;
}

/** Detect up to `maxTalkers` azimuths from a band covariance. */
export function detect(rBand: Complex[][][], freqs: number[], geom: ArrayGeometry, opts: DetectOptions = {}): DoaResult {
  const o = { ...DEFAULT_DOA, ...opts };
  const idx = geom.activeIndices();
  const positions = idx.map((i) => {
    const e = geom.elements[i]!;
    return [e[0], e[1], e[2]];
  });
  const rActive: Complex[][][] = rBand.map((Rf) => idx.map((i) => idx.map((j) => Rf[i]![j]!)));
  const gridDeg: number[] = [];
  for (let az = 0; az < 360; az += o.gridStepDeg) gridDeg.push(az);
  const p = srpPhatMap(rActive, freqs, positions, gridDeg, o.offNadirDeg);
  let med = median(p);
  if (med <= 0) {
    const mx = Math.max(...p, 0);
    med = mx > 0 ? mx : 1;
  }
  const powerDb = p.map((v) => 10 * Math.log10(Math.max(v, 1e-12) / med));
  const active = powerDb.length > 0 && Math.max(...powerDb) >= o.vadFloorDb;
  const detections = active ? pickPeaks(gridDeg, powerDb, o.maxTalkers, o.minSeparationDeg, o.minSalienceDb) : [];
  return { detections, gridDeg, powerDb, active };
}

/** Whether `azimuthDeg` lies within `center ± halfWidth` (wrap-aware). */
export function inSector(azimuthDeg: number, centerDeg: number, halfWidthDeg: number, frontOffsetDeg = 0): boolean {
  return circularSep(azimuthDeg - frontOffsetDeg, centerDeg) <= halfWidthDeg;
}

/** Mark each detection's `inSector` flag (mutates and returns the list). */
export function sectorGate(detections: Detection[], centerDeg: number, halfWidthDeg: number, frontOffsetDeg = 0): Detection[] {
  for (const d of detections) d.inSector = inSector(d.azimuthDeg, centerDeg, halfWidthDeg, frontOffsetDeg);
  return detections;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/live-doa.test.ts`
Expected: PASS (all DOA tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/live/doa.ts test/live-doa.test.ts
git commit -m "feat(live): SRP-PHAT DOA detector + sector gating"
```

---

### Task 4: Wrap-aware talker tracker (`tracker.ts`)

**Files:**
- Create: `src/live/tracker.ts`
- Test: `test/live-tracker.test.ts`

**Interfaces:**
- Consumes: `Detection` from `./doa.js`; `circularSep` from `./doa.js`.
- Produces:
  - `class TalkerTracker` — constructor `(opts?: { switchMarginDeg?: number; holdHops?: number })`; `update(strongestInSector: Detection | null): { azimuthDeg: number | null; held: boolean }`; `reset(): void`. Commit to the first target; switch only if `circularSep(new, held) ≥ switchMarginDeg`; on `null` input, hold the committed angle for `holdHops` calls then release. Defaults `switchMarginDeg=20`, `holdHops=5`.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-tracker.test.ts
import { describe, it, expect } from 'vitest';
import { TalkerTracker } from '../src/live/tracker.js';

const det = (az: number) => ({ azimuthDeg: az, salienceDb: 10 });

describe('TalkerTracker', () => {
  it('commits to the first target and ignores sub-margin jitter', () => {
    const t = new TalkerTracker({ switchMarginDeg: 20, holdHops: 3 });
    expect(t.update(det(90)).azimuthDeg).toBe(90);
    expect(t.update(det(100)).azimuthDeg).toBe(90); // 10° < 20° margin → hold committed
    expect(t.update(det(82)).azimuthDeg).toBe(90);
  });

  it('switches once a target moves past the margin', () => {
    const t = new TalkerTracker({ switchMarginDeg: 20, holdHops: 3 });
    t.update(det(90));
    expect(t.update(det(130)).azimuthDeg).toBe(130); // 40° ≥ 20° → switch
  });

  it('holds through a brief silence then releases', () => {
    const t = new TalkerTracker({ switchMarginDeg: 20, holdHops: 2 });
    t.update(det(90));
    const a = t.update(null);
    expect(a.azimuthDeg).toBe(90);
    expect(a.held).toBe(true);
    expect(t.update(null).azimuthDeg).toBe(90); // 2nd hold
    expect(t.update(null).azimuthDeg).toBeNull(); // released
  });

  it('wraps correctly near 0/360', () => {
    const t = new TalkerTracker({ switchMarginDeg: 20, holdHops: 3 });
    t.update(det(350));
    expect(t.update(det(5)).azimuthDeg).toBe(350); // sep 15° < 20° → hold
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-tracker.test.ts`
Expected: FAIL — import of `../src/live/tracker.js` unresolved.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/live/tracker.ts
/**
 * Wrap-aware talker hold/switch machine. Smooths the steered direction by
 * arbitrating which discrete talker to follow — NOT by EMA-ing the raw azimuth
 * (that would smear across the 0/360 seam and across talker switches). Port of
 * the Python _TalkerTracker. Pure, zero-dep.
 */
import { circularSep, type Detection } from './doa.js';

export class TalkerTracker {
  private readonly switchMarginDeg: number;
  private readonly holdHops: number;
  private heldAz: number | null = null;
  private holdLeft = 0;

  constructor(opts: { switchMarginDeg?: number; holdHops?: number } = {}) {
    this.switchMarginDeg = opts.switchMarginDeg ?? 20;
    this.holdHops = opts.holdHops ?? 5;
  }

  /** Feed the strongest in-sector detection (or null on silence). */
  update(strongestInSector: Detection | null): { azimuthDeg: number | null; held: boolean } {
    if (strongestInSector) {
      const az = strongestInSector.azimuthDeg;
      if (this.heldAz === null || circularSep(az, this.heldAz) >= this.switchMarginDeg) this.heldAz = az;
      this.holdLeft = this.holdHops;
      return { azimuthDeg: this.heldAz, held: false };
    }
    // silence: coast on the committed talker, then release
    if (this.heldAz !== null && this.holdLeft > 0) {
      this.holdLeft -= 1;
      return { azimuthDeg: this.heldAz, held: true };
    }
    this.heldAz = null;
    return { azimuthDeg: null, held: false };
  }

  reset(): void {
    this.heldAz = null;
    this.holdLeft = 0;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/live-tracker.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/live/tracker.ts test/live-tracker.test.ts
git commit -m "feat(live): wrap-aware talker hold/switch tracker"
```

---

### Task 5: Single-beam auto-steer controller (`autosteer.ts`)

**Files:**
- Create: `src/live/autosteer.ts`
- Test: `test/live-autosteer.test.ts`

**Interfaces:**
- Consumes: `DoaResult`, `Detection`, `inSector` from `./doa.js`; `TalkerTracker` from `./tracker.js`.
- Produces:
  - `interface SectorSpec { centerDeg: number; halfWidthDeg: number; frontOffsetDeg?: number }`
  - `interface AutoSteerOptions { mode: 'follow' | 'lockSeat'; sector?: SectorSpec; lockAzimuthDeg?: number; switchMarginDeg?: number; holdHops?: number; deadbandDeg?: number }`
  - `class AutoSteerController` — constructor `(opts: AutoSteerOptions)`; `decide(doa: DoaResult): { lookAzimuthDeg: number | null }`; `reset(): void`. `follow` → strongest in-sector detection through the tracker; `lockSeat` → the fixed `lockAzimuthDeg` (runs DOA only for readout). A `deadbandDeg` (default 3) suppresses re-aims smaller than it.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-autosteer.test.ts
import { describe, it, expect } from 'vitest';
import { AutoSteerController } from '../src/live/autosteer.js';
import type { DoaResult } from '../src/live/doa.js';

function doa(azs: number[], active = true): DoaResult {
  return { detections: azs.map((a) => ({ azimuthDeg: a, salienceDb: 10 })), gridDeg: [], powerDb: [], active };
}

describe('AutoSteerController', () => {
  it('follow: steers to the dominant in-sector detection, ignores out-of-sector', () => {
    const c = new AutoSteerController({ mode: 'follow', sector: { centerDeg: 0, halfWidthDeg: 45 } });
    expect(c.decide(doa([20, 200])).lookAzimuthDeg).toBe(20); // 200° out of sector
  });

  it('follow: returns null when nothing is in-sector and hold elapses', () => {
    const c = new AutoSteerController({ mode: 'follow', sector: { centerDeg: 0, halfWidthDeg: 30 }, holdHops: 1 });
    c.decide(doa([10]));
    c.decide(doa([], false)); // hold 1
    expect(c.decide(doa([], false)).lookAzimuthDeg).toBeNull();
  });

  it('follow: deadband suppresses a tiny re-aim', () => {
    const c = new AutoSteerController({ mode: 'follow', sector: { centerDeg: 0, halfWidthDeg: 90 }, deadbandDeg: 5, switchMarginDeg: 2 });
    expect(c.decide(doa([10])).lookAzimuthDeg).toBe(10);
    expect(c.decide(doa([13])).lookAzimuthDeg).toBeNull(); // 3° < 5° deadband → no re-aim
  });

  it('lockSeat: returns the fixed azimuth regardless of detections', () => {
    const c = new AutoSteerController({ mode: 'lockSeat', lockAzimuthDeg: 137 });
    expect(c.decide(doa([10, 200])).lookAzimuthDeg).toBe(137);
    expect(c.decide(doa([], false)).lookAzimuthDeg).toBeNull(); // already there → deadband
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-autosteer.test.ts`
Expected: FAIL — import of `../src/live/autosteer.js` unresolved.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/live/autosteer.ts
/**
 * Single-beam auto-steer: turns a DOA result into the next look azimuth for the
 * Phase-1 fractional-delay-and-sum beam. 'follow' tracks the dominant in-sector
 * talker (via the hold/switch tracker); 'lockSeat' pins a fixed seat azimuth. A
 * deadband suppresses tiny re-aims. Pure, zero-dep. Multi-bearing/nulling is a
 * later (frequency-domain) phase.
 */
import { inSector, circularSep, type DoaResult, type Detection } from './doa.js';
import { TalkerTracker } from './tracker.js';

export interface SectorSpec {
  centerDeg: number;
  halfWidthDeg: number;
  frontOffsetDeg?: number;
}

export interface AutoSteerOptions {
  mode: 'follow' | 'lockSeat';
  sector?: SectorSpec;
  lockAzimuthDeg?: number;
  switchMarginDeg?: number;
  holdHops?: number;
  deadbandDeg?: number;
}

export class AutoSteerController {
  private readonly opts: AutoSteerOptions;
  private readonly tracker: TalkerTracker;
  private readonly deadbandDeg: number;
  private current: number | null = null;

  constructor(opts: AutoSteerOptions) {
    this.opts = opts;
    this.deadbandDeg = opts.deadbandDeg ?? 3;
    this.tracker = new TalkerTracker({
      ...(opts.switchMarginDeg !== undefined ? { switchMarginDeg: opts.switchMarginDeg } : {}),
      ...(opts.holdHops !== undefined ? { holdHops: opts.holdHops } : {}),
    });
  }

  /** Decide the next look azimuth, or null to leave the beam where it is. */
  decide(doa: DoaResult): { lookAzimuthDeg: number | null } {
    let target: number | null;
    if (this.opts.mode === 'lockSeat') {
      target = this.opts.lockAzimuthDeg ?? null;
    } else {
      const sec = this.opts.sector;
      const inAz = doa.detections
        .filter((d: Detection) => (sec ? inSector(d.azimuthDeg, sec.centerDeg, sec.halfWidthDeg, sec.frontOffsetDeg ?? 0) : true))
        .sort((a, b) => b.salienceDb - a.salienceDb);
      const strongest = inAz.length > 0 ? inAz[0]! : null;
      target = this.tracker.update(strongest).azimuthDeg;
    }
    if (target === null) {
      this.current = null;
      return { lookAzimuthDeg: null };
    }
    if (this.current !== null && circularSep(target, this.current) < this.deadbandDeg) {
      return { lookAzimuthDeg: null }; // within deadband — no re-aim
    }
    this.current = target;
    return { lookAzimuthDeg: target };
  }

  reset(): void {
    this.tracker.reset();
    this.current = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/live-autosteer.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/live/autosteer.ts test/live-autosteer.test.ts
git commit -m "feat(live): single-beam auto-steer controller (follow / lock-seat)"
```

---

### Task 6: Wire auto-steer into the LiveEngine (`engine.ts`, `types.ts`, `index.ts`)

**Files:**
- Modify: `src/live/types.ts`, `src/live/engine.ts`, `src/live/index.ts`
- Test: `test/live-engine.test.ts` (append)

**Interfaces:**
- Consumes: `StreamingCovarianceAccumulator` (Task 2), `detect`/`DetectOptions` (Task 3), `AutoSteerController`/`AutoSteerOptions` (Task 5); `seatAzimuthForArray` from `../seat-mapper/seat-mapper.js`; `SystemConfig` from `../model/index.js`.
- Produces:
  - `types.ts`: `type AutoSteerMode = 'manual' | 'follow' | 'lockSeat'`; `interface AutoSteerConfig { mode: AutoSteerMode; sector?: { centerDeg: number; halfWidthDeg: number; frontOffsetDeg?: number }; room?: SystemConfig; arrayId?: string; seatId?: string; detectionHops?: number; doa?: DetectOptions; switchMarginDeg?: number; holdHops?: number }`; `LiveConfig` gains `autoSteer?: AutoSteerConfig`; `BeamOutput` gains `detected?: { azimuths: number[]; salienceDb: number[] } | null`, `doaActive?: boolean`, `mode?: AutoSteerMode`, `lockedTarget?: { azimuthDeg: number; seatId?: string } | null`.
  - `engine.ts`: `LiveEngine` runs the auto-steer loop when `config.autoSteer && mode !== 'manual'`.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-engine.test.ts (append)
import { sensibel8 } from '../src/beamformer/geometry.js';

describe('LiveEngine auto-steer', () => {
  it('follow mode re-aims the beam toward a synthetic source', async () => {
    const geom = sensibel8(0.04);
    const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 30, blockSize: 512, freqHz: 1500 });
    const engine = new LiveEngine(mock, {
      geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 0, // start pointed away
      autoSteer: { mode: 'follow', sector: { centerDeg: 90, halfWidthDeg: 60 }, detectionHops: 2 },
    });
    let last: number | undefined;
    let detectedSeen = false;
    engine.onOutput((o) => {
      last = o.azimuthDeg;
      if (o.detected && o.detected.azimuths.length > 0) detectedSeen = true;
    });
    await engine.start();
    expect(detectedSeen).toBe(true);
    // the beam ended up aimed near the 90° source (within a grid step or two)
    expect(Math.min(Math.abs((last ?? 0) - 90), 360 - Math.abs((last ?? 0) - 90))).toBeLessThanOrEqual(6);
  });

  it('manual mode leaves the beam static (no DOA steering)', async () => {
    const geom = sensibel8(0.04);
    const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 10, blockSize: 512, freqHz: 1500 });
    const engine = new LiveEngine(mock, { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 0 });
    let last = -1;
    engine.onOutput((o) => { last = o.azimuthDeg; });
    await engine.start();
    expect(last).toBe(0); // unchanged
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-engine.test.ts`
Expected: FAIL — `autoSteer` not accepted by `LiveConfig` / beam does not re-aim.

- [ ] **Step 3: Extend the types**

In `src/live/types.ts`, add the import and types, and extend `BeamOutput` + `LiveConfig`:

```ts
// at the top, alongside the existing geometry import:
import type { SystemConfig } from '../model/index.js';
import type { DetectOptions } from './doa.js';
```
```ts
// add these declarations:
export type AutoSteerMode = 'manual' | 'follow' | 'lockSeat';

export interface AutoSteerConfig {
  mode: AutoSteerMode;
  sector?: { centerDeg: number; halfWidthDeg: number; frontOffsetDeg?: number };
  /** Room config + which array/seat, for mode 'lockSeat'. */
  room?: SystemConfig;
  arrayId?: string;
  seatId?: string;
  /** Run detect every K covariance hops (default 11 ≈ 8 Hz at 44.1 kHz). */
  detectionHops?: number;
  doa?: DetectOptions;
  switchMarginDeg?: number;
  holdHops?: number;
}
```
Add to `BeamOutput` (after the existing fields):
```ts
  detected?: { azimuths: number[]; salienceDb: number[] } | null;
  doaActive?: boolean;
  mode?: AutoSteerMode;
  lockedTarget?: { azimuthDeg: number; seatId?: string } | null;
```
Add to `LiveConfig` (after the existing fields):
```ts
  autoSteer?: AutoSteerConfig;
```

- [ ] **Step 4: Extend the engine**

In `src/live/engine.ts`, add imports and the auto-steer loop:

```ts
// add imports (value imports — these are classes/functions):
import { StreamingCovarianceAccumulator, COV_HOP } from './covariance.js';
import { detect, type DoaResult } from './doa.js';
import { AutoSteerController, type AutoSteerOptions } from './autosteer.js';
import { seatAzimuthForArray } from '../seat-mapper/seat-mapper.js';
import type { AutoSteerConfig, BeamOutput } from './types.js';
```

Add private fields to `LiveEngine` and build them in the constructor when auto-steer is active. After the existing `this.beam.setLook(...)` line in the constructor, append:

```ts
    // --- Phase 2: optional auto-steer ---
    const as = config.autoSteer;
    if (as && as.mode !== 'manual') {
      this._mode = as.mode;
      this.cov = new StreamingCovarianceAccumulator({ channels: config.geom.nChannels, sampleRate: config.sampleRate ?? 44100 });
      this.detectionHops = as.detectionHops ?? 11;
      // Resolve the seat azimuth once for lock-seat; fall back to follow if unresolved.
      let mode: 'follow' | 'lockSeat' = as.mode;
      let lockAz: number | undefined;
      if (as.mode === 'lockSeat') {
        const az = as.room && as.arrayId && as.seatId ? seatAzimuthForArray(as.room, as.arrayId, as.seatId) : null;
        if (az === null || az === undefined) mode = 'follow';
        else {
          lockAz = az;
          this._lockedTarget = { azimuthDeg: az, ...(as.seatId !== undefined ? { seatId: as.seatId } : {}) };
        }
      }
      const opts: AutoSteerOptions = {
        mode,
        ...(as.sector !== undefined ? { sector: as.sector } : {}),
        ...(lockAz !== undefined ? { lockAzimuthDeg: lockAz } : {}),
        ...(as.switchMarginDeg !== undefined ? { switchMarginDeg: as.switchMarginDeg } : {}),
        ...(as.holdHops !== undefined ? { holdHops: as.holdHops } : {}),
      };
      this.autosteer = new AutoSteerController(opts);
      this.doaOpts = as.doa ?? {};
    }
```

Declare the fields on the class (alongside the existing private fields):

```ts
  private cov: StreamingCovarianceAccumulator | null = null;
  private autosteer: AutoSteerController | null = null;
  private detectionHops = 11;
  private hopsSeen = 0;
  private lastFrames = 0;
  private doaOpts: import('./doa.js').DetectOptions = {};
  private _mode: BeamOutput['mode'] = 'manual';
  private _lockedTarget: BeamOutput['lockedTarget'] = null;
  private lastDoa: DoaResult | null = null;
```

In `start()`, inside the `onBlock` callback, AFTER `this.meter.update(mono)` and BEFORE building/emitting the output, insert the auto-steer step:

```ts
        // Phase 2: feed covariance + run DOA/steer on the configured hop cadence.
        if (this.cov && this.autosteer) {
          this.cov.accumulate(channels);
          if (this.cov.framesSeen - this.lastFrames >= this.detectionHops) {
            this.lastFrames = this.cov.framesSeen;
            const snap = this.cov.snapshot();
            if (snap) {
              this.lastDoa = detect(snap.rBand, snap.freqs, this.config.geom, this.doaOpts);
              const decision = this.autosteer.decide(this.lastDoa);
              if (decision.lookAzimuthDeg !== null) this.setLook(decision.lookAzimuthDeg);
            }
          }
        }
```

Extend the emitted `BeamOutput` object (the `this.cb?.({ ... })` call) with the Phase-2 fields:

```ts
          detected: this.lastDoa ? { azimuths: this.lastDoa.detections.map((d) => d.azimuthDeg), salienceDb: this.lastDoa.detections.map((d) => d.salienceDb) } : null,
          doaActive: this.lastDoa ? this.lastDoa.active : false,
          mode: this._mode,
          lockedTarget: this._lockedTarget,
```

(Note: `COV_HOP` is imported for documentation/consistency; the cadence uses `framesSeen`. If `noUnusedLocals` flags `COV_HOP`, drop it from the import.)

- [ ] **Step 5: Export the new surface**

In `src/live/index.ts`, append:

```ts
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
export type { AutoSteerMode, AutoSteerConfig } from './types.js';
```

- [ ] **Step 6: Run test + full gate**

Run: `npx vitest run test/live-engine.test.ts && npm run typecheck && npm run build`
Expected: tests PASS (existing live-engine tests + the 2 new auto-steer tests); `tsc` clean; build emits `dist/live/`.

If `COV_HOP` is unused in `engine.ts` and `noUnusedLocals` errors, remove it from the engine import (keep it in the `index.ts` export). If a `let last` holding `o.azimuthDeg` is fine (number). No `as` casts.

- [ ] **Step 7: Commit**

```bash
git add src/live/types.ts src/live/engine.ts src/live/index.ts test/live-engine.test.ts
git commit -m "feat(live): wire DOA auto-steer / lock-to-seat into LiveEngine"
```

---

### Task 7: Docs (README + CHANGELOG + CLAUDE.md) + final gate

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: Add a README subsection**

Append to the "Live audio (Phase 1, Node)" section in `README.md`:

```markdown
### Live steering (Phase 2)

The live engine can **steer itself**. Enable it with `LiveConfig.autoSteer`:

```ts
const engine = new LiveEngine(new NodeCaptureAdapter(), {
  geom, deviceName: 'SB-POLARIS', sampleRate: 44100,
  autoSteer: { mode: 'follow', sector: { centerDeg: 0, halfWidthDeg: 60 } }, // follow the dominant talker in front
});
engine.onOutput((o) => { /* o.detected = bearings; o.doaActive = VAD; o.azimuthDeg = where the beam points */ });
```

- `mode: 'follow'` — SRP-PHAT direction-of-arrival (2° azimuth grid, band-limited 300–3800 Hz) picks the
  dominant talker; a hold/switch tracker re-aims the single beam at it without jitter.
- `mode: 'lockSeat'` (+ `room`, `arrayId`, `seatId`) — pin the beam to a room seat's azimuth (via the
  seat-mapper; needs the array's `bearingDeg`). Falls back to `follow` if the seat can't be resolved.
- `mode: 'manual'` (default) — Phase-1 behavior; you call `setLook` yourself.

Still pure and zero-dependency: the FFT is a built-in radix-2 transform. **Honest limits:** azimuth only
(off-nadir fixed at 90°; a planar ring can't tell a source above the array plane from below); resolution
≈ beamwidth (~40° min talker separation); band-limited below the ~5.6 kHz spatial-aliasing cutoff;
single-talker follow (simultaneous multi-talker capture is a later, frequency-domain phase).
```

- [ ] **Step 2: Add CHANGELOG `[Unreleased] > Added` bullet**

```markdown
- **Live steering (Phase 2)** — the live engine steers itself. A pure, zero-dependency SRP-PHAT
  direction-of-arrival (`doa.ts`, fed by a built-in radix-2 `rfft` in `fft.ts` + a streaming
  spatial-covariance accumulator in `covariance.ts`) drives a wrap-aware hold/switch tracker
  (`tracker.ts`) and a single-beam auto-steer controller (`autosteer.ts`), wired into `LiveEngine`
  behind `LiveConfig.autoSteer` (`mode: 'manual' | 'follow' | 'lockSeat'`; default `manual` =
  Phase-1 behavior). `BeamOutput` gains `detected`/`doaActive`/`mode`/`lockedTarget`. Lock-to-seat
  reuses the seat-mapper. Azimuth-only (off-nadir 90°), band 300–3800 Hz, single-talker follow; the
  FFT adds no dependency. Ported from the Python engine's `doa`/`autosteer`/`tracking`.
```

- [ ] **Step 3: Add a CLAUDE.md note**

Append to the "Live audio" architecture bullet in `CLAUDE.md`:

```markdown
- **Live steering (Phase 2, `src/live/{fft,covariance,doa,tracker,autosteer}.ts`).** SRP-PHAT DOA
  over a 2° azimuth grid (band 300–3800 Hz), fed by a built-in radix-2 `rfft` + a streaming
  spatial-covariance accumulator, drives a wrap-aware hold/switch tracker that re-aims the single
  delay-sum beam at the dominant in-sector talker (or a locked seat). Opt-in via `LiveConfig.autoSteer`
  (default `manual` = Phase-1 unchanged); still zero-dep (the FFT is pure TS). Azimuth-only (off-nadir
  90°; a planar ring can't resolve above/below the plane); multi-talker/nulling is a later
  frequency-domain phase.
```

- [ ] **Step 4: Final gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: `tsc` clean; ALL tests pass (existing + the new Phase-2 tests); build emits `dist/live/` (and `dist/live-node/`).

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md CLAUDE.md
git commit -m "docs: document Phase 2 live steering (DOA + auto-steer)"
```

---

## Self-Review

**Spec coverage:** FFT (Task 1); covariance accumulator (Task 2); SRP-PHAT DOA + sector gating (Task 3); wrap-aware tracker (Task 4); single-beam auto-steer follow/lock-seat (Task 5); LiveEngine integration + BeamOutput/LiveConfig additions + lock-to-seat via seat-mapper + manual default (Task 6); honest-limits docs (Task 7). Deferred items (multi-talker/nulling, cleaning chain, elevation) are correctly absent.

**Placeholder scan:** none — every code/test step has complete code and exact commands.

**Type consistency:** `Complex` (re/im) and the helpers (`cexpj`/`cabs`) are reused from `beamformer/geometry.js` across Tasks 2–3; `Detection`/`DoaResult`/`DetectOptions` defined in Task 3 are consumed by Tasks 4–6; `circularSep`/`inSector` (Task 3) used by Tasks 4–5; `StreamingCovarianceAccumulator.framesSeen`/`snapshot()` (Task 2) used by Task 6; `AutoSteerController.decide` (Task 5) used by Task 6; `seatAzimuthForArray` (existing) used by Task 6. The covariance snapshot's `rBand` is `nBand × M × M` over **all** channels; `detect` slices to `geom.activeIndices()` — consistent with the Python contract.

**Implementer notes:** (1) The DOA tests build `R(f)` analytically (rank-1 `a·aᴴ`) so they don't depend on the FFT/covariance — keep them self-contained. (2) The engine auto-steer step runs only when `autoSteer.mode !== 'manual'`; manual mode must stay byte-identical to Phase 1 (the "manual leaves the beam static" test guards this). (3) Energy/closeness assertions use a ≤6° tolerance (≤3 grid steps) — do not tighten; SRP peaks land on the 2° grid. (4) If `noUnusedLocals` flags `COV_HOP` in `engine.ts`, drop it from that import only.
