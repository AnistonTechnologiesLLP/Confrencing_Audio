# Live Audio — Phase 3b Implementation Plan (real-time dereverb)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in real-time dereverb stage to the live cleaning chain — single-channel Lebart/Habets late-reverb spectral subtraction — running before the Phase-3a denoiser.

**Architecture:** A new `StreamingDereverb` extends the Phase-3a `StreamingSpectralProcessor` (reuses its Hann 512/256 STFT, overlap-add, warmup, and bit-exact-off), overriding only the gain law with a late-reverb estimate (`R` = a one-pole, T60-decayed copy of a delayed power tap) and the spectral-subtraction gain `G = max(1 − β·R/P, Gmin)`. A tiny `ChainedCleaner` runs `[dereverb] → [denoiser]` in order; the engine builds the chain from `LiveConfig.cleaning.dereverb` + `.engine` (default off = byte-identical to Phase 3a).

**Tech Stack:** TypeScript (ESM, strict), vitest; reuses `src/live/spectral-processor.ts` (the `computeGain` hook, `protected` `gFloor`/`_gBuf`/`F`/`H`/`nb`), `omlsa.ts`, `level-preserving-cleaner.ts` (`Cleaner`).

## Global Constraints

- ESM-only; **every relative import carries a `.js` extension**.
- **Zero hard runtime dependencies** — `package.json` `dependencies` stays `{}`. Pure DSP.
- Everything under `src/live/` is **browser-safe**: NO `node:*`, no `Buffer`, no Node globals.
- Strict tsconfig: `noUncheckedIndexedAccess` (`!`/guards), `exactOptionalPropertyTypes` (optional fields via the **omit-when-absent spread** `...(x !== undefined ? { x } : {})`, never `{ x: undefined }`), `noUnusedLocals`/`noUnusedParameters` (unused override params get a `_` prefix), `verbatimModuleSyntax` (`import type`/inline `type`). NO `as` casts; annotate a `let` as the wide global `Float32Array` if a generic mismatch arises.
- **Float64** for all DSP math; convert to `Float32Array` only at the output boundary (the base already does this).
- **Bit-exact passthrough when off / during warmup** is inherited from the base (returns the SAME input object until engaged).
- **No hot-path allocation:** the dereverb pre-allocates `_R` and the `_phist` ring and writes the gain into the inherited `_gBuf`.
- **Constants (from `polaris_beamformer.py:145-148`):** `t60 = 0.5`, `beta = 1.6`, `gminDb = -10`, `earlyMs = 48`. `a = exp(−13.8155·H/(t60·fs))` (13.8155 = ln 10⁶); `d = max(1, round(earlyMs/1000·fs/H))`. Gain floor `gFloor = 10^(gminDb/20)` (amplitude — the base computes this from `floorDb`).
- **Default off = byte-identical to Phase 3a**, including the `BeamOutput.cleaning` shape: the new `dereverb?` field is **omit-when-absent** so existing 3a tests (which assert `{ engine, preserved }`) stay green.
- Commands from repo root `c:\Work\conferencing-audio-pipeline`. Single file: `npx vitest run <file>`. Full gate: `npm run typecheck && npm test && npm run build` (currently 444 tests / 44 files).

---

## File Structure

- `src/live/spectral-processor.ts` — **modify**. One-line: `private readonly gFloor` → `protected readonly gFloor`.
- `src/live/dereverb.ts` — **create**. `StreamingDereverb` (Lebart/Habets late-reverb gain law) + constants + `DereverbOptions`.
- `src/live/cleaner-chain.ts` — **create**. `ChainedCleaner` (ordered `Cleaner[]`).
- `src/live/types.ts` — **modify**. `CleaningConfig.engine` → optional; add `CleaningConfig.dereverb?`; add `BeamOutput.cleaning.dereverb?`.
- `src/live/engine.ts` — **modify**. Build the ordered chain from `cleaning`.
- `src/live/index.ts` — **modify**. Export the new surface.
- Tests: `test/live-dereverb.test.ts`, `test/live-cleaner-chain.test.ts`, extend `test/live-engine.test.ts`.

