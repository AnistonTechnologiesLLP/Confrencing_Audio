# Live audio — Phase 3d-3 (voice-gate + band-limit) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the final two opt-in stages to the live cleaning chain — a level-invariant voice-only output gate (with its syllabic-modulation speech-presence scorer) and a speech band-limit that reuses the Phase-3d-2 PEQ.

**Architecture:** A pure `SpeechPresenceScorer` (`src/live/speech-presence.ts`, three one-pole EMAs) feeds a `StreamingVoiceGate` (`src/live/voice-gate.ts`, fast-attack/slow-release duck, onset-safe, in-block ramp). Both wire into `LiveEngine.onBlock`; the voice-gate runs **last** (after the AGC). The band-limit is an opt-in config that reuses `StreamingPeq` (a dedicated HP+LP instance) running **before** the user PEQ — no new DSP module. All opt-in; default off = byte-identical.

**Tech Stack:** TypeScript ESM (strict), vitest, zero runtime dependencies.

## Global Constraints

- **Zero runtime dependencies** — `dependencies` stays `{}`. Scorer + gate are pure; band-limit reuses the existing biquad.
- **`src/live/` is browser-safe** — NO `node:*`/`Buffer`.
- **Relative imports carry `.js`**; `import type` for type-only imports (`verbatimModuleSyntax`).
- **No `as` casts.** Non-null `!` is allowed (required by `noUncheckedIndexedAccess`).
- **`exactOptionalPropertyTypes`** — optional fields via omit-when-absent spread (`...(x !== undefined ? { x } : {})`), never `{ x: undefined }`.
- **`noUnusedLocals`/`noUnusedParameters`** — ignored params referenced via `void param;`.
- **Default-off byte-identical** — no `voiceGate`/`bandLimit` config ⇒ no stage built, `BeamOutput` unchanged. Existing Phase-3a..3d-2 engine-shape tests stay green.
- **DSP math in Float64**, output `Float32`.
- Gates: `npm run typecheck`, `npm test`, `npm run build` all green. Hardware-free tests.

---

### Task 1: `SpeechPresenceScorer` — syllabic-modulation speech score

**Files:**
- Create: `src/live/speech-presence.ts`
- Test: `test/live-speech-presence.test.ts`

**Interfaces:**
- Produces (used by Task 2 + tests):
  - `function alphaFor(hopSeconds: number, tauSeconds: number): number`
  - `class SpeechPresenceScorer { constructor(opts?: SpeechPresenceOptions); update(rms: number, noiseFloor?: number): number; reset(): void; }`
  - `interface SpeechPresenceOptions { hopSeconds?: number; tauFast?: number; tauSlow?: number; tauMod?: number; modRef?: number }`
  - constants `VG_HOP_SECONDS=0.032`, `VG_TAU_FAST=0.03`, `VG_TAU_SLOW=0.15`, `VG_TAU_MOD=0.30`, `VG_MOD_REF=0.25`, `VG_LEVEL_FLOOR=1e-4`

**Reference:** `conf_pipeline_control/multikit.py` (`SpeechPresenceScorer`, `_alpha`, the `DEFAULT_*` constants).

- [ ] **Step 1: Write the failing test**

