# Live audio — Phase 3d-2 (parametric EQ) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, zero-dep parametric EQ (RBJ-cookbook biquad cascade) to the live cleaning chain, running after the cleaner and before the AGC.

**Architecture:** A new `StreamingPeq` (`src/live/peq.ts`) designs up to 4 normalized second-order RBJ sections (one per enabled band) and runs a hand-rolled Direct-Form-II-transposed cascade with carried Float64 state (replacing the Python's scipy `sosfilt`). It is wired into `LiveEngine.onBlock` between the cleaner and the AGC stages, opt-in via `LiveConfig.peq`; default off returns the input object unchanged (byte-identical). Reuses the existing shared `PeqBand`/`PeqBandType` model (schema parity for free).

**Tech Stack:** TypeScript ESM (strict), vitest, zero runtime dependencies.

## Global Constraints

- **Zero runtime dependencies** — `package.json` `dependencies` stays `{}`. The biquad math + recursion are hand-rolled (no scipy/DSP lib).
- **`src/live/` is browser-safe** — NO `node:*` imports, NO `Buffer`. Pure TS.
- **Relative imports carry `.js`** (ESM); use `import type` for type-only imports (`verbatimModuleSyntax`).
- **No `as` casts.** Non-null assertion `!` is allowed (required by `noUncheckedIndexedAccess`).
- **`exactOptionalPropertyTypes`** — optional fields use the omit-when-absent spread `...(x !== undefined ? { x } : {})`, never `{ x: undefined }`.
- **`noUnusedLocals`/`noUnusedParameters`** — an intentionally-ignored parameter is referenced via `void param;`.
- **Default-off is byte-identical** — when `LiveConfig.peq` is absent (or has no enabled bands) the engine builds no PEQ stage and `BeamOutput` is unchanged. Existing Phase-3a/3b/3c/3d-1 engine-shape tests must stay green.
- **DSP math in Float64**, output cast to `Float32`.
- Tests are hardware-free (vitest). Gates: `npm run typecheck`, `npm test`, `npm run build` all green.

---

### Task 1: `StreamingPeq` — RBJ biquad cascade

**Files:**
- Create: `src/live/peq.ts`
- Test: `test/live-peq.test.ts`

**Interfaces:**
- Consumes: `PeqBand`, `PeqBandType` from `../model/dsp-blocks.js` (type-only). `PeqBand = { freqHz: number; gainDb: number; q: number; type: PeqBandType }`; `PeqBandType = 'bell' | 'lowShelf' | 'highShelf' | 'highpass' | 'lowpass'`.
- Produces (used by Task 2):
  - `class StreamingPeq { constructor(sampleRate: number, bands?: readonly PeqBand[]); setBands(bands?: readonly PeqBand[]): void; process(block: Float32Array, noiseGate?: boolean): Float32Array; reset(): void; }`
  - `const PEQ_DENORMAL_FLOOR = 1e-25`

**Reference:** port of `conf_pipeline_control/peq.py` (`_biquad` lines 35-75, `StreamingPeq`). The TS recursion is the scipy-`sosfilt` Direct-Form-II-transposed state form, hand-rolled. NOTE the TS `PeqBand` model has **no `enabled` field** (unlike the Python dict) — so there is no `enabled` filtering; every passed band is considered (and dropped only by the no-op guards).

- [ ] **Step 1: Write the failing test**

Create `test/live-peq.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { StreamingPeq, PEQ_DENORMAL_FLOOR } from '../src/live/peq.js';
import type { PeqBand } from '../src/model/dsp-blocks.js';

const FS = 44100;

/** RMS of a buffer. */
function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / x.length);
}

/** A pure sine block at `f` Hz. */
function sine(f: number, n: number, amp = 0.25): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * f * i) / FS);
  return out;
}

/** Run a long signal through the filter in 256-sample blocks; return the concatenated tail (steady state). */
function runSteady(peq: StreamingPeq, f: number, blocks = 40): Float32Array {
  const N = 256;
  let last = new Float32Array(N);
  let phase = 0;
  for (let b = 0; b < blocks; b++) {
    const blk = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      blk[i] = 0.25 * Math.sin((2 * Math.PI * f * phase) / FS);
      phase++;
    }
    last = peq.process(blk);
  }
  return last;
}

describe('StreamingPeq', () => {
  it('passes through bit-exact (same object) when there are no bands', () => {
    const peq = new StreamingPeq(FS);
    const blk = sine(1000, 256);
    const out = peq.process(blk);
    expect(out).toBe(blk); // SAME object — no copy
  });

  it('skips a 0 dB bell (identity → same object)', () => {
    const peq = new StreamingPeq(FS, [{ type: 'bell', freqHz: 1000, gainDb: 0, q: 1 }]);
    const blk = sine(1000, 256);
    expect(peq.process(blk)).toBe(blk);
  });

  it('a +12 dB bell at 1 kHz boosts a 1 kHz tone but leaves a far tone ~unchanged', () => {
    const band: PeqBand = { type: 'bell', freqHz: 1000, gainDb: 12, q: 1 };
    const onBand = runSteady(new StreamingPeq(FS, [band]), 1000);
    const offBand = runSteady(new StreamingPeq(FS, [band]), 100);
    const refOn = runSteady(new StreamingPeq(FS), 1000);
    const refOff = runSteady(new StreamingPeq(FS), 100);
    const boostDb = 20 * Math.log10(rms(onBand) / rms(refOn));
    const farDb = 20 * Math.log10(rms(offBand) / rms(refOff));
    expect(boostDb).toBeGreaterThan(9); // ~ +12 dB at the centre
    expect(boostDb).toBeLessThan(15);
    expect(Math.abs(farDb)).toBeLessThan(2); // 100 Hz is far below the 1 kHz Q1 bell
  });

  it('a lowpass at 500 Hz attenuates 4 kHz and passes 100 Hz', () => {
    const band: PeqBand = { type: 'lowpass', freqHz: 500, gainDb: 0, q: 0.707 };
    const high = runSteady(new StreamingPeq(FS, [band]), 4000);
    const low = runSteady(new StreamingPeq(FS, [band]), 100);
    const refHigh = runSteady(new StreamingPeq(FS), 4000);
    const refLow = runSteady(new StreamingPeq(FS), 100);
    const highDb = 20 * Math.log10(rms(high) / rms(refHigh));
    const lowDb = 20 * Math.log10(rms(low) / rms(refLow));
    expect(highDb).toBeLessThan(-15); // strong attenuation well above cutoff
    expect(Math.abs(lowDb)).toBeLessThan(2); // passband
  });

  it('a highpass at 500 Hz attenuates 100 Hz and passes 4 kHz', () => {
    const band: PeqBand = { type: 'highpass', freqHz: 500, gainDb: 0, q: 0.707 };
    const low = runSteady(new StreamingPeq(FS, [band]), 100);
    const high = runSteady(new StreamingPeq(FS, [band]), 4000);
    const refLow = runSteady(new StreamingPeq(FS), 100);
    const refHigh = runSteady(new StreamingPeq(FS), 4000);
    const lowDb = 20 * Math.log10(rms(low) / rms(refLow));
    const highDb = 20 * Math.log10(rms(high) / rms(refHigh));
    expect(lowDb).toBeLessThan(-15);
    expect(Math.abs(highDb)).toBeLessThan(2);
  });

  it('matches a hand-computed RBJ bell section coefficients', () => {
    // +6 dB bell @ 1 kHz, Q 2, fs 44100 — hand-compute the normalized section.
    const f0 = 1000, gainDb = 6, q = 2, fs = FS;
    const A = Math.pow(10, gainDb / 40);
    const w0 = (2 * Math.PI * f0) / fs;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * q);
    const a0 = 1 + alpha / A;
    const expected = {
      b0: (1 + alpha * A) / a0,
      b1: (-2 * cw) / a0,
      b2: (1 - alpha * A) / a0,
      a1: (-2 * cw) / a0,
      a2: (1 - alpha / A) / a0,
    };
    const peq = new StreamingPeq(fs, [{ type: 'bell', freqHz: f0, gainDb, q }]);
    const sec = peq.debugSections();
    expect(sec.length).toBe(1);
    expect(sec[0]!.b0).toBeCloseTo(expected.b0, 12);
    expect(sec[0]!.b1).toBeCloseTo(expected.b1, 12);
    expect(sec[0]!.b2).toBeCloseTo(expected.b2, 12);
    expect(sec[0]!.a1).toBeCloseTo(expected.a1, 12);
    expect(sec[0]!.a2).toBeCloseTo(expected.a2, 12);
  });

  it('drops out-of-range bands (f0 ≥ Nyquist, f0 ≤ 0, q ≤ 0)', () => {
    const peq = new StreamingPeq(FS, [
      { type: 'bell', freqHz: 30000, gainDb: 6, q: 1 }, // above Nyquist
      { type: 'bell', freqHz: 0, gainDb: 6, q: 1 }, // f0 = 0
      { type: 'bell', freqHz: 1000, gainDb: 6, q: 0 }, // q = 0
    ]);
    expect(peq.debugSections().length).toBe(0);
    const blk = sine(1000, 256);
    expect(peq.process(blk)).toBe(blk); // nothing enabled → passthrough
  });

  it('setBands keeps state on same count and resets on a different count', () => {
    const peq = new StreamingPeq(FS, [{ type: 'bell', freqHz: 1000, gainDb: 6, q: 1 }]);
    peq.process(sine(1000, 256)); // build up some state
    const before = peq.debugState().slice();
    peq.setBands([{ type: 'bell', freqHz: 2000, gainDb: 6, q: 1 }]); // same count (1) → keep state
    expect(Array.from(peq.debugState())).toEqual(Array.from(before));
    peq.setBands([
      { type: 'bell', freqHz: 1000, gainDb: 6, q: 1 },
      { type: 'highpass', freqHz: 100, gainDb: 0, q: 0.707 },
    ]); // count 1 → 2 → fresh zero state
    expect(peq.debugState().every((v) => v === 0)).toBe(true);
  });

  it('reset() zeroes state — re-feeding reproduces a fresh run', () => {
    const peq = new StreamingPeq(FS, [{ type: 'highpass', freqHz: 500, gainDb: 0, q: 0.707 }]);
    const first = peq.process(sine(1000, 256)).slice();
    peq.process(sine(1000, 256)); // dirty the state
    peq.reset();
    const again = peq.process(sine(1000, 256));
    for (let i = 0; i < first.length; i++) expect(again[i]).toBeCloseTo(first[i]!, 6);
  });

  it('stays finite over a long run (no NaN / denormal stall)', () => {
    const peq = new StreamingPeq(FS, [{ type: 'bell', freqHz: 50, gainDb: 10, q: 8 }]);
    for (let b = 0; b < 200; b++) {
      const out = peq.process(sine(50, 256));
      for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i]!)).toBe(true);
    }
    expect(PEQ_DENORMAL_FLOOR).toBe(1e-25);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/live-peq.test.ts`
Expected: FAIL — `Cannot find module '../src/live/peq.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/live/peq.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/live-peq.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean (no errors). If `debugSections`'s `readonly Section[]` return trips a consumer, it does not — `Section` is module-private and only the tests call it.

- [ ] **Step 6: Commit**

```bash
git add src/live/peq.ts test/live-peq.test.ts
git commit -m "feat(live): parametric EQ (RBJ biquad cascade)"
```

---

### Task 2: Wire opt-in PEQ into `LiveEngine` (before the AGC)

**Files:**
- Modify: `src/live/types.ts` (add `PeqConfig`, `LiveConfig.peq?`)
- Modify: `src/live/engine.ts` (build + run the PEQ between cleaner and AGC)
- Modify: `src/live/index.ts` (export `StreamingPeq`, `PEQ_DENORMAL_FLOOR`, `PeqConfig`)
- Test: `test/live-engine-peq.test.ts`

**Interfaces:**
- Consumes: `StreamingPeq`, `PEQ_DENORMAL_FLOOR` from `./peq.js`; `PeqBand` from `../model/dsp-blocks.js`.
- Produces: `interface PeqConfig { bands: PeqBand[] }`; `LiveConfig.peq?: PeqConfig`. (No `BeamOutput` field — PEQ is a linear filter with no scalar telemetry.)

- [ ] **Step 1: Write the failing test**

Create `test/live-engine-peq.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { LiveEngine } from '../src/live/engine.js';
import { MockCaptureAdapter, planeWaveChannels } from '../src/live/mock-adapter.js';
import { sensibel8 } from '../src/beamformer/geometry.js';
import type { LiveConfig, BeamOutput } from '../src/live/types.js';

const GEOM = sensibel8();

/** Drive the engine for a fixed number of blocks, collecting the emitted outputs. */
async function run(config: LiveConfig, blocks = 30): Promise<BeamOutput[]> {
  const adapter = new MockCaptureAdapter({
    sampleRate: 44100,
    blockSize: 256,
    channels: 8,
    frames: (i) => planeWaveChannels(GEOM, 0, 1000, 256, i, 44100),
  });
  const out: BeamOutput[] = [];
  const engine = new LiveEngine({ ...config, geom: GEOM }, adapter);
  engine.onOutput((o) => out.push(o));
  await engine.start();
  for (let i = 0; i < blocks; i++) await adapter.pump();
  await engine.stop();
  return out;
}

describe('LiveEngine PEQ wiring', () => {
  it('emits no `peq` field and is byte-identical in shape when peq is absent', async () => {
    const out = await run({ sampleRate: 44100 });
    expect(out.length).toBeGreaterThan(0);
    for (const o of out) expect('peq' in o).toBe(false);
  });

  it('shapes the mono when a PEQ band is configured (runs without throwing)', async () => {
    const ref = await run({ sampleRate: 44100 });
    const eq = await run({ sampleRate: 44100, peq: { bands: [{ type: 'bell', freqHz: 1000, gainDb: 12, q: 1 }] } });
    const refRms = ref.at(-1)!.rmsDb;
    const eqRms = eq.at(-1)!.rmsDb;
    expect(Number.isFinite(eqRms)).toBe(true);
    expect(eqRms).not.toBeCloseTo(refRms, 1); // a +12 dB bell on the 1 kHz beam changes the level
  });
});
```

(If `MockCaptureAdapter`'s constructor/`pump` signature differs in this repo, the implementer must match the existing live-engine tests — read `test/live-engine*.test.ts` for the exact harness and adapt this test to it; the assertions, not the harness wiring, are the requirement.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/live-engine-peq.test.ts`
Expected: FAIL — `peq` not assignable to `LiveConfig` (and/or the band type unknown).

- [ ] **Step 3: Add the config type**

In `src/live/types.ts`, add `PeqBand` to the type imports at the top (alongside the existing `../model` imports — check the file for an existing `../model/...` import to extend; otherwise add `import type { PeqBand } from '../model/dsp-blocks.js';`). Then add the config interface (near the existing `AgcConfig`, around line 70):

```ts
/** Parametric-EQ config: up to {@link PEQ_MAX_BANDS} RBJ bands (the shared PEQ model). */
export interface PeqConfig {
  bands: PeqBand[];
}
```

And add the optional field to `LiveConfig` (after the existing `agc?: AgcConfig;`, around line 99):

```ts
  peq?: PeqConfig;
```

(Do NOT add a `BeamOutput.peq` field — PEQ has no scalar telemetry.)

- [ ] **Step 4: Build + run the PEQ in the engine**

In `src/live/engine.ts`:

1. Add the import (near the other live-stage imports, e.g. after the `TargetLoudnessAgc` import on line 6):

```ts
import { StreamingPeq } from './peq.js';
```

2. Add the field (next to `private agc: TargetLoudnessAgc | null = null;`, ~line 43):

```ts
  private peq: StreamingPeq | null = null;
```

3. In the constructor, build the PEQ when configured with ≥1 band — place this **before** the AGC build (the AGC build is around line 118; the PEQ stage runs earlier in the chain, so keep construction order tidy by building it just above the AGC):

```ts
    if (config.peq && config.peq.bands.length > 0) {
      this.peq = new StreamingPeq(config.sampleRate ?? 44100, config.peq.bands);
    }
```

4. In `onBlock`, insert the PEQ stage **between the cleaner block and the AGC line** (after the `if (this.cleaner) { … }` block that ends ~line 162, before the `// Phase 3d-1` AGC comment ~line 163):

```ts
        // Phase 3d-2: parametric EQ — tone-shape the clean signal before the AGC levels it.
        if (this.peq) mono = this.peq.process(mono);
```

(Leave the `cb?.({ … })` spread unchanged — PEQ adds no `BeamOutput` field.)

- [ ] **Step 5: Export the surface**

In `src/live/index.ts`, after the AGC exports (line 49-50), add:

```ts
export { StreamingPeq, PEQ_DENORMAL_FLOOR } from './peq.js';
export type { PeqConfig } from './types.js';
```

- [ ] **Step 6: Run the new test + typecheck**

Run: `npx vitest run test/live-engine-peq.test.ts && npm run typecheck`
Expected: PASS + clean typecheck.

- [ ] **Step 7: Run the full suite + build**

Run: `npm test && npm run build`
Expected: all green (the existing Phase-3a/3b/3c/3d-1 engine-shape tests still pass — `peq` absent ⇒ no field).

- [ ] **Step 8: Commit**

```bash
git add src/live/types.ts src/live/engine.ts src/live/index.ts test/live-engine-peq.test.ts
git commit -m "feat(live): wire opt-in PEQ into LiveEngine (before the AGC)"
```

---

## Notes for the controller

- **No docs task here.** README/CHANGELOG/CLAUDE.md updates for the whole Phase-3d tier (AGC + PEQ + band-limit + voice-gate) are folded into a single docs commit at PR time (per the user directive "push all at the end").
- **No heavyweight whole-branch review for 3d-2 alone** — it is a small, well-specified port with per-task review. A single multi-lens adversarial review covers the full 3d tier before the PR (the DSP-math lens should hand-verify the RBJ coefficients + the DF-II-transposed recursion against `peq.py`).
- **Stacking:** this branch (`feat/live-audio-phase3d1-agc`) already carries 3d-1; 3d-2 commits land on top, then 3d-3. One combined PR at the end.

## Self-review (done)

- **Spec coverage:** `peq.ts` (Task 1) covers the RBJ design + DF-II-transposed recursion + no-op guards + state preservation + bit-exact passthrough; the engine wiring (Task 2) covers the opt-in config, the before-AGC placement, and byte-identical-when-off. Both match the spec sections 2.1/2.2/3.
- **Placeholders:** none — full code in every step.
- **Type consistency:** `StreamingPeq` signature, `PEQ_DENORMAL_FLOOR`, `Section` shape, `PeqConfig`/`LiveConfig.peq` all consistent across tasks. `PeqBand`/`PeqBandType` are the existing model types (not redefined). `debugSections`/`debugState` are test-only hooks.
- **Constraints:** zero-dep (hand-rolled biquad), browser-safe (`src/live/`, no node), `.js` imports, `import type`, no `as`, `void noiseGate;` for the ignored param, Float64 math → Float32 out, default-off byte-identical (same object + no field).