---

### Task 1: `StreamingDereverb` + expose `gFloor` (`dereverb.ts`, `spectral-processor.ts`)

**Files:**
- Modify: `src/live/spectral-processor.ts` (line 34: `gFloor` access)
- Create: `src/live/dereverb.ts`
- Test: `test/live-dereverb.test.ts`

**Interfaces:**
- Consumes: `StreamingSpectralProcessor` (Phase 3a) — `protected computeGain(power: Float64Array, noiseMag: Float64Array): Float64Array` hook (returns the RAW per-bin gain; the base `processHop` applies the shared 3-tap freq + one-pole temporal smoothing + `amount`); `protected readonly` `F`/`H`/`nb`/`_gBuf`; `SpectralOptions` (has `floorDb`); `process(block, noiseGate)`/`reset()`/`get engaged()`.
- Produces:
  - constants `DEREVERB_T60 = 0.5`, `DEREVERB_BETA = 1.6`, `DEREVERB_GMIN_DB = -10`, `DEREVERB_EARLY_MS = 48`.
  - `interface DereverbOptions extends SpectralOptions { t60?: number; beta?: number; gminDb?: number; earlyMs?: number }`
  - `class StreamingDereverb extends StreamingSpectralProcessor` — ctor `(sampleRate: number, opts?: DereverbOptions)`; overrides `computeGain` and `reset`; adds `get decayPole(): number` and `get delayFrames(): number`.

- [ ] **Step 1: Make `gFloor` protected**

In `src/live/spectral-processor.ts`, change line 34 from `private readonly gFloor: number;` to:
```ts
  protected readonly gFloor: number;
```
(No other change. This is exercised by the dereverb subclass in this task.)

- [ ] **Step 2: Write the failing test**

```ts
// test/live-dereverb.test.ts
import { describe, it, expect } from 'vitest';
import { StreamingDereverb } from '../src/live/dereverb.js';

function rms(x: Float32Array): number { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / Math.max(1, x.length)); }
function lcg(seed: number): () => number { let s = seed; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s / 0x7fffffff) * 2 - 1; }; }

describe('StreamingDereverb', () => {
  it('derives the decay pole and delay frames from sr / t60 / earlyMs', () => {
    const d = new StreamingDereverb(44100, { t60: 0.5, earlyMs: 48 });
    // hop H = 256 (frame 512); a = exp(-13.8155 * 256 / (0.5 * 44100)); d = round(0.048 * 44100 / 256) = 8
    expect(d.decayPole).toBeCloseTo(Math.exp((-13.8155 * 256) / (0.5 * 44100)), 6);
    expect(d.delayFrames).toBe(8);
  });

  it('beta = 0 is a passthrough (gain ≡ 1; output ≈ input after warmup)', () => {
    const d = new StreamingDereverb(44100, { beta: 0, warmupFrames: 1 });
    const rnd = lcg(5);
    const n = 512 * 12;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.25 * rnd();
    const out = d.process(x, false);
    // after the warmup/latency seam, the reconstructed signal matches the input level (STFT COLA)
    expect(rms(out.subarray(512 * 4))).toBeCloseTo(rms(x.subarray(512 * 4)), 1);
  });

  it('preserves the onset but suppresses the sustained/late tail (dereverb signature)', () => {
    const d = new StreamingDereverb(44100, { warmupFrames: 2 });
    const rnd = lcg(9);
    const F = 512;
    const pre = F * 4;            // silence to engage the warmup
    const burst = F * 30;         // a sustained tone burst
    const n = pre + burst;
    const x = new Float32Array(n);
    for (let i = pre; i < n; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 700 * i) / 44100) + 0.02 * rnd();
    const out = d.process(x, false);
    // onset = first ~6 frames of the burst (R still low from the silence → gain ≈ 1)
    const onsetIn = rms(x.subarray(pre, pre + F * 6));
    const onsetOut = rms(out.subarray(pre, pre + F * 6));
    // late = last ~6 frames of the burst (R has risen → suppressed toward the floor)
    const lateIn = rms(x.subarray(n - F * 6, n));
    const lateOut = rms(out.subarray(n - F * 6, n));
    const onsetGain = onsetOut / onsetIn;
    const lateGain = lateOut / lateIn;
    expect(onsetGain).toBeGreaterThan(lateGain * 1.2); // the onset is clearly less attenuated than the late tail
  });

  it('reset() clears the reverb state (re-feeding reproduces a fresh run)', () => {
    const mk = () => new StreamingDereverb(44100, { warmupFrames: 1 });
    const rnd = lcg(3);
    const n = 512 * 8;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.2 * rnd();
    const fresh = mk().process(x.slice(), false);
    const reused = mk();
    reused.process(x.slice(), false);
    reused.reset();
    const after = reused.process(x.slice(), false);
    for (let i = 0; i < n; i++) expect(after[i]!).toBeCloseTo(fresh[i]!, 9);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/live-dereverb.test.ts`