Create `test/live-speech-presence.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SpeechPresenceScorer, alphaFor, VG_MOD_REF } from '../src/live/speech-presence.js';

/** Feed a sequence of per-hop RMS values, return the final score. */
function runScore(scorer: SpeechPresenceScorer, rms: number[]): number {
  let s = 0;
  for (const r of rms) s = scorer.update(r);
  return s;
}

/** A modulated RMS envelope: alternates between hi and lo every `period` hops (syllabic-ish). */
function modulated(hi: number, lo: number, period: number, hops: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < hops; i++) out.push(Math.floor(i / period) % 2 === 0 ? hi : lo);
  return out;
}

describe('alphaFor', () => {
  it('returns 1 for tau <= 0 and a value in (0,1) for positive tau', () => {
    expect(alphaFor(0.032, 0)).toBe(1);
    expect(alphaFor(0.032, -1)).toBe(1);
    const a = alphaFor(0.032, 0.15);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
  });
});

describe('SpeechPresenceScorer', () => {
  it('scores a STEADY envelope near zero (well below the 0.35 speech threshold)', () => {
    const scorer = new SpeechPresenceScorer();
    const steady = new Array(200).fill(0.1);
    expect(runScore(scorer, steady)).toBeLessThan(0.1);
  });

  it('scores a MODULATED (syllabic) envelope high and crosses the threshold', () => {
    const scorer = new SpeechPresenceScorer();
    // ~5 Hz modulation at a 0.032 s hop ≈ a 6-hop period; run long enough for the EMAs to settle.
    const score = runScore(scorer, modulated(0.3, 0.03, 3, 300));
    expect(score).toBeGreaterThan(0.35);
  });

  it('is level-invariant — scaling the envelope 10x leaves the score ~unchanged', () => {
    const seq = modulated(0.3, 0.03, 3, 300);
    const a = runScore(new SpeechPresenceScorer(), seq);
    const b = runScore(new SpeechPresenceScorer(), seq.map((r) => r * 10));
    expect(Math.abs(a - b)).toBeLessThan(0.05);
  });

  it('reset() zeroes state — re-feeding reproduces the run', () => {
    const scorer = new SpeechPresenceScorer();
    const seq = modulated(0.3, 0.03, 3, 120);
    const first = runScore(scorer, seq);
    runScore(scorer, seq); // dirty
    scorer.reset();
    const again = runScore(scorer, seq);
    expect(again).toBeCloseTo(first, 10);
    expect(VG_MOD_REF).toBe(0.25);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/live-speech-presence.test.ts`
Expected: FAIL — `Cannot find module '../src/live/speech-presence.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/live/speech-presence.ts`:

```ts
/** Default block cadence the scorer's EMA alphas are derived for (~32 ms). */
export const VG_HOP_SECONDS = 0.032;
/** Fast envelope EMA time constant (upper syllabic corner), seconds. */
export const VG_TAU_FAST = 0.03;
/** Slow envelope EMA time constant (DC / lower corner), seconds. */
export const VG_TAU_SLOW = 0.15;
/** Smoothing time constant for the rectified band-passed envelope, seconds. */
export const VG_TAU_MOD = 0.3;
/** Modulation depth that maps to a full (1.0) speech score. */
export const VG_MOD_REF = 0.25;
/** Guards the modulation-depth denominator at silence. */
export const VG_LEVEL_FLOOR = 1e-4;

export interface SpeechPresenceOptions {
  hopSeconds?: number;
  tauFast?: number;
  tauSlow?: number;
  tauMod?: number;
  modRef?: number;
}

/** One-pole EMA coefficient for a time constant `tau` at the given hop cadence. */
export function alphaFor(hopSeconds: number, tauSeconds: number): number {
  if (tauSeconds <= 0) return 1;
  return 1 - Math.exp(-hopSeconds / tauSeconds);
}

/**
 * Per-hop, level-invariant speech-vs-steady-noise score in `[0, 1]` from the output RMS
 * envelope. A difference-of-EMAs band-pass on the envelope (≈3-8 Hz syllabic band) divided
 * by the slow level: a steady fan is near-DC → ~0; a louder fan does not help because level
 * is the denominator. Pure (no FFT). Port of `multikit.py:SpeechPresenceScorer`.
 */
export class SpeechPresenceScorer {
  private readonly aFast: number;
  private readonly aSlow: number;
  private readonly aMod: number;
  private readonly modRef: number;
  private fast = 0;
  private slow = 0;
  private mod = 0;

  constructor(opts: SpeechPresenceOptions = {}) {
    const hop = opts.hopSeconds ?? VG_HOP_SECONDS;
    this.aFast = alphaFor(hop, opts.tauFast ?? VG_TAU_FAST);
    this.aSlow = alphaFor(hop, opts.tauSlow ?? VG_TAU_SLOW);
    this.aMod = alphaFor(hop, opts.tauMod ?? VG_TAU_MOD);
    this.modRef = Math.max(1e-6, opts.modRef ?? VG_MOD_REF);
  }

  /** Fold one hop's output RMS in and return the speech-presence score. */
  update(rms: number, noiseFloor = 0): number {
    const env = rms > 0 ? rms : 0;
    this.fast += this.aFast * (env - this.fast);
    this.slow += this.aSlow * (env - this.slow);
    const bp = this.fast - this.slow; // band-passed envelope (~syllabic)
    this.mod += this.aMod * (Math.abs(bp) - this.mod); // smoothed modulation energy
    const level = Math.max(this.slow, noiseFloor, VG_LEVEL_FLOOR);
    return Math.min(1, this.mod / level / this.modRef);
  }

  reset(): void {
    this.fast = 0;
    this.slow = 0;
    this.mod = 0;
  }
}
```

