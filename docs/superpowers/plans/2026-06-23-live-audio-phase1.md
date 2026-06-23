# Live Audio — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pluggable, real-time live-audio layer to the TS pipeline — a fixed-beam fractional-delay-and-sum beamformer fed by a Node-native 8-channel POLARIS capture adapter, with a mono output + level meter, all hardware-free-testable.

**Architecture:** A pure, zero-dependency, browser-safe **core** (`src/live/`) with a `CaptureAdapter` interface, a fractional-delay-and-sum streaming beamformer (ported from the Python live engine), a level meter, a `LiveEngine` that wires capture → beam → meter, and a `MockCaptureAdapter`. A **Node-only** adapter (`src/live-node/`) behind a new `./live-node` subpath lazy-imports the optional native addon `naudiodon2` to talk to the real array.

**Tech Stack:** TypeScript (ESM, strict), vitest, the existing `src/beamformer/geometry.ts` (ArrayGeometry/sensibel8) and `src/beamformer/steering.ts` (`Direction`), `naudiodon2` (optional peer dep, PortAudio).

## Global Constraints

- ESM-only; **every relative import carries a `.js` extension** (e.g. `from './beam.js'`).
- **Zero hard runtime dependencies:** `package.json` `dependencies` stays `{}`. `naudiodon2` is an **optional `peerDependency`**, **lazy-imported inside a method**, never at module top level.
- The main barrel `src/index.ts` and everything under `src/live/` **must never import `node:*`** (browser-safe). Node-only code lives under `src/live-node/` reached via the `./live-node` subpath.
- Strict tsconfig is already on: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`/`Parameters`, `verbatimModuleSyntax` (use `import type` for type-only imports). Optional fields use the omit-when-absent spread pattern.
- DSP conventions (must match the offline layer and the Python engine exactly): azimuth **0° = +Y, clockwise**; off-nadir **0° = straight down**, 90° = horizontal; unit vector `[sinN·sin(az), sinN·cos(az), −cos(nadir)]`; `SOUND_SPEED_MPS = 343`. Steering delay sign: **delay the early-arriving capsule** so channels align on the farthest (`delay_m = (proj_m − min_k proj_k)/c·fs`). The opposite sign steers to the mirror azimuth — a known regression.
- Capture device is selected **by NAME**, never a hardcoded index (indices re-enumerate per process/host-API).
- Commands run from the repo root `c:\Work\conferencing-audio-pipeline`. Tests: `npx vitest run <file>`. Full gate: `npm run typecheck && npm test && npm run build`.

---

## File Structure

- `src/live/beam.ts` — **create**. `fracDelayKernel`, `steerRealDelays`, `directionUnit`, `StreamingDelaySumBeam` (the streaming beamformer; per-channel ring + FIR tail held internally — the spec's "ring-buffer" is folded in here).
- `src/live/meter.ts` — **create**. `LevelMeter` (RMS / peak-hold / clip).
- `src/live/types.ts` — **create**. `CaptureDevice`, `CaptureAdapter`, `LiveConfig`, `BeamOutput`.
- `src/live/mock-adapter.ts` — **create**. `planeWaveChannels` (synthetic generator) + `MockCaptureAdapter`.
- `src/live/engine.ts` — **create**. `LiveEngine` (capture → beam → meter → `BeamOutput`).
- `src/live/index.ts` — **create**. The `./live` subpath barrel.
- `src/live-node/naudiodon-adapter.ts` — **create**. `NodeCaptureAdapter` (lazy `naudiodon2`, enumerate by name).
- `src/live-node/output-sink.ts` — **create**. `NodeOutputSink` (lazy `naudiodon2` output stream).
- `src/live-node/index.ts` — **create**. The `./live-node` subpath barrel.
- `package.json` — **modify**. Add `./live` and `./live-node` to `exports`; add optional `peerDependencies`.
- `README.md`, `CHANGELOG.md`, `CLAUDE.md` — **modify**. Document the live layer.
- Tests: `test/live-beam.test.ts`, `test/live-meter.test.ts`, `test/live-engine.test.ts`, `test/live-node-adapter.test.ts`.

---

### Task 1: Fractional-delay kernel + steering delays + direction unit

**Files:**
- Create: `src/live/beam.ts`
- Test: `test/live-beam.test.ts`

**Interfaces:**
- Consumes: `ArrayGeometry`, `SOUND_SPEED_MPS` from `../beamformer/geometry.js`.
- Produces:
  - `directionUnit(azimuthDeg: number, offNadirDeg: number): [number, number, number]`
  - `fracDelayKernel(frac: number, taps?: number): Float64Array`
  - `steerRealDelays(geom: ArrayGeometry, azimuthDeg: number, offNadirDeg: number, sampleRate: number, speedOfSound?: number): { idx: number[]; delays: number[] }`

- [ ] **Step 1: Write the failing test**

```ts
// test/live-beam.test.ts
import { describe, it, expect } from 'vitest';
import { directionUnit, fracDelayKernel, steerRealDelays } from '../src/live/beam.js';
import { sensibel8, SOUND_SPEED_MPS } from '../src/beamformer/geometry.js';

describe('directionUnit', () => {
  it('matches the canonical az/off-nadir convention', () => {
    // off-nadir 90 (horizontal), az 0 → +Y; az 90 → +X
    const north = directionUnit(0, 90);
    expect(north[0]).toBeCloseTo(0, 9);
    expect(north[1]).toBeCloseTo(1, 9);
    expect(north[2]).toBeCloseTo(0, 9);
    const east = directionUnit(90, 90);
    expect(east[0]).toBeCloseTo(1, 9);
    expect(east[1]).toBeCloseTo(0, 9);
    // straight down (off-nadir 0) → -z
    expect(directionUnit(0, 0)[2]).toBeCloseTo(-1, 9);
  });
});

describe('fracDelayKernel', () => {
  it('is a unit impulse at center when frac is 0', () => {
    const k = fracDelayKernel(0, 15);
    expect(k.length).toBe(15);
    expect(k[7]).toBeCloseTo(1, 9); // center = (15-1)/2 = 7
    for (let i = 0; i < 15; i++) if (i !== 7) expect(k[i]!).toBeCloseTo(0, 9);
  });

  it('forces odd length, floor 5, and unity DC gain', () => {
    const k = fracDelayKernel(0.5, 4); // 4 -> max(5, 4|1=5) = 5
    expect(k.length).toBe(5);
    let sum = 0;
    for (const v of k) sum += v;
    expect(sum).toBeCloseTo(1, 9);
  });
});