Expected: FAIL — `../src/live/dereverb.js` unresolved.

- [ ] **Step 4: Write the implementation**

```ts
// src/live/dereverb.ts
/**
 * Streaming single-channel dereverberation — a causal port of OCTOVOX's
 * dereverb_spectral (Lebart 2001 / Habets statistical late-reverb suppression).
 * A drop-in over the Phase-3a STFT base: it estimates the LATE-reverb power as a
 * delayed, T60-decayed, one-pole-smoothed copy of the observed power and applies a
 * spectral-subtraction gain G = max(1 − β·R/P, Gmin). VAD-independent; only LATE
 * reverb (older than `earlyMs`) is suppressed; the gain floor keeps it from ever
 * hard-muting. Pure, zero-dep. Port of the Python StreamingDereverb.
 */
import { StreamingSpectralProcessor, type SpectralOptions } from './spectral-processor.js';

export const DEREVERB_T60 = 0.5;
export const DEREVERB_BETA = 1.6;
export const DEREVERB_GMIN_DB = -10;
export const DEREVERB_EARLY_MS = 48;

export interface DereverbOptions extends SpectralOptions {
  t60?: number;
  beta?: number;
  gminDb?: number;
  earlyMs?: number;
}

export class StreamingDereverb extends StreamingSpectralProcessor {
  private readonly beta: number;
  private readonly _a: number; // per-frame 60 dB decay pole
  private readonly _d: number; // early-reflection delay in frames
  private readonly _R: Float64Array; // per-bin late-reverb PSD (one-pole IIR state)
  private readonly _phist: Float64Array; // flat ring (_d × nb) of the last _d power frames
  private _phistIdx = 0;

  constructor(sampleRate: number, opts: DereverbOptions = {}) {
    const gminDb = opts.gminDb ?? DEREVERB_GMIN_DB;
    // Hand gminDb to the base as floorDb so the inherited gFloor IS the dereverb amplitude Gmin.
    super(sampleRate, { ...opts, floorDb: gminDb });
    const t60 = Math.max(0.05, opts.t60 ?? DEREVERB_T60);
    this.beta = Math.max(0, opts.beta ?? DEREVERB_BETA);
    const earlyMs = Math.max(0, opts.earlyMs ?? DEREVERB_EARLY_MS);
    this._a = Math.exp((-13.8155 * this.H) / (t60 * sampleRate)); // a = exp(-ln(1e6)·HOP/(t60·fs))
    this._d = Math.max(1, Math.round(((earlyMs / 1000) * sampleRate) / this.H));
    this._R = new Float64Array(this.nb);
    this._phist = new Float64Array(this._d * this.nb);
  }

  /** Per-frame 60 dB decay pole (diagnostic). */
  get decayPole(): number {
    return this._a;
  }

  /** Early-reflection delay in STFT frames (diagnostic). */
  get delayFrames(): number {
    return this._d;
  }

  protected override computeGain(power: Float64Array, _noiseMag: Float64Array): Float64Array {
    const nb = this.nb;
    const g = this._gBuf;
    const off = this._phistIdx * nb;
    for (let k = 0; k < nb; k++) {
      const pd = this._phist[off + k]!; // power from _d frames ago (0 until the ring fills)
      this._phist[off + k] = power[k]!; // overwrite in place with the current power (no copy)
      const r = this._a * this._R[k]! + (1 - this._a) * pd;
      this._R[k] = r;
      const sub = 1 - (this.beta * r) / (power[k]! + 1e-20);
      g[k] = sub > this.gFloor ? sub : this.gFloor;
    }
    this._phistIdx = (this._phistIdx + 1) % this._d;
    return g;
  }

  override reset(): void {
    super.reset();
    this._R.fill(0);
    this._phist.fill(0);
    this._phistIdx = 0;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/live-dereverb.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add src/live/spectral-processor.ts src/live/dereverb.ts test/live-dereverb.test.ts
git commit -m "feat(live): streaming single-channel dereverb (Lebart/Habets late-reverb suppression)"
```