- [ ] **Step 4: Run the test + typecheck**

Run: `npx vitest run test/live-speech-presence.test.ts && npm run typecheck`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add src/live/speech-presence.ts test/live-speech-presence.test.ts
git commit -m "feat(live): syllabic-modulation speech-presence scorer"
```

---

### Task 2: `StreamingVoiceGate` — voice-only output gate

**Files:**
- Create: `src/live/voice-gate.ts`
- Test: `test/live-voice-gate.test.ts`

**Interfaces:**
- Consumes: `SpeechPresenceScorer` from `./speech-presence.js`.
- Produces (used by Task 3 + tests):
  - `class StreamingVoiceGate { constructor(sampleRate: number, opts?: VoiceGateOptions); process(block: Float32Array, noiseGate?: boolean): Float32Array; reset(): void; get gateOpen(): boolean; get reductionDb(): number; get score(): number; }`
  - `interface VoiceGateOptions { threshold?: number; floorDb?: number; attackMs?: number; releaseMs?: number; modRef?: number }`
  - constants `VG_THRESHOLD=0.35`, `VG_FLOOR_DB=-15`, `VG_ATTACK_MS=8`, `VG_RELEASE_MS=180`

**Reference:** `conf_pipeline_control/voice_gate.py` (`VoiceOnlyGate`).

- [ ] **Step 1: Write the failing test**

Create `test/live-voice-gate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { StreamingVoiceGate } from '../src/live/voice-gate.js';

const FS = 44100;
const N = 1412; // ~32 ms hop at 44.1 kHz (so hopSeconds matches the scorer's default cadence closely)

function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / x.length);
}

/** A block of white-ish noise at a given amplitude (deterministic LCG — no Math.random). */
function noiseBlock(n: number, amp: number, seed: number): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (1664525 * s + 1013904223) >>> 0;
    out[i] = amp * ((s / 0xffffffff) * 2 - 1);
  }
  return out;
}

describe('StreamingVoiceGate', () => {
  it('ducks a STEADY signal toward the floor over time', () => {
    const gate = new StreamingVoiceGate(FS);
    let out = new Float32Array(N);
    for (let b = 0; b < 80; b++) out = gate.process(noiseBlock(N, 0.2, b + 1));
    // steady (non-speech) → score stays low → gain ducks toward 10^(-15/20) ≈ 0.178
    expect(gate.gateOpen).toBe(false);
    expect(gate.reductionDb).toBeGreaterThan(6);
    expect(rms(out)).toBeLessThan(0.2 * 0.4); // clearly attenuated vs the 0.2-amp input
  });

  it('opens immediately on a sudden loud onset (onset branch)', () => {
    const gate = new StreamingVoiceGate(FS);
    // settle quiet first
    for (let b = 0; b < 10; b++) gate.process(noiseBlock(N, 0.001, b + 1));
    const out = gate.process(noiseBlock(N, 0.5, 999)); // 500x louder → onset
    // the onset block is NOT floored: its output is close to full gain, not ducked
    expect(rms(out)).toBeGreaterThan(0.5 * 0.5);
  });

  it('the floor is a duck, not a mute (never silences)', () => {
    const gate = new StreamingVoiceGate(FS, { floorDb: -15 });
    let out = new Float32Array(N);
    for (let b = 0; b < 120; b++) out = gate.process(noiseBlock(N, 0.2, b + 1));
    expect(rms(out)).toBeGreaterThan(0); // ducked, never zero
    // ducked output RMS is on the order of floor * input (well above silence)
    expect(rms(out)).toBeGreaterThan(0.2 * Math.pow(10, -15 / 20) * 0.5);
  });

  it('attack is faster than release (gain moves up faster than down per block)', () => {
    const gate = new StreamingVoiceGate(FS);
    // Force a closed gate (steady), then measure one opening step vs one closing step.
    for (let b = 0; b < 80; b++) gate.process(noiseBlock(N, 0.2, b + 1));
    const gClosed = readGain(gate);
    gate.process(loud(N)); // onset opens → big upward step
    const gAfterOpen = readGain(gate);
    const up = gAfterOpen - gClosed;
    // now let it close again from open
    const gate2 = new StreamingVoiceGate(FS);
    gate2.process(loud(N)); // open
    const gOpen = readGain(gate2);
    for (let b = 0; b < 1; b++) gate2.process(noiseBlock(N, 0.2, b + 1)); // one steady block → downward step
    const down = gOpen - readGain(gate2);
    expect(up).toBeGreaterThan(down); // fast attack > slow release per block
  });

  it('uses constant gain on a 1-sample block (no divide-by-zero)', () => {
    const gate = new StreamingVoiceGate(FS);
    const one = new Float32Array([0.5]);
    const out = gate.process(one);
    expect(Number.isFinite(out[0]!)).toBe(true);
  });

  it('returns the same object on an empty block', () => {
    const gate = new StreamingVoiceGate(FS);
    const empty = new Float32Array(0);
    expect(gate.process(empty)).toBe(empty);
  });

  it('reset() restores an open gate', () => {
    const gate = new StreamingVoiceGate(FS);
    for (let b = 0; b < 80; b++) gate.process(noiseBlock(N, 0.2, b + 1)); // duck it closed
    gate.reset();
    expect(gate.gateOpen).toBe(true);
    expect(gate.reductionDb).toBe(0);
    expect(gate.score).toBe(1);
  });
});

