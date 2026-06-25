# Live Audio — Phase 3d-1 Implementation Plan (target-loudness AGC)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in target-loudness AGC to the live engine — a slewed gain that normalizes the cleaned mono toward a target RMS, with silence-hold and a peak limiter, run after the cleaner before the meter.

**Architecture:** A new `TargetLoudnessAgc` (pure-TS, reuses the existing `ExponentialTracker` for the gain slew + the `LevelPreservingCleaner` peak-limiter math) wired into `LiveEngine` behind opt-in `LiveConfig.agc`. Default off = byte-identical to Phase 3c.

**Tech Stack:** TypeScript (ESM, strict), vitest; reuses `src/live/exponential-tracker.ts`, the limiter pattern from `src/live/level-preserving-cleaner.ts`, and the Phase-1/2/3 `LiveEngine`/`types.ts`.

## Global Constraints

- ESM-only; **every relative import carries a `.js` extension**.
- **Zero hard runtime dependencies** — `dependencies` stays `{}`. Pure DSP.
- `src/live/` is **browser-safe**: NO `node:*`, no `Buffer`.
- Strict tsconfig: `noUncheckedIndexedAccess` (`!`/guards), `exactOptionalPropertyTypes` (optional fields via the **omit-when-absent spread** `...(x !== undefined ? { x } : {})`, never `{ x: undefined }`), `noUnusedLocals`/`noUnusedParameters` (`void sampleRate;`), `verbatimModuleSyntax` (`import type`). NO `as` casts.
- **Constants (from `agc.py`):** `AGC_MAX_GAIN_DB=18`, `AGC_SLEW_ALPHA=0.15`, `AGC_SILENCE_DB=-55`, `AGC_CEILING_DB=-1`, `AGC_LIMIT_RELEASE_ALPHA=0.05`. `targetRms=10^(targetDb/20)`; `gainMax=10^(maxGainDb/20)`, `gainMin=10^(−maxGainDb/20)`; `silenceRms=10^(silenceDb/20)`; `ceiling=10^(−1/20)`.
- **Held-gain guard:** before the slew is seeded `tracker.value` is `0`; the held gain falls back to `1` via `this.slew.value || 1` (the AGC gain is clamped ≥ gainMin > 0, so a seeded value is never 0).
- **Default off = byte-identical to Phase 3c:** no `LiveConfig.agc` ⇒ the AGC object is never built ⇒ `mono` untouched ⇒ no `agc` field. The new `BeamOutput.agc?` is **omit-when-absent** so existing Phase-3a/3b/3c engine-shape tests stay green.
- Commands from repo root. Single file: `npx vitest run <file>`. Full gate: `npm run typecheck && npm test && npm run build` (currently 480 tests / 49 files).

---

## File Structure

- `src/live/agc.ts` — **create**. `TargetLoudnessAgc` + constants + `AgcOptions`.
- `src/live/types.ts` — **modify**. `AgcConfig`; `LiveConfig.agc?`; `BeamOutput.agc?`.
- `src/live/engine.ts` — **modify**. Build the AGC; run it after the cleaner / before the meter; emit `agc` telemetry.
- `src/live/index.ts` — **modify**. Export the new surface.
- Tests: `test/live-agc.test.ts`, extend `test/live-engine.test.ts`.

---

### Task 1: `TargetLoudnessAgc` (`agc.ts`)

**Files:**
- Create: `src/live/agc.ts`
- Test: `test/live-agc.test.ts`

**Interfaces:**
- Consumes: `ExponentialTracker` (`update(x):number`, `value`, `reset()`).
- Produces:
  - constants `AGC_MAX_GAIN_DB=18`, `AGC_SLEW_ALPHA=0.15`, `AGC_SILENCE_DB=-55`, `AGC_CEILING_DB=-1`, `AGC_LIMIT_RELEASE_ALPHA=0.05`.
  - `interface AgcOptions { targetDb: number; maxGainDb?: number; slewAlpha?: number; silenceDb?: number }`
  - `class TargetLoudnessAgc` — ctor `(sampleRate: number, opts: AgcOptions)`; `process(block: Float32Array, freeze?: boolean): Float32Array`; `reset(): void`; `get gainLinear(): number`.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-agc.test.ts