---

### Task 2: `ChainedCleaner` (`cleaner-chain.ts`)

**Files:**
- Create: `src/live/cleaner-chain.ts`
- Test: `test/live-cleaner-chain.test.ts`

**Interfaces:**
- Consumes: `Cleaner` (the `{ process(block, noiseGate): Float32Array; reset(): void }` contract from `level-preserving-cleaner.ts`).
- Produces: `class ChainedCleaner implements Cleaner` — ctor `(stages: Cleaner[])`; runs stages in order; `reset()` resets each.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-cleaner-chain.test.ts
import { describe, it, expect } from 'vitest';
import { ChainedCleaner } from '../src/live/cleaner-chain.js';
import type { Cleaner } from '../src/live/level-preserving-cleaner.js';

function fixedGain(g: number, log?: number[], id?: number): Cleaner {
  return {
    process: (b) => { if (log && id !== undefined) log.push(id); const o = new Float32Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b[i]! * g; return o; },
    reset: () => {},
  };
}

describe('ChainedCleaner', () => {
  it('applies stages in order (composed gain is the product)', () => {
    const order: number[] = [];
    const chain = new ChainedCleaner([fixedGain(0.5, order, 0), fixedGain(0.25, order, 1)]);
    const out = chain.process(Float32Array.of(1, 1, 1), false);
    expect(out[0]!).toBeCloseTo(0.125, 9); // 0.5 * 0.25
    expect(order).toEqual([0, 1]); // stage 0 before stage 1
  });

  it('a single-element chain equals that stage', () => {
    const chain = new ChainedCleaner([fixedGain(0.5)]);
    const out = chain.process(Float32Array.of(2, 4), false);
    expect([out[0]!, out[1]!]).toEqual([1, 2]);
  });

  it('reset() resets every stage', () => {
    let a = 0, b = 0;
    const s1: Cleaner = { process: (x) => x, reset: () => { a++; } };
    const s2: Cleaner = { process: (x) => x, reset: () => { b++; } };
    new ChainedCleaner([s1, s2]).reset();
    expect([a, b]).toEqual([1, 1]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-cleaner-chain.test.ts`
Expected: FAIL — `../src/live/cleaner-chain.js` unresolved.

- [ ] **Step 3: Write the implementation**

```ts
// src/live/cleaner-chain.ts
/**
 * Runs an ordered list of cleaning stages, threading each stage's output into the
 * next. The composition point for the cleaning chain (e.g. dereverb → denoise).
 * Pure, allocation-free (it reuses each stage's own output buffers).
 */
import type { Cleaner } from './level-preserving-cleaner.js';

export class ChainedCleaner implements Cleaner {
  private readonly stages: Cleaner[];

  constructor(stages: Cleaner[]) {
    this.stages = stages;
  }

  process(block: Float32Array, noiseGate: boolean): Float32Array {
    let out = block;
    for (const stage of this.stages) out = stage.process(out, noiseGate);
    return out;
  }

  reset(): void {
    for (const stage of this.stages) stage.reset();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/live-cleaner-chain.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/live/cleaner-chain.ts test/live-cleaner-chain.test.ts
git commit -m "feat(live): ordered cleaner chain"
```

---

### Task 3: Wire opt-in dereverb into the cleaning chain (`engine.ts`, `types.ts`, `index.ts`)

**Files:**
- Modify: `src/live/types.ts`, `src/live/engine.ts`, `src/live/index.ts`
- Test: `test/live-engine.test.ts` (append)

**Interfaces:**
- Consumes: `StreamingDereverb` (Task 1), `ChainedCleaner` (Task 2), `StreamingSpectralProcessor`/`OmlsaProcessor`/`LevelPreservingCleaner`/`Cleaner` (Phase 3a).
- Produces: `CleaningConfig` with optional `engine` + new `dereverb?`; `BeamOutput.cleaning.dereverb?`; the engine builds the ordered chain.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-engine.test.ts (append a new describe)
describe('LiveEngine dereverb (Phase 3b)', () => {
  const geom = sensibel8(0.04);
  function mock() { return new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 40, blockSize: 256, freqHz: 1500 }); }

  it('dereverb-only surfaces { engine:"off", preserved:false, dereverb:true } and runs', async () => {
    const engine = new LiveEngine(mock(), { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90, cleaning: { dereverb: {} } });
    let info: unknown = 'unset';
    engine.onOutput((o) => { info = (o as { cleaning?: unknown }).cleaning; });
    await engine.start();
    expect(info).toEqual({ engine: 'off', preserved: false, dereverb: true });
  });

  it('dereverb + omlsa surfaces both', async () => {
    const engine = new LiveEngine(mock(), { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90, cleaning: { dereverb: {}, engine: 'omlsa' } });
    let info: unknown = 'unset';
    engine.onOutput((o) => { info = (o as { cleaning?: unknown }).cleaning; });
    await engine.start();
    expect(info).toEqual({ engine: 'omlsa', preserved: false, dereverb: true });
  });

  it('omlsa-only keeps the Phase-3a shape (no dereverb key)', async () => {
    const engine = new LiveEngine(mock(), { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90, cleaning: { engine: 'omlsa' } });
    let info: unknown = 'unset';
    engine.onOutput((o) => { info = (o as { cleaning?: unknown }).cleaning; });
    await engine.start();
    expect(info).toEqual({ engine: 'omlsa', preserved: false }); // exactly the 3a shape
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-engine.test.ts`
Expected: FAIL — `cleaning.dereverb` not accepted / no dereverb in the emitted `cleaning`.

- [ ] **Step 3: Extend the types**

In `src/live/types.ts`, change the `CleaningConfig` interface (make `engine` optional, add `dereverb`):
```ts
export interface CleaningConfig {
  engine?: 'off' | 'gate' | 'omlsa' | 'wiener';
  /** 0..1 → the denoiser `amount` (gentler at lower values). */
  strength?: number;
  /** Wrap the cleaner in the level-preserving makeup. */
  preserveLevel?: boolean;
  /** Opt-in dereverb stage; runs BEFORE the denoiser. */
  dereverb?: { t60?: number; beta?: number; gminDb?: number; earlyMs?: number };
}
```
And change `BeamOutput.cleaning` to:
```ts
  cleaning?: { engine: string; preserved: boolean; dereverb?: boolean };
```

- [ ] **Step 4: Build the chain in the engine**

In `src/live/engine.ts`, add the imports:
```ts
import { OmlsaProcessor } from './omlsa.js';
import { StreamingDereverb } from './dereverb.js';
import { ChainedCleaner } from './cleaner-chain.js';
```
(`StreamingSpectralProcessor`, `LevelPreservingCleaner`/`Cleaner`, and the `CleaningConfig` type import already exist; if `OmlsaProcessor` is already imported, do not duplicate.)

Change the `cleaningInfo` field type to include the optional `dereverb`:
```ts
  private cleaningInfo: { engine: string; preserved: boolean; dereverb?: boolean } | null = null;
```

Replace the Phase-3a cleaner-build block (currently `const cc = config.cleaning; if (cc !== undefined && cc.engine !== 'off') { … }`) with:
```ts
    // --- Phase 3a/3b: optional post-beam cleaning chain (dereverb → denoise) ---
    const cc: CleaningConfig | undefined = config.cleaning;
    const engine = cc?.engine ?? 'off';
    if (cc !== undefined && (engine !== 'off' || cc.dereverb !== undefined)) {
      const sr = config.sampleRate ?? 44100;
      const strength = cc.strength ?? 1;
      const stages: Cleaner[] = [];
      if (cc.dereverb !== undefined) stages.push(new StreamingDereverb(sr, cc.dereverb));
      if (engine !== 'off') {
        stages.push(
          engine === 'gate'
            ? new StreamingSpectralProcessor(sr, { amount: strength })
            : new OmlsaProcessor(sr, { amount: strength, mode: engine }),
        );
      }
      const inner: Cleaner = stages.length === 1 ? stages[0]! : new ChainedCleaner(stages);
      this.cleaner = cc.preserveLevel ? new LevelPreservingCleaner(inner) : inner;
      this.cleaningInfo = {
        engine,
        preserved: cc.preserveLevel === true,
        ...(cc.dereverb !== undefined ? { dereverb: true } : {}),
      };
    }
```
(The `onBlock` cleaning call and the `...(this.cleaningInfo !== null ? { cleaning: this.cleaningInfo } : {})` emission are unchanged.)

- [ ] **Step 5: Export the new surface**

In `src/live/index.ts`, append:
```ts
export { StreamingDereverb, DEREVERB_T60, DEREVERB_BETA, DEREVERB_GMIN_DB, DEREVERB_EARLY_MS, type DereverbOptions } from './dereverb.js';
export { ChainedCleaner } from './cleaner-chain.js';
```

- [ ] **Step 6: Run test + full gate**

Run: `npx vitest run test/live-engine.test.ts && npm run typecheck && npm test && npm run build`
Expected: the 3 new tests PASS; the existing 3a engine tests (which assert `{ engine, preserved }`) still PASS; `tsc` clean; full suite green; build emits `dist/`. Fix any unused-import issues at the barrel without casts.

- [ ] **Step 7: Commit**

```bash
git add src/live/types.ts src/live/engine.ts src/live/index.ts test/live-engine.test.ts
git commit -m "feat(live): wire opt-in dereverb into the cleaning chain"
```

---

### Task 4: Docs (README + CHANGELOG + CLAUDE.md) + final gate

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: README — add a dereverb subsection**

Append to the "Noise suppression (Phase 3a)" area in `README.md`:
```markdown
### Dereverb (Phase 3b)

Add an opt-in dereverb stage that runs **before** the denoiser to strip the late-reverberation tail
(the boxy/distant room "ring"):

```ts
const engine = new LiveEngine(new NodeCaptureAdapter(), {
  geom, deviceName: 'SB-POLARIS', sampleRate: 44100,
  cleaning: { dereverb: { t60: 0.5 }, engine: 'omlsa', preserveLevel: true }, // dereverb → OM-LSA → makeup
});
```

- `dereverb: { t60?, beta?, gminDb?, earlyMs? }` — single-channel Lebart/Habets **late-reverb spectral
  subtraction** (`G = max(1 − β·R/P, Gmin)`), where `R` is a T60-decayed estimate of a delayed power tap.
  Defaults: `t60 0.5 s`, `β 1.6`, `Gmin −10 dB`, `early 48 ms`.
- It composes with the 3a denoiser as an ordered chain (`dereverb → denoise`); the level-preserving makeup
  (if on) wraps the whole chain. Omitting `cleaning.dereverb` is byte-identical to Phase 3a.

Still zero-dependency (pure DSP). **Honest limits:** statistical single-channel dereverb (not an inverse/RIR
deconvolution); assumes a fixed T60; shares the ~12 ms STFT latency and ~0.7 s warmup; only LATE reverb
(older than `earlyMs`) is suppressed — early reflections are kept; the gain floor (−10 dB) means it never
hard-mutes. AEC and AGC/PEQ are later sub-phases.
```

- [ ] **Step 2: CHANGELOG — add an `[Unreleased] > Added` bullet**

```markdown
- **Real-time dereverb (Phase 3b)** — opt-in `StreamingDereverb` (`dereverb.ts`), a single-channel
  Lebart/Habets late-reverb spectral-subtraction stage built on the Phase-3a STFT base (overrides only the
  gain law + a small power-history ring). Composes before the denoiser via a new `ChainedCleaner`
  (`cleaner-chain.ts`), matching the Python stage order (dereverb → post-NR). Wired through
  `LiveConfig.cleaning.dereverb` (`engine` is now optional so dereverb can run alone); `BeamOutput.cleaning`
  surfaces an omit-when-absent `dereverb` flag (Phase-3a shapes unchanged). Pure DSP — no new dependency.
  Ported from the Python `StreamingDereverb`. AEC / AGC / PEQ are later sub-phases.
```

- [ ] **Step 3: CLAUDE.md — add a note**

Append to the live-audio architecture bullets in `CLAUDE.md`:
```markdown
- **Dereverb (Phase 3b, `src/live/dereverb.ts` + `cleaner-chain.ts`).** A `StreamingDereverb` extends the
  Phase-3a STFT base and overrides the gain law with Lebart/Habets late-reverb spectral subtraction
  (`G = max(1 − β·R/P, Gmin)`; `R` = a T60-decayed delayed-power estimate). It runs **before** the denoiser
  via an ordered `ChainedCleaner` (matching the Python chain order). Opt-in via `LiveConfig.cleaning.dereverb`
  (default off = Phase-3a unchanged); still zero-dep. AEC/AGC/PEQ are later sub-phases.
```

- [ ] **Step 4: Final gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: `tsc` clean; ALL tests pass (existing + the new Phase-3b tests); build emits `dist/`.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md CLAUDE.md
git commit -m "docs: document Phase 3b real-time dereverb"
```

---

## Self-Review

**Spec coverage:** `gFloor` protected + `StreamingDereverb` (Task 1); `ChainedCleaner` (Task 2); `engine`-optional + `dereverb` config + chain build + `BeamOutput.cleaning.dereverb` omit-when-absent (Task 3); honest-limits docs (Task 4). The Lebart/Habets gain law, the `a`/`d` derivation, the read-then-overwrite ring, bit-exact-off (inherited), and the dereverb-before-denoise order are all covered.

**Placeholder scan:** none — every code/test step has complete code and exact commands.

**Type consistency:** `StreamingDereverb`/`DereverbOptions`/`DEREVERB_*` (Task 1) are consumed by Task 3; `ChainedCleaner` (Task 2) by Task 3; the `Cleaner` contract is the one from `level-preserving-cleaner.ts`; `computeGain(power, noiseMag)` and `_gBuf`/`gFloor`/`H`/`nb` match the Phase-3a base; `cleaningInfo`'s `{ engine; preserved; dereverb? }` matches `BeamOutput.cleaning`.

**Implementer notes:** (1) `gFloor` must be `protected` (Task 1 Step 1) before the dereverb compiles. (2) `computeGain` returns the RAW gain into `_gBuf`; the base does the smoothing + `amount` — do NOT re-smooth in the override. (3) The `_phist` ring is read-then-overwritten in place (no `Pd` copy) — preserve that for the no-hot-path-allocation invariant. (4) `gminDb` overrides any caller `floorDb` via `{ ...opts, floorDb: gminDb }`. (5) The `BeamOutput.cleaning.dereverb` field is **omit-when-absent** — the existing 3a engine tests assert the exact `{ engine, preserved }` shape and MUST stay green; if one fails, the omit-when-absent spread was not used. (6) `engine` is now optional (default `'off'`) — use `cc?.engine ?? 'off'` everywhere, never `cc.engine !== 'off'` on the raw optional.