/** A loud full-scale-ish block (triggers the onset branch). */
function loud(n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.8 * Math.sin((2 * Math.PI * 300 * i) / FS);
  return out;
}

/** Read the gate's current internal gain via a 1-sample probe at unity input. */
function readGain(gate: StreamingVoiceGate): number {
  // process a 1-sample unity block WITHOUT advancing state meaningfully is not possible;
  // instead infer gain from reductionDb (gain = 10^(-reductionDb/20)) — open ⇒ 0 dB ⇒ gain 1.
  return Math.pow(10, -gate.reductionDb / 20);
}
```

NOTE to the implementer: the `readGain`/attack-vs-release test infers gain from `reductionDb`. If that proves too indirect to be reliable, replace that single test with a direct one that asserts the **attack reaches near-unity within a few blocks of an onset** while the **release takes many more blocks to fall to the floor** (count blocks to cross a midpoint) — the requirement is "attack faster than release", proven however is most robust. Keep the other six tests as written.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/live-voice-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/live/voice-gate.ts`:

```ts
import { SpeechPresenceScorer } from './speech-presence.js';

/** Speech-presence score above which the gate is fully open. */
export const VG_THRESHOLD = 0.35;
/** Shallow floor (duck, NOT mute) so a missed onset is recoverable, dB. */
export const VG_FLOOR_DB = -15;
/** Fast attack — open quickly on returning speech (onset-safe), ms. */
export const VG_ATTACK_MS = 8;
/** Slow release — hold open through brief intra-phrase pauses, ms. */
export const VG_RELEASE_MS = 180;

export interface VoiceGateOptions {
  threshold?: number;
  floorDb?: number;
  attackMs?: number;
  releaseMs?: number;
  modRef?: number;
}

/**
 * Streaming "voice only" output gate: attenuate non-speech toward a shallow floor with a
 * FAST attack / SLOW release, driven by the level-invariant syllabic-modulation scorer.
 * Runs LAST (after the AGC). Onset-safe (a sharp level rise opens it before the scorer
 * confirms) and shallow (a duck, not a mute). Port of `voice_gate.py:VoiceOnlyGate`.
 */
export class StreamingVoiceGate {
  private readonly fs: number;
  private readonly threshold: number;
  private readonly floor: number;
  private readonly attackMs: number;
  private readonly releaseMs: number;
  private readonly modRef: number | undefined;
  private scorer: SpeechPresenceScorer | null = null;
  private scorerHop = 0;
  private gain = 1;
  private prevRms = 0;
  private _gateOpen = true;
  private _reductionDb = 0;
  private _score = 1;

  constructor(sampleRate: number, opts: VoiceGateOptions = {}) {
    this.fs = sampleRate;
    this.threshold = opts.threshold ?? VG_THRESHOLD;
    this.floor = Math.pow(10, (opts.floorDb ?? VG_FLOOR_DB) / 20);
    this.attackMs = Math.max(0.1, opts.attackMs ?? VG_ATTACK_MS);
    this.releaseMs = Math.max(0.1, opts.releaseMs ?? VG_RELEASE_MS);
    this.modRef = opts.modRef;
  }

  /** Rebuild the scorer when the block cadence changes (the EMA alphas depend on hopSeconds). */
  private ensure(hopSeconds: number): void {
    if (this.scorer !== null && Math.abs(hopSeconds - this.scorerHop) < 1e-5) return;
    this.scorer = new SpeechPresenceScorer({
      hopSeconds,
      ...(this.modRef !== undefined ? { modRef: this.modRef } : {}),
    });
    this.scorerHop = hopSeconds;
  }

  process(block: Float32Array, noiseGate?: boolean): Float32Array {
    void noiseGate;
    const n = block.length;
    if (n === 0) return block;
    const hopSeconds = n / this.fs;
    this.ensure(hopSeconds);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += block[i]! * block[i]!;
    const rms = Math.sqrt(sum / n);
    this._score = this.scorer!.update(rms);
    // open on speech, OR on a sharp level rise (anticipate a just-started talker — protect the first syllable)
    const onset = rms > 3 * Math.max(this.prevRms, 1e-6);
    this.prevRms = rms;
    const target = this._score >= this.threshold || onset ? 1 : this.floor;
    const tauMs = target > this.gain ? this.attackMs : this.releaseMs; // fast attack / slow release
    const a = 1 - Math.exp(-hopSeconds / Math.max(1e-4, tauMs / 1000));
    const gNew = this.gain + a * (target - this.gain);
    const out = new Float32Array(n);
    if (n === 1) {
      out[0] = block[0]! * gNew;
    } else {
      const step = (gNew - this.gain) / (n - 1); // de-click: linear ramp across the block
      for (let i = 0; i < n; i++) out[i] = block[i]! * (this.gain + step * i);
    }
    this.gain = gNew;
    this._gateOpen = gNew > 0.5;
    this._reductionDb = gNew < 0.999 ? -20 * Math.log10(Math.max(gNew, 1e-6)) : 0;
    return out;
  }

  reset(): void {
    this.scorer = null;
    this.scorerHop = 0;
    this.gain = 1;
    this.prevRms = 0;
    this._gateOpen = true;
    this._reductionDb = 0;
    this._score = 1;
  }

  get gateOpen(): boolean {
    return this._gateOpen;
  }

  get reductionDb(): number {
    return this._reductionDb;
  }

  get score(): number {
    return this._score;
  }
}
```