import { describe, it, expect } from 'vitest';
import { TargetLoudnessAgc } from '../src/live/agc.js';

function rms(x: Float32Array): number { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / Math.max(1, x.length)); }
function tone(n: number, amp: number): Float32Array { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * 300 * i) / 44100); return a; }

describe('TargetLoudnessAgc', () => {
  it('boosts a quiet signal toward the target loudness', () => {
    const agc = new TargetLoudnessAgc(44100, { targetDb: -20 }); // target RMS ~0.1
    const quiet = tone(256, 0.02);
    let out = new Float32Array(0);
    for (let b = 0; b < 80; b++) out = agc.process(tone(256, 0.02), false);
    expect(rms(out)).toBeGreaterThan(rms(quiet) * 1.5); // gain slewed up
    expect(agc.gainLinear).toBeGreaterThan(1);
  });

  it('attenuates a loud signal toward the target', () => {
    const agc = new TargetLoudnessAgc(44100, { targetDb: -20 });
    let out = new Float32Array(0);
    for (let b = 0; b < 80; b++) out = agc.process(tone(256, 0.5), false);
    expect(rms(out)).toBeLessThan(rms(tone(256, 0.5))); // gain slewed down
    expect(agc.gainLinear).toBeLessThan(1);
  });

  it('clamps the gain to ±maxGainDb', () => {
    const agc = new TargetLoudnessAgc(44100, { targetDb: 0, maxGainDb: 12 }); // target RMS 1.0
    for (let b = 0; b < 200; b++) agc.process(tone(256, 0.001), false); // extreme boost demand
    expect(agc.gainLinear).toBeLessThanOrEqual(Math.pow(10, 12 / 20) + 1e-6); // capped at +12 dB
  });

  it('holds the gain on silence (no pump)', () => {
    const agc = new TargetLoudnessAgc(44100, { targetDb: -20 });
    for (let b = 0; b < 40; b++) agc.process(tone(256, 0.05), false); // seed some gain
    const g0 = agc.gainLinear;
    for (let b = 0; b < 60; b++) agc.process(new Float32Array(256), false); // silence
    expect(agc.gainLinear).toBeCloseTo(g0, 6); // held, did not ramp up
  });

  it('slews gradually toward a new target when the level changes', () => {
    // ExponentialTracker seeds to the FIRST value, so a cold steady input jumps to its target on block 1.
    // The slew is observable on a LEVEL CHANGE: converge at one level, then drop the level and check the
    // gain moves only partway toward the new (higher) target in one alpha-0.15 step.
    const agc = new TargetLoudnessAgc(44100, { targetDb: -20, slewAlpha: 0.15 });
    for (let b = 0; b < 60; b++) agc.process(tone(256, 0.1), false); // converge at the louder level
    const gA = agc.gainLinear;
    agc.process(tone(256, 0.01), false); // level drops 10x → desired gain jumps up; gain must slew, not jump
    const g1 = agc.gainLinear;
    expect(g1).toBeGreaterThan(gA); // moving up toward the new target
    expect(g1).toBeLessThan(gA + (Math.pow(10, 18 / 20) - gA) * 0.5); // far short of the +18 dB clamp after one step
  });

  it('the peak limiter keeps the output peak at/under the ceiling', () => {
    const agc = new TargetLoudnessAgc(44100, { targetDb: 0 }); // big boost demand
    let out = new Float32Array(0);
    for (let b = 0; b < 200; b++) out = agc.process(tone(256, 0.4), false);
    expect(Math.max(...out.subarray(0).map(Math.abs))).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 0.02);
  });

  it('reset() clears the slew + limiter', () => {
    const mk = () => new TargetLoudnessAgc(44100, { targetDb: -20 });
    const x = () => tone(256, 0.05);
    const fresh = mk().process(x(), false);
    const re = mk();
    for (let b = 0; b < 30; b++) re.process(x(), false);
    re.reset();
    const after = re.process(x(), false);
    for (let i = 0; i < after.length; i++) expect(after[i]!).toBeCloseTo(fresh[i]!, 9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-agc.test.ts`
Expected: FAIL — module unresolved.

- [ ] **Step 3: Write the implementation**

```ts
// src/live/agc.ts
/**
 * Target-loudness automatic gain control: normalizes a mono block toward a target RMS
 * via a slewed scalar gain (one-pole EMA), held on silence (no floor pump), then a
 * peak limiter so a large boost never clips. Control-pure (output-RMS-driven only).
 * Pure, zero-dep. Port of the Python TargetLoudnessAgc.
 */
import { ExponentialTracker } from './exponential-tracker.js';

export const AGC_MAX_GAIN_DB = 18;
export const AGC_SLEW_ALPHA = 0.15;
export const AGC_SILENCE_DB = -55;
export const AGC_CEILING_DB = -1;
export const AGC_LIMIT_RELEASE_ALPHA = 0.05;

export interface AgcOptions {
  targetDb: number;
  maxGainDb?: number;
  slewAlpha?: number;
  silenceDb?: number;
}

export class TargetLoudnessAgc {
  private readonly targetRms: number;
  private readonly gainMax: number;
  private readonly gainMin: number;
  private readonly silenceRms: number;
  private readonly ceiling: number;
  private readonly slew: ExponentialTracker;
  private lim = 1;

  constructor(sampleRate: number, opts: AgcOptions) {
    void sampleRate;
    this.targetRms = Math.pow(10, opts.targetDb / 20);
    const maxGainDb = opts.maxGainDb ?? AGC_MAX_GAIN_DB;
    this.gainMax = Math.pow(10, maxGainDb / 20);
    this.gainMin = Math.pow(10, -maxGainDb / 20);
    this.silenceRms = Math.pow(10, (opts.silenceDb ?? AGC_SILENCE_DB) / 20);
    this.ceiling = Math.pow(10, AGC_CEILING_DB / 20);
    this.slew = new ExponentialTracker(opts.slewAlpha ?? AGC_SLEW_ALPHA);
  }

  /** Current slewed gain (linear) — for telemetry. */
  get gainLinear(): number {
    return this.slew.value;
  }

  process(block: Float32Array, freeze = false): Float32Array {
    let s = 0;
    for (const v of block) s += v * v;
    const blockRms = Math.sqrt(s / Math.max(1, block.length));
    let desired: number;
    if (freeze || blockRms <= this.silenceRms) {
      desired = this.slew.value || 1; // hold (1 before the slew is seeded; gain is never legitimately 0)
    } else {
      desired = Math.min(this.gainMax, Math.max(this.gainMin, this.targetRms / blockRms));
    }
    const g = this.slew.update(desired);
    const out = new Float32Array(block.length);
    for (let i = 0; i < block.length; i++) out[i] = block[i]! * g;
    // peak limiter: instant attack, slow release, ceiling (mirrors LevelPreservingCleaner)
    let peak = 0;
    for (const v of out) { const a = Math.abs(v); if (a > peak) peak = a; }
    const need = peak > this.ceiling ? this.ceiling / peak : 1;
    this.lim = need < this.lim ? need : this.lim + AGC_LIMIT_RELEASE_ALPHA * (Math.min(1, need) - this.lim);
    if (this.lim < 1) for (let i = 0; i < out.length; i++) out[i] *= this.lim;
    return out;
  }

  reset(): void {
    this.slew.reset();
    this.lim = 1;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/live-agc.test.ts`
Expected: PASS (7 tests). If the slew-rate test (gain-after-1-block) is marginal for a chosen target, keep `slewAlpha=0.15` and adjust only the test's bound — do NOT change the production `AGC_SLEW_ALPHA`.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/live/agc.ts test/live-agc.test.ts
git commit -m "feat(live): target-loudness AGC"
```

---

### Task 2: Wire opt-in AGC into the LiveEngine (`engine.ts`, `types.ts`, `index.ts`)

**Files:**
- Modify: `src/live/types.ts`, `src/live/engine.ts`, `src/live/index.ts`
- Test: `test/live-engine.test.ts` (append)

**Interfaces:**
- Consumes: `TargetLoudnessAgc` (Task 1).
- Produces: `AgcConfig`; `LiveConfig.agc?`; `BeamOutput.agc?`.

- [ ] **Step 1: Write the failing test**

```ts
// test/live-engine.test.ts (append a new describe)
describe('LiveEngine AGC (Phase 3d-1)', () => {
  const geom = sensibel8(0.04);
  function mock() { return new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 60, blockSize: 256, freqHz: 1500 }); }

  it('agc absent ⇒ no agc field (byte-identical to Phase 3c)', async () => {
    const engine = new LiveEngine(mock(), { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90 });
    let agcField: unknown = 'unset';
    engine.onOutput((o) => { agcField = (o as { agc?: unknown }).agc; });
    await engine.start();
    expect(agcField).toBeUndefined();
  });

  it('agc config ⇒ BeamOutput.agc surfaces gainLinear and runs', async () => {
    const engine = new LiveEngine(mock(), { geom, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90, agc: { targetDb: -20 } });
    let agc: unknown = 'unset';
    engine.onOutput((o) => { agc = (o as { agc?: unknown }).agc; });
    await engine.start();
    expect(agc).toBeDefined();
    expect(typeof (agc as { gainLinear: number }).gainLinear).toBe('number');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/live-engine.test.ts`
Expected: FAIL — `agc` not accepted on `LiveConfig` / no `agc` field emitted.

- [ ] **Step 3: Extend the types**

In `src/live/types.ts`, add:
```ts
export interface AgcConfig {
  targetDb: number;
  maxGainDb?: number;
  slewAlpha?: number;
  silenceDb?: number;
}
```
Add to `LiveConfig` (after `aec?: AecConfig;`): `agc?: AgcConfig;`
Add to `BeamOutput` (after `aec?: { erleDb: number; farendActive: boolean };`): `agc?: { gainLinear: number };`

- [ ] **Step 4: Extend the engine**

In `src/live/engine.ts`, add the import:
```ts
import { TargetLoudnessAgc } from './agc.js';
import type { AgcConfig } from './types.js';
```
Add a field (alongside the existing privates, e.g. after `private aec: …`):
```ts
  private agc: TargetLoudnessAgc | null = null;
```
In the constructor (after the AEC-build block), build the AGC when configured:
```ts
    const agcCfg: AgcConfig | undefined = config.agc;
    if (agcCfg !== undefined) {
      this.agc = new TargetLoudnessAgc(config.sampleRate ?? 44100, agcCfg);
    }
```
In `onBlock`, **after** the cleaner stage (the `if (this.cleaner) { … }` block) and **before** `this.meter.update(mono);`, insert:
```ts
        // Phase 3d-1: target-loudness AGC on the cleaned mono (before the meter).
        if (this.agc) mono = this.agc.process(mono, false);
```
In the emitted `BeamOutput` object (next to the `cleaning`/`aec` spreads), add:
```ts
          ...(this.agc ? { agc: { gainLinear: this.agc.gainLinear } } : {}),
```

- [ ] **Step 5: Export the new surface**

In `src/live/index.ts`, append:
```ts
export { TargetLoudnessAgc, AGC_MAX_GAIN_DB, AGC_SLEW_ALPHA, AGC_SILENCE_DB, AGC_CEILING_DB, AGC_LIMIT_RELEASE_ALPHA, type AgcOptions } from './agc.js';
export type { AgcConfig } from './types.js';
```

- [ ] **Step 6: Run test + full gate**

Run: `npx vitest run test/live-engine.test.ts && npm run typecheck && npm test && npm run build`
Expected: the 2 new tests PASS; the existing Phase-3a/3b/3c engine tests still PASS (no `agc` key when off); `tsc` clean; full suite green; build emits `dist/`. Fix any unused-import issue at the barrel without casts.

- [ ] **Step 7: Commit**

```bash
git add src/live/types.ts src/live/engine.ts src/live/index.ts test/live-engine.test.ts
git commit -m "feat(live): wire opt-in AGC into LiveEngine"
```

---

### Task 3: Docs (README + CHANGELOG + CLAUDE.md) + final gate

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: README — add an AGC subsection**

Append after the Phase-3c echo-cancellation subsection in `README.md`:
```markdown
### Loudness AGC (Phase 3d-1)

Opt-in target-loudness normalization on the cleaned mono so the far side hears a consistent level:

```ts
const engine = new LiveEngine(new NodeCaptureAdapter(), {
  geom, deviceName: 'SB-POLARIS', sampleRate: 44100,
  cleaning: { engine: 'omlsa' },
  agc: { targetDb: -20 },   // normalize toward -20 dBFS RMS
});
```

- `agc: { targetDb, maxGainDb?, slewAlpha?, silenceDb? }` — a slewed scalar gain toward `targetDb` RMS,
  clamped to ±`maxGainDb` (default 18 dB), held on silence (default −55 dB) so it never pumps the noise floor,
  and peak-limited (−1 dB ceiling) so a large boost never clips. `BeamOutput.agc.gainLinear` is the applied gain.
- It runs after the cleaning chain (matching the Python order). Omitting `agc` is byte-identical to Phase 3c.

Still zero-dependency (reuses the existing one-pole tracker). **Honest limits:** a control-pure one-pole loudness
gain, not an EBU-R128 / multiband processor; no transient-duck `freeze` yet (no transient stage in TS). PEQ,
band-limit, and voice-gate are the remaining 3d sub-phases.
```

- [ ] **Step 2: CHANGELOG — add an `[Unreleased] > Added` bullet**

```markdown
- **Target-loudness AGC (Phase 3d-1)** — opt-in `TargetLoudnessAgc` (`agc.ts`) normalizes the cleaned mono
  toward a target RMS via a slewed scalar gain (reuses the existing `ExponentialTracker`), held on silence and
  peak-limited (−1 dB) so it never pumps the floor or clips. Runs after the cleaning chain, before the meter.
  Wired through `LiveConfig.agc` (default off = Phase-3c behavior); `BeamOutput.agc` surfaces the applied
  `gainLinear` (omit-when-absent). Pure DSP — no new dependency. Ported from the Python `TargetLoudnessAgc`.
  PEQ / band-limit / voice-gate are the remaining 3d sub-phases.
```

- [ ] **Step 3: CLAUDE.md — add a note**

Append to the live-audio architecture bullets in `CLAUDE.md`:
```markdown
- **Loudness AGC (Phase 3d-1, `src/live/agc.ts`).** A `TargetLoudnessAgc` normalizes the cleaned mono toward a
  target RMS with a slewed gain (reuses `ExponentialTracker`), silence-held and peak-limited; runs after the
  cleaner, before the meter. Opt-in `LiveConfig.agc` (default off = Phase-3c unchanged); `BeamOutput.agc`
  surfaces `gainLinear`. PEQ / band-limit / voice-gate are the remaining 3d-2/3d-3 sub-phases.
```

- [ ] **Step 4: Final gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: `tsc` clean; ALL tests pass (existing + the new Phase-3d-1 tests); build emits `dist/live/`.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md CLAUDE.md
git commit -m "docs: document Phase 3d-1 target-loudness AGC"
```

---

## Self-Review

**Spec coverage:** `TargetLoudnessAgc` (RMS → clamped target ratio → slew → silence-hold → peak limiter; reset; gainLinear) (Task 1); `LiveConfig.agc` + `BeamOutput.agc` omit-when-absent + the after-cleaner-before-meter stage + off-byte-identical (Task 2); honest-limits docs (Task 3). The held-gain guard, the ±maxGainDb clamp, and the peak-limiter reuse are covered.

**Placeholder scan:** none — every code/test step has complete code and exact commands.

**Type consistency:** `TargetLoudnessAgc`/`AgcOptions`/`AGC_*` (Task 1) are consumed by Task 2; `process(block, freeze?)`/`reset`/`gainLinear` match between Task 1 and the Task-2 engine use; `AgcConfig` (Task 2) gates the engine; `gainLinear` is the field surfaced in `BeamOutput.agc`.

**Implementer notes:** (1) the held-gain guard is `this.slew.value || 1` — needed so the first/silent block isn't muted (the tracker is 0 before seeding). (2) The peak-limiter release goes toward `min(1, need)` (the corrected `LevelPreservingCleaner` arm) — keep that. (3) `BeamOutput.agc` MUST be omit-when-absent — the existing Phase-3a/3b/3c engine tests assert no extra keys when off; if one fails, the spread wasn't used. (4) The AGC stage goes after the `if (this.cleaner)` block and before `this.meter.update(mono)`; `mono` is already `let`. (5) `freeze` is hard-`false` from the engine (no transient stage in TS).