describe('steerRealDelays', () => {
  it('returns non-negative delays with a zero minimum, over active capsules', () => {
    const geom = sensibel8(0.04);
    const { idx, delays } = steerRealDelays(geom, 0, 90, 44100, SOUND_SPEED_MPS);
    expect(idx).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(Math.min(...delays)).toBeCloseTo(0, 9);
    for (const d of delays) expect(d).toBeGreaterThanOrEqual(0);
  });

  it('steers to the mirror azimuth with opposite ordering (sign check)', () => {
    // A source due north (az 0) should delay the +Y capsule most and the -Y capsule least.
    const geom = sensibel8(0.04); // capsule 0 at bearing 0 = (r,0,0)? circularArray uses cos/sin(ang)
    const { idx, delays } = steerRealDelays(geom, 0, 90, 44100, SOUND_SPEED_MPS);
    // capsule with the largest +Y position should have the largest delay
    let maxYIdx = idx[0]!;
    let maxY = -Infinity;
    for (const m of idx) if (geom.elements[m]![1] > maxY) { maxY = geom.elements[m]![1]; maxYIdx = m; }
    const maxYDelay = delays[idx.indexOf(maxYIdx)]!;
    expect(maxYDelay).toBeCloseTo(Math.max(...delays), 9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-beam.test.ts`
Expected: FAIL — `Failed to resolve import "../src/live/beam.js"` (module/functions not defined).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/live/beam.ts
/**
 * Live, real-time beamforming for the TS pipeline — fractional-delay-and-sum.
 *
 * The OFFLINE `src/beamformer` produces narrowband complex weights at one design
 * frequency; those cannot be applied to broadband time-domain audio. The live
 * path instead aligns capsules by their geometric arrival delay and sums — a
 * frequency-invariant operation. Faithful port of the Python engine's
 * `_FracDelaySumBeam` (`conf_pipeline_control/polaris_beamformer.py`).
 */
import { ArrayGeometry, SOUND_SPEED_MPS } from '../beamformer/geometry.js';

export const DEFAULT_FRACDELAY_TAPS = 15;

/** Steering unit vector from azimuth/off-nadir (0°=+Y CW; off-nadir 0°=straight down). */
export function directionUnit(azimuthDeg: number, offNadirDeg: number): [number, number, number] {
  const az = (azimuthDeg * Math.PI) / 180;
  const nadir = (offNadirDeg * Math.PI) / 180;
  const sinN = Math.sin(nadir);
  return [sinN * Math.sin(az), sinN * Math.cos(az), -Math.cos(nadir)];
}

/** `sinc(x) = sin(πx)/(πx)`, with `sinc(0) = 1` (NumPy's normalized sinc). */
function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/**
 * Hann-windowed-sinc fractional-delay FIR — delays by `(taps-1)/2 + frac` samples.
 * `taps` is forced odd and floored at 5; normalized to unity DC. `frac==0` → unit
 * impulse at center. Port of `_frac_delay_kernel`.
 */
export function fracDelayKernel(frac: number, taps: number = DEFAULT_FRACDELAY_TAPS): Float64Array {
  const L = Math.max(5, Math.trunc(taps) | 1);
  const center = (L - 1) / 2;
  const k = new Float64Array(L);
  let sum = 0;
  for (let n = 0; n < L; n++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (L - 1));
    const v = sinc(n - center - frac) * hann;
    k[n] = v;
    sum += v;
  }
  for (let n = 0; n < L; n++) k[n]! /= sum;
  return k;
}

/**
 * Per-active-capsule steer delays in samples (≥ 0), aligning a plane wave from
 * `(azimuthDeg, offNadirDeg)`. Port of `_steer_real_delays`.
 */
export function steerRealDelays(
  geom: ArrayGeometry,
  azimuthDeg: number,
  offNadirDeg: number,
  sampleRate: number,
  speedOfSound: number = SOUND_SPEED_MPS,
): { idx: number[]; delays: number[] } {
  const [ux, uy, uz] = directionUnit(azimuthDeg, offNadirDeg);
  const idx = geom.activeIndices();
  const projs = idx.map((m) => {
    const e = geom.elements[m]!;
    return e[0] * ux + e[1] * uy + e[2] * uz;
  });
  const pmin = projs.length > 0 ? Math.min(...projs) : 0;
  const delays = projs.map((p) => ((p - pmin) / speedOfSound) * sampleRate);
  return { idx, delays };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/live-beam.test.ts`
Expected: PASS (3 describe blocks, 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/live/beam.ts test/live-beam.test.ts
git commit -m "feat(live): fractional-delay kernel + steering-delay math"
```

---

### Task 2: Streaming fractional-delay-and-sum beam

**Files:**
- Modify: `src/live/beam.ts` (append the `StreamingDelaySumBeam` class + a `convolveValid` helper)
- Test: `test/live-beam.test.ts` (append)

**Interfaces:**
- Consumes: `steerRealDelays`, `fracDelayKernel`, `DEFAULT_FRACDELAY_TAPS` (Task 1).
- Produces:
  - `class StreamingDelaySumBeam` with constructor `(geom: ArrayGeometry, sampleRate: number, opts?: { speedOfSound?: number; taps?: number })`, methods `setLook(azimuthDeg: number, offNadirDeg?: number): void`, `process(channels: Float32Array[]): Float32Array` (mono, length = input block length), `reset(): void`.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-beam.test.ts (append)
import { StreamingDelaySumBeam } from '../src/live/beam.js';

/** Build M channels carrying a sinusoid arriving as a plane wave from `(az, off)`. */
function planeWave(
  geom: ReturnType<typeof sensibel8>,
  azimuthDeg: number,
  offNadirDeg: number,
  freqHz: number,
  fs: number,
  n: number,
): Float32Array[] {
  const { idx, delays } = steerRealDelays(geom, azimuthDeg, offNadirDeg, fs, SOUND_SPEED_MPS);
  // arrival_m = (max delay - delay_m): capsule nearest source (max delay) arrives first.
  const maxD = Math.max(...delays);
  const channels: Float32Array[] = Array.from({ length: geom.nChannels }, () => new Float32Array(n));
  idx.forEach((m, k) => {
    const arrival = maxD - delays[k]!;
    const ch = channels[m]!;
    for (let i = 0; i < n; i++) ch[i] = Math.sin((2 * Math.PI * freqHz * (i - arrival)) / fs);
  });
  return channels;
}

function rms(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
}

describe('StreamingDelaySumBeam', () => {
  it('reinforces a source it is steered at and attenuates one it is steered away from', () => {
    const fs = 44100, n = 4096, geom = sensibel8(0.04);
    const channels = planeWave(geom, 0, 90, 1500, fs, n); // source due north
    const beam = new StreamingDelaySumBeam(geom, fs);

    beam.setLook(0, 90); // steer at the source
    const aligned = beam.process(channels);

    beam.reset();
    beam.setLook(180, 90); // steer at the opposite bearing
    const away = beam.process(channels);

    // skip the kernel/ring warm-up region when measuring energy
    const tail = (x: Float32Array) => x.subarray(64);
    expect(rms(tail(aligned))).toBeGreaterThan(rms(tail(away)) * 1.5);
  });

  it('is sample-exact across block boundaries (streaming == whole)', () => {
    const fs = 44100, n = 2048, geom = sensibel8(0.04);
    const channels = planeWave(geom, 45, 90, 1000, fs, n);

    const whole = new StreamingDelaySumBeam(geom, fs);
    whole.setLook(45, 90);
    const a = whole.process(channels);

    const split = new StreamingDelaySumBeam(geom, fs);
    split.setLook(45, 90);
    const half = n / 2;
    const b1 = split.process(channels.map((c) => c.subarray(0, half)));
    const b2 = split.process(channels.map((c) => c.subarray(half)));

    for (let i = 0; i < half; i++) expect(b1[i]!).toBeCloseTo(a[i]!, 6);
    for (let i = 0; i < half; i++) expect(b2[i]!).toBeCloseTo(a[half + i]!, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-beam.test.ts`
Expected: FAIL — `StreamingDelaySumBeam is not a constructor` / import unresolved.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/live/beam.ts (append)

/** NumPy `convolve(a, k, 'valid')`: out[i] = Σ_t a[i+t]·k[L-1-t], length = a.length-L+1. */
function convolveValid(a: Float64Array, k: Float64Array): Float64Array {
  const L = k.length;
  const out = new Float64Array(a.length - L + 1);
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let t = 0; t < L; t++) s += a[i + t]! * k[L - 1 - t]!;
    out[i] = s;
  }
  return out;
}

/**
 * Streaming delay-and-sum with sub-sample (fractional) steer delays. Each active
 * capsule's real delay splits into an integer part (read from a per-channel
 * history ring) + a fractional remainder (a Hann-sinc FIR), continuous across
 * block boundaries via a per-channel FIR tail. Port of `_FracDelaySumBeam`.
 */
export class StreamingDelaySumBeam {
  private readonly geom: ArrayGeometry;
  private readonly fs: number;
  private readonly c: number;
  private readonly L: number; // FIR length (odd, ≥5)
  private idx: number[] = [];
  private delaysInt: number[] = [];
  private kernels: Float64Array[] = [];
  private maxd = 0;
  private hist: Float64Array[] = []; // per active capsule, length maxd
  private tail: Float64Array[] = []; // per active capsule, length L-1

  constructor(
    geom: ArrayGeometry,
    sampleRate: number,
    opts: { speedOfSound?: number; taps?: number } = {},
  ) {
    this.geom = geom;
    this.fs = sampleRate;
    this.c = opts.speedOfSound ?? SOUND_SPEED_MPS;
    this.L = Math.max(5, Math.trunc(opts.taps ?? DEFAULT_FRACDELAY_TAPS) | 1);
    this.setLook(0, 90);
  }

  /** Re-aim the beam. Recomputes integer delays + fractional FIRs and resets history. */
  setLook(azimuthDeg: number, offNadirDeg = 90): void {
    const { idx, delays } = steerRealDelays(this.geom, azimuthDeg, offNadirDeg, this.fs, this.c);
    const di = delays.map((d) => Math.floor(d));
    const fr = delays.map((d, i) => d - di[i]!);
    this.idx = idx;
    this.delaysInt = di;
    this.kernels = fr.map((f) => fracDelayKernel(f, this.L));
    this.maxd = di.length > 0 ? Math.max(...di) : 0;
    this.reset();
  }

  /** Drop all history (call on mode/look change to avoid stale samples). */
  reset(): void {
    const L1 = this.L - 1;
    this.hist = this.idx.map(() => new Float64Array(this.maxd));
    this.tail = this.idx.map(() => new Float64Array(L1));
  }

  /** One block in (per-channel Float32Arrays, length n), mono out (length n). */
  process(channels: Float32Array[]): Float32Array {
    const n = channels.length > 0 ? (channels[this.idx[0] ?? 0]?.length ?? 0) : 0;
    const D = this.maxd;
    const L1 = this.L - 1;
    const out = new Float64Array(n);
    for (let k = 0; k < this.idx.length; k++) {
      const m = this.idx[k]!;
      const d = this.delaysInt[k]!;
      const ker = this.kernels[k]!;
      const histM = this.hist[k]!;
      const ch = channels[m]!;
      // ext = [hist (D) | block (n)]; aligned = ext[D-d : D-d+n]
      const start = D - d;
      const aligned = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const j = start + i;
        aligned[i] = j < D ? histM[j]! : ch[j - D]!;
      }
      // col = [tail (L1) | aligned (n)]; out += convolveValid(col, ker)
      const col = new Float64Array(L1 + n);
      col.set(this.tail[k]!, 0);
      col.set(aligned, L1);
      const conv = convolveValid(col, ker);
      for (let i = 0; i < n; i++) out[i]! += conv[i]!;
      // carry: new tail = last L1 samples of col; new hist = last D of ext
      this.tail[k] = col.slice(col.length - L1);
      if (D > 0) {
        const newHist = new Float64Array(D);
        for (let i = 0; i < D; i++) {
          const j = n - D + i; // index into block tail (when n >= D)
          newHist[i] = j >= 0 ? ch[j]! : histM[D + j]!;
        }
        this.hist[k] = newHist;
      }
    }
    const denom = Math.max(1, this.idx.length);
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = out[i]! / denom;
    return mono;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/live-beam.test.ts`
Expected: PASS (all beam tests, including the two new ones).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/live/beam.ts test/live-beam.test.ts
git commit -m "feat(live): streaming fractional-delay-and-sum beamformer"
```

---

### Task 3: Level meter

**Files:**
- Create: `src/live/meter.ts`
- Test: `test/live-meter.test.ts`

**Interfaces:**
- Produces: `class LevelMeter` — `update(block: Float32Array): void`; getters `rmsDb: number`, `peakDb: number`, `clipped: boolean`; `reset(): void`. dBFS scale; `peakDb` holds the peak with decay; `clipped` latches when |sample| ≥ 0.999 until `reset()`.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-meter.test.ts
import { describe, it, expect } from 'vitest';
import { LevelMeter } from '../src/live/meter.js';

describe('LevelMeter', () => {
  it('reports ~ -6 dBFS RMS for a 0.5-amplitude full-block signal', () => {
    const m = new LevelMeter();
    const x = new Float32Array(1024).fill(0.5);
    m.update(x);
    expect(m.rmsDb).toBeCloseTo(-6.0206, 2); // 20*log10(0.5)
    expect(m.peakDb).toBeCloseTo(-6.0206, 2);
    expect(m.clipped).toBe(false);
  });

  it('latches clip on a full-scale sample until reset', () => {
    const m = new LevelMeter();
    const x = new Float32Array(8);
    x[3] = 1.0;
    m.update(x);
    expect(m.clipped).toBe(true);
    m.update(new Float32Array(8)); // silence
    expect(m.clipped).toBe(true); // still latched
    m.reset();
    expect(m.clipped).toBe(false);
  });

  it('floors silence at a finite dB', () => {
    const m = new LevelMeter();
    m.update(new Float32Array(256));
    expect(Number.isFinite(m.rmsDb)).toBe(true);
    expect(m.rmsDb).toBeLessThanOrEqual(-120);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-meter.test.ts`
Expected: FAIL — import unresolved / `LevelMeter is not a constructor`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/live/meter.ts
/** Running level meter: RMS (dBFS), decaying peak-hold (dBFS), and a latching clip flag. */

const FLOOR_DB = -120;
const CLIP_THRESHOLD = 0.999;

function toDb(linear: number): number {
  if (linear <= 0) return FLOOR_DB;
  return Math.max(FLOOR_DB, 20 * Math.log10(linear));
}

export class LevelMeter {
  private _rmsDb = FLOOR_DB;
  private _peak = 0;
  private _clipped = false;
  /** Peak decay per block (≈ -1.5 dB), so the hold falls when the signal drops. */
  private readonly peakDecay = 0.84;

  update(block: Float32Array): void {
    let sumSq = 0;
    let blockPeak = 0;
    for (const v of block) {
      sumSq += v * v;
      const a = Math.abs(v);
      if (a > blockPeak) blockPeak = a;
      if (a >= CLIP_THRESHOLD) this._clipped = true;
    }
    this._rmsDb = toDb(block.length > 0 ? Math.sqrt(sumSq / block.length) : 0);
    this._peak = Math.max(blockPeak, this._peak * this.peakDecay);
  }

  get rmsDb(): number {
    return this._rmsDb;
  }
  get peakDb(): number {
    return toDb(this._peak);
  }
  get clipped(): boolean {
    return this._clipped;
  }

  reset(): void {
    this._rmsDb = FLOOR_DB;
    this._peak = 0;
    this._clipped = false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/live-meter.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/live/meter.ts test/live-meter.test.ts
git commit -m "feat(live): level meter (RMS / peak-hold / clip)"
```

---

### Task 4: Capture-adapter types + MockCaptureAdapter

**Files:**
- Create: `src/live/types.ts`
- Create: `src/live/mock-adapter.ts`
- Test: `test/live-engine.test.ts` (a `MockCaptureAdapter` test; the engine test extends this file in Task 5)

**Interfaces:**
- Produces (types.ts):
  - `interface CaptureDevice { id: string; name: string; maxInputChannels: number; defaultSampleRate: number }`
  - `interface CaptureStartOptions { deviceName: string; channels: number; sampleRate: number; onBlock: (channels: Float32Array[], sampleRate: number) => void }`
  - `interface CaptureAdapter { enumerate(): Promise<CaptureDevice[]>; start(opts: CaptureStartOptions): Promise<void>; stop(): Promise<void> }`
  - `interface BeamOutput { mono: Float32Array; rmsDb: number; peakDb: number; clipped: boolean; azimuthDeg: number; offNadirDeg: number }`
  - `interface LiveConfig { geom: ArrayGeometry; deviceName: string; sampleRate?: number; azimuthDeg?: number; offNadirDeg?: number; taps?: number }`
- Produces (mock-adapter.ts):
  - `planeWaveChannels(geom, azimuthDeg, offNadirDeg, freqHz, fs, n): Float32Array[]`
  - `class MockCaptureAdapter implements CaptureAdapter` — constructor `(opts: { deviceName?: string; channels: number; azimuthDeg?: number; offNadirDeg?: number; freqHz?: number; blockSize?: number; blocks?: number })`; on `start()` synchronously emits `blocks` plane-wave blocks via `onBlock` then resolves.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-engine.test.ts
import { describe, it, expect } from 'vitest';
import { MockCaptureAdapter } from '../src/live/mock-adapter.js';
import { StreamingDelaySumBeam } from '../src/live/beam.js';
import { sensibel8 } from '../src/beamformer/geometry.js';

function rms(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
}

describe('MockCaptureAdapter', () => {
  it('enumerates a named device and emits multichannel blocks of the right shape', async () => {
    const mock = new MockCaptureAdapter({ deviceName: 'MOCK-8', channels: 8, blocks: 3, blockSize: 256 });
    const devices = await mock.enumerate();
    expect(devices.some((d) => d.name === 'MOCK-8' && d.maxInputChannels === 8)).toBe(true);

    const seen: number[] = [];
    await mock.start({
      deviceName: 'MOCK-8',
      channels: 8,
      sampleRate: 44100,
      onBlock: (channels) => {
        seen.push(channels.length);
        expect(channels[0]!.length).toBe(256);
      },
    });
    expect(seen).toEqual([8, 8, 8]); // 3 blocks, 8 channels each
  });

  it('emits a plane wave a steered beam reinforces', async () => {
    const geom = sensibel8(0.04);
    const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 1, blockSize: 4096, freqHz: 1500 });
    const beam = new StreamingDelaySumBeam(geom, 44100);
    let aligned = new Float32Array(0);
    let away = new Float32Array(0);
    await mock.start({
      deviceName: 'MOCK-8', channels: 8, sampleRate: 44100,
      onBlock: (channels) => {
        beam.setLook(90, 90); aligned = beam.process(channels);
        beam.reset(); beam.setLook(270, 90); away = beam.process(channels);
      },
    });
    expect(rms(aligned.subarray(64))).toBeGreaterThan(rms(away.subarray(64)) * 1.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-engine.test.ts`
Expected: FAIL — import of `../src/live/mock-adapter.js` unresolved.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/live/types.ts
import type { ArrayGeometry } from '../beamformer/geometry.js';

/** A capture device discovered by an adapter (selected by NAME, never index). */
export interface CaptureDevice {
  id: string;
  name: string;
  maxInputChannels: number;
  defaultSampleRate: number;
}

/** Parameters for a capture session. `onBlock` receives de-interleaved channels. */
export interface CaptureStartOptions {
  deviceName: string;
  channels: number;
  sampleRate: number;
  onBlock: (channels: Float32Array[], sampleRate: number) => void;
}

/** A pluggable real-time multichannel capture backend. */
export interface CaptureAdapter {
  enumerate(): Promise<CaptureDevice[]>;
  start(opts: CaptureStartOptions): Promise<void>;
  stop(): Promise<void>;
}

/** One beamformed block + its meter readout and the look direction that produced it. */
export interface BeamOutput {
  mono: Float32Array;
  rmsDb: number;
  peakDb: number;
  clipped: boolean;
  azimuthDeg: number;
  offNadirDeg: number;
}

/** Engine configuration. */
export interface LiveConfig {
  geom: ArrayGeometry;
  deviceName: string;
  sampleRate?: number;
  azimuthDeg?: number;
  offNadirDeg?: number;
  taps?: number;
}
```

```ts
// src/live/mock-adapter.ts
/**
 * Hardware-free capture adapter: emits synthetic plane-wave blocks from a chosen
 * direction. The CI/test driver for the live core — implements the same
 * CaptureAdapter contract as the real Node adapter.
 */
import type { CaptureAdapter, CaptureDevice, CaptureStartOptions } from './types.js';
import { sensibel8, type ArrayGeometry } from '../beamformer/geometry.js';
import { steerRealDelays } from './beam.js';

/** M channels carrying a sinusoid arriving as a plane wave from `(az, off)`. */
export function planeWaveChannels(
  geom: ArrayGeometry,
  azimuthDeg: number,
  offNadirDeg: number,
  freqHz: number,
  fs: number,
  n: number,
): Float32Array[] {
  const { idx, delays } = steerRealDelays(geom, azimuthDeg, offNadirDeg, fs);
  const maxD = delays.length > 0 ? Math.max(...delays) : 0;
  const channels: Float32Array[] = Array.from({ length: geom.nChannels }, () => new Float32Array(n));
  idx.forEach((m, k) => {
    const arrival = maxD - delays[k]!;
    const ch = channels[m]!;
    for (let i = 0; i < n; i++) ch[i] = Math.sin((2 * Math.PI * freqHz * (i - arrival)) / fs);
  });
  return channels;
}

export class MockCaptureAdapter implements CaptureAdapter {
  private readonly deviceName: string;
  private readonly channels: number;
  private readonly geom: ArrayGeometry;
  private readonly azimuthDeg: number;
  private readonly offNadirDeg: number;
  private readonly freqHz: number;
  private readonly blockSize: number;
  private readonly blocks: number;
  private running = false;

  constructor(opts: {
    deviceName?: string;
    channels: number;
    azimuthDeg?: number;
    offNadirDeg?: number;
    freqHz?: number;
    blockSize?: number;
    blocks?: number;
  }) {
    this.deviceName = opts.deviceName ?? 'MOCK-8';
    this.channels = opts.channels;
    this.geom = sensibel8(0.04);
    this.azimuthDeg = opts.azimuthDeg ?? 0;
    this.offNadirDeg = opts.offNadirDeg ?? 90;
    this.freqHz = opts.freqHz ?? 1000;
    this.blockSize = opts.blockSize ?? 1410;
    this.blocks = opts.blocks ?? 1;
  }

  enumerate(): Promise<CaptureDevice[]> {
    return Promise.resolve([
      { id: 'mock-0', name: this.deviceName, maxInputChannels: this.channels, defaultSampleRate: 44100 },
    ]);
  }

  start(opts: CaptureStartOptions): Promise<void> {
    this.running = true;
    for (let b = 0; b < this.blocks && this.running; b++) {
      const block = planeWaveChannels(
        this.geom, this.azimuthDeg, this.offNadirDeg, this.freqHz, opts.sampleRate, this.blockSize,
      );
      opts.onBlock(block, opts.sampleRate);
    }
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.running = false;
    return Promise.resolve();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/live-engine.test.ts`
Expected: PASS (2 MockCaptureAdapter tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/live/types.ts src/live/mock-adapter.ts test/live-engine.test.ts
git commit -m "feat(live): CaptureAdapter types + MockCaptureAdapter (synthetic plane wave)"
```

---

### Task 5: LiveEngine

**Files:**
- Create: `src/live/engine.ts`
- Test: `test/live-engine.test.ts` (append)

**Interfaces:**
- Consumes: `StreamingDelaySumBeam` (Task 2), `LevelMeter` (Task 3), `CaptureAdapter`/`LiveConfig`/`BeamOutput` (Task 4).
- Produces:
  - `class LiveEngine` — constructor `(adapter: CaptureAdapter, config: LiveConfig)`; `onOutput(cb: (out: BeamOutput) => void): void`; `setLook(azimuthDeg: number, offNadirDeg?: number): void`; `start(): Promise<void>`; `stop(): Promise<void>`; getter `azimuthDeg`/`offNadirDeg`.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-engine.test.ts (append)
import { LiveEngine } from '../src/live/engine.js';

describe('LiveEngine', () => {
  it('produces BeamOutput per block, reinforcing the steered direction', async () => {
    const geom = sensibel8(0.04);
    const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 1, blockSize: 4096, freqHz: 1500 });
    const engine = new LiveEngine(mock, { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90 });
    const outs: number[] = [];
    let mono = new Float32Array(0);
    engine.onOutput((o) => { outs.push(o.rmsDb); mono = o.mono; expect(o.azimuthDeg).toBe(90); });
    await engine.start();
    expect(outs.length).toBe(1);
    expect(rms(mono.subarray(64))).toBeGreaterThan(0.3); // coherent sum of a unit sinusoid
  });

  it('re-steers via setLook without mutating prior output', async () => {
    const geom = sensibel8(0.04);
    const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 1, blockSize: 4096, freqHz: 1500 });
    const engine = new LiveEngine(mock, { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 270 });
    let r = 1;
    engine.onOutput((o) => { r = rms(o.mono.subarray(64)); });
    await engine.start(); // steered away (270) → low
    expect(engine.azimuthDeg).toBe(270);
    const low = r;
    engine.setLook(90);
    await engine.start(); // now steered at the source → high
    expect(r).toBeGreaterThan(low * 1.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-engine.test.ts`
Expected: FAIL — import of `../src/live/engine.js` unresolved.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/live/engine.ts
/**
 * Wires a CaptureAdapter to the live beamformer + meter, emitting a BeamOutput
 * per captured block. Pure orchestration (no node:* / no audio I/O of its own).
 */
import type { CaptureAdapter, LiveConfig, BeamOutput } from './types.js';
import { StreamingDelaySumBeam } from './beam.js';
import { LevelMeter } from './meter.js';

export class LiveEngine {
  private readonly adapter: CaptureAdapter;
  private readonly config: LiveConfig;
  private readonly beam: StreamingDelaySumBeam;
  private readonly meter = new LevelMeter();
  private _azimuthDeg: number;
  private _offNadirDeg: number;
  private cb: ((out: BeamOutput) => void) | null = null;

  constructor(adapter: CaptureAdapter, config: LiveConfig) {
    this.adapter = adapter;
    this.config = config;
    this._azimuthDeg = config.azimuthDeg ?? 0;
    this._offNadirDeg = config.offNadirDeg ?? 90;
    this.beam = new StreamingDelaySumBeam(config.geom, config.sampleRate ?? 44100, {
      ...(config.taps !== undefined ? { taps: config.taps } : {}),
    });
    this.beam.setLook(this._azimuthDeg, this._offNadirDeg);
  }

  get azimuthDeg(): number {
    return this._azimuthDeg;
  }
  get offNadirDeg(): number {
    return this._offNadirDeg;
  }

  onOutput(cb: (out: BeamOutput) => void): void {
    this.cb = cb;
  }

  /** Re-aim the beam (drops beam history to avoid stale samples). */
  setLook(azimuthDeg: number, offNadirDeg = 90): void {
    this._azimuthDeg = azimuthDeg;
    this._offNadirDeg = offNadirDeg;
    this.beam.setLook(azimuthDeg, offNadirDeg);
  }

  start(): Promise<void> {
    return this.adapter.start({
      deviceName: this.config.deviceName,
      channels: this.config.geom.nChannels,
      sampleRate: this.config.sampleRate ?? 44100,
      onBlock: (channels) => {
        const mono = this.beam.process(channels);
        this.meter.update(mono);
        this.cb?.({
          mono,
          rmsDb: this.meter.rmsDb,
          peakDb: this.meter.peakDb,
          clipped: this.meter.clipped,
          azimuthDeg: this._azimuthDeg,
          offNadirDeg: this._offNadirDeg,
        });
      },
    });
  }

  stop(): Promise<void> {
    return this.adapter.stop();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/live-engine.test.ts`
Expected: PASS (all four tests in the file).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/live/engine.ts test/live-engine.test.ts
git commit -m "feat(live): LiveEngine (capture -> beam -> meter -> BeamOutput)"
```

---

### Task 6: `./live` barrel + package export

**Files:**
- Create: `src/live/index.ts`
- Modify: `package.json` (add `./live` to `exports`)
- Test: `test/live-engine.test.ts` (append a barrel import smoke test)

**Interfaces:**
- Produces: a single import surface — `import { LiveEngine, MockCaptureAdapter, StreamingDelaySumBeam, LevelMeter, directionUnit } from 'conferencing-audio-pipeline/live'` (and the types).

- [ ] **Step 1: Write the failing test**

```ts
// test/live-engine.test.ts (append)
import * as live from '../src/live/index.js';

describe('live barrel', () => {
  it('exports the public surface', () => {
    expect(typeof live.LiveEngine).toBe('function');
    expect(typeof live.MockCaptureAdapter).toBe('function');
    expect(typeof live.StreamingDelaySumBeam).toBe('function');
    expect(typeof live.LevelMeter).toBe('function');
    expect(typeof live.directionUnit).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-engine.test.ts`
Expected: FAIL — import of `../src/live/index.js` unresolved.

- [ ] **Step 3: Write the barrel + add the export**

```ts
// src/live/index.ts
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
```

In `package.json`, add `./live` to `exports` (after the `.` entry, before `./node`):

```jsonc
    "./live": {
      "types": "./dist/live/index.d.ts",
      "import": "./dist/live/index.js"
    },
```

- [ ] **Step 4: Run test + typecheck + build**

Run: `npx vitest run test/live-engine.test.ts && npm run typecheck && npm run build`
Expected: tests PASS; `tsc` clean; `dist/live/index.js` emitted.

- [ ] **Step 5: Commit**

```bash
git add src/live/index.ts package.json test/live-engine.test.ts
git commit -m "feat(live): ./live subpath barrel + package export"
```

---

### Task 7: Node-native adapter + output sink (`./live-node`)

**Files:**
- Create: `src/live-node/naudiodon-adapter.ts`
- Create: `src/live-node/output-sink.ts`
- Create: `src/live-node/index.ts`
- Modify: `package.json` (add `./live-node` export + optional `peerDependencies`)
- Test: `test/live-node-adapter.test.ts`

**Interfaces:**
- Consumes: `CaptureAdapter`/`CaptureDevice`/`CaptureStartOptions` from `../live/types.js`.
- Produces:
  - `class NodeCaptureAdapter implements CaptureAdapter` — constructor `(opts?: { naudiodon?: unknown })` (the `naudiodon` injection seam is for tests; production lazy-imports `naudiodon2`). `enumerate()` lists input devices by name; `start()` opens an input stream on the device whose name **contains** `opts.deviceName`, de-interleaves Int16/Float32 frames to per-channel `Float32Array`, and calls `onBlock`. Throws a clear install hint if `naudiodon2` is absent.
  - `class NodeOutputSink` — `constructor(opts?: { naudiodon?: unknown })`; `start(sampleRate: number): Promise<void>`; `write(mono: Float32Array): void`; `stop(): Promise<void>`.

> Real-device behaviour is **not** run in CI. The DSP-free logic (enumerate-by-name match, missing-addon install hint, interleave→de-interleave) IS unit-tested by injecting a fake `naudiodon` object. A skipped `LIVE_DEVICE_TEST` placeholder documents the manual on-hardware check.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-node-adapter.test.ts
import { describe, it, expect } from 'vitest';
import { NodeCaptureAdapter } from '../src/live-node/naudiodon-adapter.js';

/** A minimal fake of the naudiodon2 surface the adapter uses. */
function fakeNaudiodon(emit?: (push: (buf: Buffer) => void) => void) {
  return {
    getDevices: () => [
      { id: 0, name: 'Some Other Device', maxInputChannels: 2, defaultSampleRate: 48000 },
      { id: 7, name: 'Digital Audio Interface (SB-POLARIS)', maxInputChannels: 8, defaultSampleRate: 44100 },
    ],
    AudioIO: class {
      private cb: ((buf: Buffer) => void) | null = null;
      constructor(public cfg: unknown) {}
      on(_event: string, cb: (buf: Buffer) => void) { this.cb = cb; }
      start() { if (emit && this.cb) emit(this.cb); }
      quit(_m: string, done: () => void) { done(); }
    },
    SampleFormat16Bit: 16,
  };
}

describe('NodeCaptureAdapter', () => {
  it('enumerates devices by name', async () => {
    const a = new NodeCaptureAdapter({ naudiodon: fakeNaudiodon() });
    const devices = await a.enumerate();
    expect(devices.find((d) => d.name.includes('SB-POLARIS'))?.maxInputChannels).toBe(8);
  });

  it('selects the device by name substring and de-interleaves frames', async () => {
    // One frame of 8 ch, value = channel index (int16), little-endian.
    const emit = (push: (b: Buffer) => void) => {
      const frames = 4, ch = 8;
      const buf = Buffer.alloc(frames * ch * 2);
      for (let f = 0; f < frames; f++) for (let c = 0; c < ch; c++) buf.writeInt16LE(c * 1000, (f * ch + c) * 2);
      push(buf);
    };
    const a = new NodeCaptureAdapter({ naudiodon: fakeNaudiodon(emit) });
    let got: Float32Array[] = [];
    await a.start({
      deviceName: 'SB-POLARIS', channels: 8, sampleRate: 44100,
      onBlock: (channels) => { got = channels; },
    });
    expect(got.length).toBe(8);
    expect(got[0]!.length).toBe(4);
    // channel 3 carried 3000/32768; channel 0 carried 0
    expect(got[3]![0]!).toBeCloseTo(3000 / 32768, 4);
    expect(got[0]![0]!).toBeCloseTo(0, 6);
  });

  it('throws a clear install hint when naudiodon2 is missing', async () => {
    const a = new NodeCaptureAdapter({ naudiodon: null });
    await expect(a.enumerate()).rejects.toThrow(/naudiodon2/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-node-adapter.test.ts`
Expected: FAIL — import of `../src/live-node/naudiodon-adapter.js` unresolved.

- [ ] **Step 3: Write the adapter, sink, and barrel**

```ts
// src/live-node/naudiodon-adapter.ts
/**
 * Node-only capture backend for the real array (PortAudio via the optional native
 * addon `naudiodon2`). Lazy-imported so the package keeps zero hard runtime deps;
 * if the addon is absent, methods throw a clear install hint. Device is selected
 * by NAME (indices re-enumerate per process).
 */
import type { CaptureAdapter, CaptureDevice, CaptureStartOptions } from '../live/types.js';

interface NaudiodonLike {
  getDevices(): Array<{ id: number; name: string; maxInputChannels: number; defaultSampleRate: number }>;
  AudioIO: new (cfg: unknown) => {
    on(event: 'data', cb: (buf: Buffer) => void): void;
    start(): void;
    quit(mode: string, done: () => void): void;
  };
  SampleFormat16Bit: number;
}

const INSTALL_HINT =
  'The Node live-capture backend needs the optional native addon "naudiodon2". ' +
  'Install it (and a C++ toolchain) with:  npm install naudiodon2';

export class NodeCaptureAdapter implements CaptureAdapter {
  private readonly injected: NaudiodonLike | null | undefined;
  private io: { quit(mode: string, done: () => void): void } | null = null;

  constructor(opts: { naudiodon?: unknown } = {}) {
    // `undefined` => lazy-load the real addon; `null`/object => test injection.
    this.injected = opts.naudiodon as NaudiodonLike | null | undefined;
  }

  private async load(): Promise<NaudiodonLike> {
    if (this.injected === null) throw new Error(INSTALL_HINT);
    if (this.injected !== undefined) return this.injected;
    try {
      const mod = (await import('naudiodon2')) as unknown as NaudiodonLike;
      return mod;
    } catch {
      throw new Error(INSTALL_HINT);
    }
  }

  async enumerate(): Promise<CaptureDevice[]> {
    const na = await this.load();
    return na.getDevices()
      .filter((d) => d.maxInputChannels > 0)
      .map((d) => ({ id: String(d.id), name: d.name, maxInputChannels: d.maxInputChannels, defaultSampleRate: d.defaultSampleRate }));
  }

  async start(opts: CaptureStartOptions): Promise<void> {
    const na = await this.load();
    const dev = na.getDevices().find((d) => d.maxInputChannels > 0 && d.name.includes(opts.deviceName));
    if (!dev) throw new Error(`No input device whose name contains ${JSON.stringify(opts.deviceName)}`);
    const io = new na.AudioIO({
      inOptions: {
        channelCount: opts.channels,
        sampleFormat: na.SampleFormat16Bit,
        sampleRate: opts.sampleRate,
        deviceId: dev.id,
        closeOnError: true,
      },
    });
    this.io = io;
    io.on('data', (buf: Buffer) => {
      const ch = opts.channels;
      const frames = Math.floor(buf.length / 2 / ch);
      const channels: Float32Array[] = Array.from({ length: ch }, () => new Float32Array(frames));
      for (let f = 0; f < frames; f++) {
        for (let c = 0; c < ch; c++) {
          channels[c]![f] = buf.readInt16LE((f * ch + c) * 2) / 32768;
        }
      }
      opts.onBlock(channels, opts.sampleRate);
    });
    io.start();
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.io) return resolve();
      this.io.quit('flush', () => { this.io = null; resolve(); });
    });
  }
}
```

```ts
// src/live-node/output-sink.ts
/** Minimal Node output: play a mono Float32 stream on the default device (naudiodon2). */
interface NaudiodonOut {
  AudioIO: new (cfg: unknown) => { write(buf: Buffer): void; quit(mode: string, done: () => void): void };
  SampleFormat16Bit: number;
}

const INSTALL_HINT = 'Live playback needs the optional native addon "naudiodon2":  npm install naudiodon2';

export class NodeOutputSink {
  private readonly injected: NaudiodonOut | null | undefined;
  private io: { write(buf: Buffer): void; quit(m: string, d: () => void): void } | null = null;

  constructor(opts: { naudiodon?: unknown } = {}) {
    this.injected = opts.naudiodon as NaudiodonOut | null | undefined;
  }

  private async load(): Promise<NaudiodonOut> {
    if (this.injected === null) throw new Error(INSTALL_HINT);
    if (this.injected !== undefined) return this.injected;
    try {
      return (await import('naudiodon2')) as unknown as NaudiodonOut;
    } catch {
      throw new Error(INSTALL_HINT);
    }
  }

  async start(sampleRate: number): Promise<void> {
    const na = await this.load();
    this.io = new na.AudioIO({
      outOptions: { channelCount: 1, sampleFormat: na.SampleFormat16Bit, sampleRate, closeOnError: true },
    });
  }

  write(mono: Float32Array): void {
    if (!this.io) return;
    const buf = Buffer.alloc(mono.length * 2);
    for (let i = 0; i < mono.length; i++) {
      const v = Math.max(-1, Math.min(1, mono[i]!));
      buf.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    this.io.write(buf);
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.io) return resolve();
      this.io.quit('flush', () => { this.io = null; resolve(); });
    });
  }
}
```

```ts
// src/live-node/index.ts
/** Node-only live-audio backends (PortAudio via the optional `naudiodon2` addon). */
export { NodeCaptureAdapter } from './naudiodon-adapter.js';
export { NodeOutputSink } from './output-sink.js';
```

In `package.json`, add the `./live-node` export (after `./live`) and an optional peer dep:

```jsonc
    "./live-node": {
      "types": "./dist/live-node/index.d.ts",
      "import": "./dist/live-node/index.js"
    },
```
```jsonc
  "peerDependencies": {
    "naudiodon2": "^2.5.0"
  },
  "peerDependenciesMeta": {
    "naudiodon2": { "optional": true }
  },
```

- [ ] **Step 4: Run test + typecheck + build**

Run: `npx vitest run test/live-node-adapter.test.ts && npm run typecheck && npm run build`
Expected: tests PASS (3); `tsc` clean; `dist/live-node/index.js` emitted. (`naudiodon2` is NOT installed; the real import path is never hit in tests because the fake is injected.)

- [ ] **Step 5: Commit**

```bash
git add src/live-node/ package.json test/live-node-adapter.test.ts
git commit -m "feat(live-node): Node-native POLARIS capture adapter + output sink (naudiodon2, lazy/optional)"
```

---

### Task 8: Docs (README + CHANGELOG + CLAUDE.md) + final gate

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: Add a README "Live audio (Node)" section**

Insert after the "Room-aware seat mapping" section:

```markdown
## Live audio (Phase 1, Node)

A real-time **fractional-delay-and-sum** beamformer over a pluggable capture adapter. The core
(`conferencing-audio-pipeline/live`) is pure, zero-dependency, and browser-safe; the real 8-capsule
POLARIS capture path is a **Node-only** backend (`conferencing-audio-pipeline/live-node`) built on the
optional native addon `naudiodon2`.

```ts
import { LiveEngine } from 'conferencing-audio-pipeline/live';
import { NodeCaptureAdapter, NodeOutputSink } from 'conferencing-audio-pipeline/live-node';
import { sensibel8 } from 'conferencing-audio-pipeline'; // beamformer.sensibel8

const geom = sensibel8(0.04);                    // your array's real radius (m)
const engine = new LiveEngine(new NodeCaptureAdapter(), {
  geom, deviceName: 'SB-POLARIS', sampleRate: 44100, azimuthDeg: 0,
});
const sink = new NodeOutputSink();
await sink.start(44100);
engine.onOutput((o) => sink.write(o.mono));      // hear the steered beam; o.rmsDb / o.clipped for metering
await engine.start();
```

> The browser cannot capture 8 discrete USB channels (`getUserMedia` downmixes to stereo), so the
> live 8-channel path is Node-only. A browser/Web-Audio adapter, live DOA/auto-steer, and the cleaning
> chain are deferred to later phases. `naudiodon2` is an **optional peer dependency** — install it
> (with a C++ toolchain) only to use `./live-node`.
```

- [ ] **Step 2: Add CHANGELOG `[Unreleased]` entries**

Under `### Added`:

```markdown
- **Live audio (Phase 1, Node)** — a real-time fractional-delay-and-sum beamformer. A pure,
  zero-dependency, browser-safe core (`./live`: `LiveEngine`, `StreamingDelaySumBeam`, `LevelMeter`,
  `MockCaptureAdapter`, `CaptureAdapter`) plus a Node-only POLARIS capture adapter + output sink
  (`./live-node`, optional `naudiodon2` peer dep, lazy-imported). The offline narrowband weights can't
  be applied to broadband audio, so the live path aligns capsules by geometric delay and sums (ported
  from the Python engine's `_FracDelaySumBeam`). The browser can't capture 8 discrete USB channels, so
  the live path is Node-only; DOA/steering and the cleaning chain are later phases. Zero hard runtime
  deps unchanged.
```

- [ ] **Step 3: Add a CLAUDE.md note**

Append to the architecture bullets in `CLAUDE.md`:

```markdown
- **Live audio (`src/live/` + `src/live-node/`, Phase 1).** A real-time fractional-delay-and-sum
  beamformer. `src/live/` is pure/zero-dep/browser-safe (exposed as `./live`); `src/live-node/` is
  Node-only (`./live-node`) and lazy-imports the optional `naudiodon2` addon — `dependencies` stays
  `{}`. The offline `src/beamformer` narrowband weights are NOT used live (wrong for broadband);
  the live beam aligns capsules by geometric delay. Browser 8-ch capture is infeasible (getUserMedia
  downmixes to stereo) — the live path is Node-only. Tests are hardware-free via `MockCaptureAdapter`.
```

- [ ] **Step 4: Final gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: `tsc` clean; **all** tests pass (existing + the new live tests); build emits `dist/live/` and `dist/live-node/`.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md CLAUDE.md
git commit -m "docs: document the Phase 1 live audio layer"
```

---

## Self-Review

**Spec coverage:**
- Pluggable core (interface + ring + engine) → Tasks 4, 5 (ring folded into the streaming beam, Task 2).
- Fractional-delay-and-sum beamformer (steerRealDelays, fracDelayKernel, StreamingDelaySumBeam) → Tasks 1, 2.
- Level/peak/clip meter → Task 3.
- Node-native adapter (naudiodon2, by-name, lazy/optional) + output sink → Task 7.
- MockCaptureAdapter + hardware-free tests → Tasks 4, 5.
- Packaging/exports (`./live`, `./live-node`), zero-dep invariant (optional peer dep, lazy import) → Tasks 6, 7.
- Real-time safety (pre-allocated buffers, immutable look via setLook recompute, bit-exact passthrough not yet needed — no optional stages in Phase 1) → encoded in Task 2.
- Docs → Task 8.
- Out of scope (browser adapter, DOA/steering, cleaning chain) → correctly omitted.

**Placeholder scan:** none — every code/test step has complete code and exact commands.

**Type consistency:** `CaptureAdapter` (`enumerate`/`start`/`stop`), `CaptureStartOptions.onBlock(channels, sampleRate)`, `BeamOutput` fields, and `StreamingDelaySumBeam.{setLook,process,reset}` are used identically in Tasks 4–7 as defined in Tasks 1–4.

**Note for the implementer:** the energy-ratio assertions (`> 1.5×`) are deliberately loose — they prove the beam *steers* without pinning exact dB (a synthetic delay-steered signal isn't a true far-field plane wave). If Task 2's reinforcement test is flaky, widen the warm-up skip (`subarray(64)`), not the ratio.