- [ ] **Step 4: Run the test + typecheck**

Run: `npx vitest run test/live-voice-gate.test.ts && npm run typecheck`
Expected: PASS + clean. (If the attack-vs-release test is flaky via `reductionDb`, switch it to the blocks-to-cross-midpoint form described in the test note — still proving attack < release in block count.)

- [ ] **Step 5: Commit**

```bash
git add src/live/voice-gate.ts test/live-voice-gate.test.ts
git commit -m "feat(live): voice-only output gate"
```

---

### Task 3: Wire band-limit (PEQ reuse) + voice-gate into `LiveEngine`

**Files:**
- Modify: `src/live/types.ts` (add `BandLimitConfig`, `VoiceGateConfig`, `LiveConfig.bandLimit?`/`voiceGate?`, `BeamOutput.voiceGate?`)
- Modify: `src/live/engine.ts` (build + run band-limit before the PEQ, voice-gate last)
- Modify: `src/live/index.ts` (export the new surface)
- Test: `test/live-engine-voicegate.test.ts`

**Interfaces:**
- Consumes: `StreamingPeq` from `./peq.js` (already imported), `StreamingVoiceGate` from `./voice-gate.js`, `PeqBand` from `../model/dsp-blocks.js`.
- Produces: `interface BandLimitConfig { highpassHz?: number; lowpassHz?: number }`; `interface VoiceGateConfig { threshold?: number; floorDb?: number; attackMs?: number; releaseMs?: number; modRef?: number }`; `LiveConfig.bandLimit?`/`voiceGate?`; `BeamOutput.voiceGate?: { open: boolean; reductionDb: number; score: number }`.

- [ ] **Step 1: Write the failing test**

Create `test/live-engine-voicegate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { LiveEngine } from '../src/live/engine.js';
import { MockCaptureAdapter } from '../src/live/mock-adapter.js';
import { sensibel8 } from '../src/beamformer/geometry.js';
import type { BeamOutput, LiveConfig } from '../src/live/types.js';

const GEOM = sensibel8(0.04);

async function run(extra: Partial<LiveConfig>, blocks = 20): Promise<BeamOutput[]> {
  const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks, blockSize: 512, freqHz: 1000 });
  const engine = new LiveEngine(mock, { geom: GEOM, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 90, ...extra });
  const outs: BeamOutput[] = [];
  engine.onOutput((o) => outs.push(o));
  await engine.start();
  return outs;
}

describe('LiveEngine voice-gate + band-limit wiring', () => {
  it('absent voiceGate + bandLimit emits no voiceGate field (byte-identical shape)', async () => {
    const outs = await run({});
    expect(outs.length).toBeGreaterThan(0);
    for (const o of outs) expect('voiceGate' in o).toBe(false);
  });

  it('voiceGate config emits { open, reductionDb, score } and runs without throwing', async () => {
    const outs = await run({ voiceGate: {} });
    expect(outs.length).toBeGreaterThan(0);
    const last = outs.at(-1)!;
    expect(last.voiceGate).toBeDefined();
    expect(typeof last.voiceGate!.open).toBe('boolean');
    expect(typeof last.voiceGate!.reductionDb).toBe('number');
    expect(typeof last.voiceGate!.score).toBe('number');
  });

  it('bandLimit config runs, attenuates out-of-band energy, and adds no BeamOutput field', async () => {
    // a 1 kHz beam tone; a low-pass at 400 Hz should drop it hard vs no band-limit
    const ref = await run({});
    const lp = await run({ bandLimit: { lowpassHz: 400 } });
    const refRms = ref.at(-1)!.rmsDb;
    const lpRms = lp.at(-1)!.rmsDb;
    expect(lpRms).toBeLessThan(refRms - 6); // 1 kHz tone strongly attenuated below a 400 Hz LP
    for (const o of lp) expect('bandLimit' in o).toBe(false); // band-limit has no telemetry field
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/live-engine-voicegate.test.ts`
Expected: FAIL — `voiceGate`/`bandLimit` not assignable to `LiveConfig`.

- [ ] **Step 3: Add the config + telemetry types**

In `src/live/types.ts`:
1. Ensure `PeqBand` is importable — it is only needed in `engine.ts`, not here. In `types.ts` add the two config interfaces near `AgcConfig`:

```ts
/** Opt-in speech band-limit: a gentle HP and/or LP (reuses the PEQ biquads). At least one cutoff to be active. */
export interface BandLimitConfig {
  highpassHz?: number;
  lowpassHz?: number;
}

/** Opt-in voice-only output gate config. */
export interface VoiceGateConfig {
  threshold?: number;
  floorDb?: number;
  attackMs?: number;
  releaseMs?: number;
  modRef?: number;
}
```

2. Add to `LiveConfig` (after `agc?: AgcConfig;` / `peq?: PeqConfig;`):

```ts
  bandLimit?: BandLimitConfig;
  voiceGate?: VoiceGateConfig;
```

3. Add to `BeamOutput` (next to the existing `agc?: { gainLinear: number };`):

```ts
  voiceGate?: { open: boolean; reductionDb: number; score: number };
```

- [ ] **Step 4: Build + run the stages in the engine**

In `src/live/engine.ts`:

1. Add imports (near the `StreamingPeq` import):

```ts
import { StreamingVoiceGate } from './voice-gate.js';
import type { PeqBand } from '../model/dsp-blocks.js';
```

2. Add fields (next to `private peq: StreamingPeq | null = null;`):

```ts
  private bandLimit: StreamingPeq | null = null;
  private voiceGate: StreamingVoiceGate | null = null;
```

3. In the constructor, build the band-limit **before** the PEQ build, and the voice-gate after the AGC build:

```ts
    if (config.bandLimit) {
      const bands: PeqBand[] = [];
      if (config.bandLimit.highpassHz !== undefined) {
        bands.push({ type: 'highpass', freqHz: config.bandLimit.highpassHz, gainDb: 0, q: 0.7071067811865476 });
      }
      if (config.bandLimit.lowpassHz !== undefined) {
        bands.push({ type: 'lowpass', freqHz: config.bandLimit.lowpassHz, gainDb: 0, q: 0.7071067811865476 });
      }
      if (bands.length > 0) this.bandLimit = new StreamingPeq(config.sampleRate ?? 44100, bands);
    }
```

```ts
    if (config.voiceGate) {
      this.voiceGate = new StreamingVoiceGate(config.sampleRate ?? 44100, config.voiceGate);
    }
```

4. In `onBlock`, insert the band-limit **before** the PEQ line and the voice-gate **after** the AGC line (before `this.meter.update(mono)`):

```ts
        // Phase 3d-3: speech band-limit (reuses the PEQ) — trim out-of-band rumble/hiss before tone + level.
        if (this.bandLimit) mono = this.bandLimit.process(mono);
```
(place immediately above `if (this.peq) mono = this.peq.process(mono);`)

```ts
        // Phase 3d-3: voice-only output gate — duck non-speech (runs LAST, after the AGC).
        if (this.voiceGate) mono = this.voiceGate.process(mono);
```
(place immediately below `if (this.agc) mono = this.agc.process(mono, false);` and above `this.meter.update(mono);`)

5. In the `cb?.({ … })` emit object, add (next to the `agc` spread):

```ts
          ...(this.voiceGate ? { voiceGate: { open: this.voiceGate.gateOpen, reductionDb: this.voiceGate.reductionDb, score: this.voiceGate.score } } : {}),
```

- [ ] **Step 5: Export the surface**

In `src/live/index.ts`, after the PEQ exports, add:

```ts
export { SpeechPresenceScorer, alphaFor, VG_HOP_SECONDS, VG_TAU_FAST, VG_TAU_SLOW, VG_TAU_MOD, VG_MOD_REF, VG_LEVEL_FLOOR, type SpeechPresenceOptions } from './speech-presence.js';
export { StreamingVoiceGate, VG_THRESHOLD, VG_FLOOR_DB, VG_ATTACK_MS, VG_RELEASE_MS, type VoiceGateOptions } from './voice-gate.js';
export type { BandLimitConfig, VoiceGateConfig } from './types.js';
```

- [ ] **Step 6: Run the new test + typecheck**

Run: `npx vitest run test/live-engine-voicegate.test.ts && npm run typecheck`
Expected: PASS + clean. If the band-limit attenuation in the third test is weaker than −6 dB (the beamformed mono of a single tone can already be low), strengthen the band-limit (e.g. `lowpassHz: 300`) or assert the measured difference — but it MUST prove the band-limit changes the level; do not weaken to a trivial assertion. Report what you measured.

- [ ] **Step 7: Run the full suite + build**

Run: `npm test && npm run build`
Expected: all green (existing Phase-3a..3d-2 engine-shape tests still pass — `voiceGate`/`bandLimit` absent ⇒ no fields).

- [ ] **Step 8: Commit**

```bash
git add src/live/types.ts src/live/engine.ts src/live/index.ts test/live-engine-voicegate.test.ts
git commit -m "feat(live): wire opt-in band-limit (PEQ reuse) + voice-gate into LiveEngine"
```

---

## Notes for the controller

- **No docs task here.** README/CHANGELOG/CLAUDE.md for the whole Phase-3d tier are one commit at PR time.
- **Whole-branch review:** after 3d-3, run ONE multi-lens adversarial review over the full Phase-3d tier (AGC + PEQ + band-limit + voice-gate) before the PR — the DSP-math lens verifies the RBJ biquads + the scorer EMAs + the gate's attack/release; the rt-integration lens verifies stage order + byte-identical-off; the test lens checks coverage.
- **Stacking:** all 3d commits land on `feat/live-audio-phase3d1-agc`; one combined PR at the end.

## Self-review (done)

- **Spec coverage:** Task 1 = scorer (§2.1), Task 2 = voice-gate (§2.2), Task 3 = band-limit-via-PEQ + voice-gate wiring + telemetry (§2.3). The scope correction (§0) — band-limit is PEQ reuse, no new module — is reflected in Task 3 (no `voice-gate`-sibling band-limit module).
- **Placeholders:** none — full code in every step.
- **Type consistency:** `SpeechPresenceScorer`/`alphaFor`/`SpeechPresenceOptions`, `StreamingVoiceGate`/`VoiceGateOptions`, `BandLimitConfig`/`VoiceGateConfig`, `BeamOutput.voiceGate` shape, the `VG_*` constants — all consistent across tasks. `VoiceGateConfig` (types.ts) and `VoiceGateOptions` (voice-gate.ts) are structurally identical so `config.voiceGate` passes to the ctor.
- **Constraints:** zero-dep (pure scorer/gate, PEQ reuse for band-limit), browser-safe, `.js` imports, `import type`, no `as`, `void noiseGate;`, omit-when-absent spreads (engine emit + scorer `modRef`), Float64 math → Float32 out, default-off byte-identical (no stage + no field).
