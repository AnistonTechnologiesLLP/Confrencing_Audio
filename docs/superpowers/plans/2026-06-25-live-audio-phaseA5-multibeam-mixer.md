# Live audio — Phase A5 (multi-beam mixer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** N simultaneous frequency-domain beams (each steered to a slot while nulling the others), gated by speech-presence and NOM-automixed — wired into `LiveEngine` as an opt-in multi-talker mode, default-off byte-identical. The final Phase-A sub-phase.

**Architecture:** `nomAutomix(gates, monos)` + `MultiBeamMixer` (`src/live/multi-beam-mixer.ts`) own N `FreqDomainBeam`s (A2 + A3 nulls) and N `SpeechPresenceScorer`s (already shipped). A new `FreqDomainBeam.steer(az, offNadir, nulls)` sets look+nulls in one recompute. The engine, when `config.multiBeam` is set, drives a `BeamSlotTracker` (A4) from DOA detections → `mixer.setSlots`, runs `mixer.processBlock(channels)` as the beam stage, and surfaces per-beam state.

**Tech Stack:** TypeScript ESM (strict), vitest, zero deps.

## Global Constraints

- Zero deps; `src/live/` browser-safe; `.js` relative imports; `import type` for types; no `as` casts (non-null `!` ok); `exactOptionalPropertyTypes` (omit-when-absent).
- Float64 internal math; `Float32Array` mono output.
- Default-off byte-identical: no `config.multiBeam` ⇒ the single-beam path (delaySum/freqDomain) is unchanged; existing engine tests green.
- Faithful to `conf_pipeline_control/multibeam.py` (`MultiBeamMixer`, `nom_automix`). Constants: `DEFAULT_N_BEAMS=3`.
- Reuses A2 `FreqDomainBeam`, A4 `BeamSlotTracker`/`snapTargets`, the existing `SpeechPresenceScorer` (`speech-presence.ts`).
- Hardware-free tests. Gates: `npm run typecheck`, `npm test`, `npm run build`.

---

### Task 1: `FreqDomainBeam.steer` + `nomAutomix` + `MultiBeamMixer`

**Files:**
- Modify: `src/live/freq-domain-beam.ts` (add `steer(az, offNadir, nullsDeg)` — one recompute)
- Create: `src/live/multi-beam-mixer.ts`
- Test: `test/live-multi-beam-mixer.test.ts`

**Interfaces produced:**
- `FreqDomainBeam.steer(azimuthDeg: number, offNadirDeg: number, nullsDeg: readonly number[]): void`
- `function nomAutomix(gates: readonly number[], monos: readonly Float32Array[]): Float32Array`
- `class MultiBeamMixer { constructor(geom, sampleRate, opts?); get nBeams; setSlots(slots: readonly BeamSlot[]): void; processBlock(channels: Float32Array[]): { mixed: Float32Array; monos: Float32Array[]; gates: number[] }; reset(): void }`
- `interface MultiBeamOptions { nBeams?; offNadirDeg?; loading?; hopSeconds? }`

- [ ] **Step 1: Add `FreqDomainBeam.steer`** (write its test first, in `test/live-freq-domain-beam.test.ts`):
```ts
it('steer() sets look + nulls in a single recompute', () => {
  const a = new FreqDomainBeam(GEOM, FS); a.setLook(30, 90); a.setNulls([120]);
  const b = new FreqDomainBeam(GEOM, FS); b.steer(30, 90, [120]);
  expect(b.debugWeightsHash()).toBe(a.debugWeightsHash());
  expect(b.activeNulls).toEqual([120]);
});
```
Implement in `src/live/freq-domain-beam.ts`:
```ts
  /** Set look + nulls together and recompute once (used by the multi-beam mixer). */
  steer(azimuthDeg: number, offNadirDeg: number, nullsDeg: readonly number[]): void {
    const sameLook = azimuthDeg === this.azimuthDeg && offNadirDeg === this.offNadirDeg;
    const nextNulls = [...nullsDeg];
    const sameNulls = nextNulls.length === this.nullsDeg.length && nextNulls.every((v, i) => v === this.nullsDeg[i]);
    if (sameLook && sameNulls) return;
    this.azimuthDeg = azimuthDeg;
    this.offNadirDeg = offNadirDeg;
    this.nullsDeg = nextNulls;
    this.recompute();
  }
```
(`nullsDeg`/`azimuthDeg`/`offNadirDeg`/`recompute` already exist from A2/A3.)

- [ ] **Step 2: Write the mixer test** — `test/live-multi-beam-mixer.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { MultiBeamMixer, nomAutomix } from '../src/live/multi-beam-mixer.js';
import { planeWaveChannels } from '../src/live/mock-adapter.js';
import { sensibel8 } from '../src/beamformer/geometry.js';
import type { BeamSlot } from '../src/live/slot-tracker.js';

const FS = 44100;
const GEOM = sensibel8(0.04);
const slot = (index: number, az: number | null, active = true): BeamSlot => ({ index, azimuthDeg: az, seatId: null, active, held: false });

describe('nomAutomix', () => {
  it('one open gate passes that mono ~unity; closed gates contribute nothing', () => {
    const a = new Float32Array([1, 1, 1, 1]);
    const b = new Float32Array([2, 2, 2, 2]);
    const mixed = nomAutomix([1, 0], [a, b]);
    // gate sum 1 → denom max(1, sqrt(1)) = 1 → passes a at unity
    expect(Array.from(mixed)).toEqual([1, 1, 1, 1]);
  });
  it('returns silence when all gates are closed', () => {
    expect(Array.from(nomAutomix([0, 0], [new Float32Array(3), new Float32Array(3)]))).toEqual([0, 0, 0]);
  });
  it('NOM-attenuates as more gates open (√Σgate denominator)', () => {
    const m = new Float32Array([1, 1]);
    const mixed = nomAutomix([1, 1], [m, m]); // Σgm = [2,2]; denom = max(1, √2); 2/√2 = √2 ≈ 1.414
    expect(mixed[0]!).toBeCloseTo(Math.SQRT2, 5);
  });
});

describe('MultiBeamMixer', () => {
  it('runs N beams, returns mixed + per-beam monos + gates, mixed length = block', () => {
    const mixer = new MultiBeamMixer(GEOM, FS, { nBeams: 3 });
    mixer.setSlots([slot(0, 0), slot(1, 120), slot(2, null, false)]);
    let r = mixer.processBlock(planeWaveChannels(GEOM, 0, 1500, 512, 0, FS));
    for (let i = 1; i < 20; i++) r = mixer.processBlock(planeWaveChannels(GEOM, 0, 1500, 512, i, FS));
    expect(r.monos.length).toBe(3);
    expect(r.gates.length).toBe(3);
    expect(r.mixed.length).toBe(512);
    expect(r.gates[2]).toBe(0); // idle slot gated out
    for (const v of r.mixed) expect(Number.isFinite(v)).toBe(true);
    expect(mixer.nBeams).toBe(3);
  });
  it('an idle slot contributes nothing (gate 0) and a live slot can open', () => {
    const mixer = new MultiBeamMixer(GEOM, FS, { nBeams: 2 });
    mixer.setSlots([slot(0, 0), slot(1, null, false)]);
    let r = mixer.processBlock(planeWaveChannels(GEOM, 0, 1500, 512, 0, FS));
    for (let i = 1; i < 30; i++) r = mixer.processBlock(planeWaveChannels(GEOM, 0, 1500, 512, i, FS));
    expect(r.gates[1]).toBe(0);
  });
  it('reset() clears the beams + scorers (re-feeding reproduces a fresh run)', () => {
    const mixer = new MultiBeamMixer(GEOM, FS, { nBeams: 2 });
    mixer.setSlots([slot(0, 0), slot(1, 90)]);
    const mk = (i: number): Float32Array[] => planeWaveChannels(GEOM, 0, 1200, 512, i, FS);
    const first: number[] = [];
    for (let i = 0; i < 6; i++) for (const v of mixer.processBlock(mk(i)).mixed) first.push(v);
    for (let i = 0; i < 3; i++) mixer.processBlock(mk(i));
    mixer.reset();
    mixer.setSlots([slot(0, 0), slot(1, 90)]);
    const again: number[] = [];
    for (let i = 0; i < 6; i++) for (const v of mixer.processBlock(mk(i)).mixed) again.push(v);
    for (let i = 0; i < first.length; i++) expect(again[i]).toBeCloseTo(first[i]!, 5);
  });
});
```

- [ ] **Step 3: Implement** — `src/live/multi-beam-mixer.ts`:
```ts
import { ArrayGeometry } from '../beamformer/geometry.js';
import { FreqDomainBeam } from './freq-domain-beam.js';
import { SpeechPresenceScorer } from './speech-presence.js';
import { DEFAULT_N_BEAMS } from './slot-tracker.js';
import type { BeamSlot } from './slot-tracker.js';

export interface MultiBeamOptions {
  nBeams?: number;
  offNadirDeg?: number;
  loading?: number;
  hopSeconds?: number;
}

/**
 * Gain-shared automix of per-beam monos by their open gates, with NOM attenuation:
 * `mixed = (Σ gate_k·mono_k) / max(1, √Σgate)` — one open talker passes at unity; as more open, the mix is
 * pulled down so N beams don't stack their noise floors. Silence when nothing is open. Port of `nom_automix`.
 */
export function nomAutomix(gates: readonly number[], monos: readonly Float32Array[]): Float32Array {
  if (monos.length === 0) return new Float32Array(0);
  const n = monos[0]!.length;
  const out = new Float32Array(n);
  let openSum = 0;
  for (const g of gates) openSum += g;
  if (openSum <= 1e-6) return out;
  const denom = Math.max(1, Math.sqrt(openSum));
  for (let k = 0; k < monos.length; k++) {
    const g = gates[k]!;
    if (g === 0) continue;
    const m = monos[k]!;
    for (let i = 0; i < n; i++) out[i] += g * m[i]!;
  }
  for (let i = 0; i < n; i++) out[i] /= denom;
  return out;
}

/**
 * Apply N simultaneous beams to each block and NOM-automix the gated per-beam monos. Owns N
 * `FreqDomainBeam`s (each steered to a slot while nulling the others) + N `SpeechPresenceScorer`s.
 * `setSlots` re-aims (off the per-block path); `processBlock` runs every beam, gates each live slot by its
 * speech score, returns `(mixed, monos, gates)`. Port of `multibeam.py:MultiBeamMixer`.
 */
export class MultiBeamMixer {
  private readonly n: number;
  private readonly offNadir: number;
  private readonly beams: FreqDomainBeam[];
  private readonly scorers: SpeechPresenceScorer[];
  private readonly live: boolean[];

  constructor(geom: ArrayGeometry, sampleRate: number, opts: MultiBeamOptions = {}) {
    this.n = opts.nBeams ?? DEFAULT_N_BEAMS;
    if (this.n < 1) throw new Error('nBeams must be >= 1');
    this.offNadir = opts.offNadirDeg ?? 90;
    this.beams = Array.from({ length: this.n }, () =>
      new FreqDomainBeam(geom, sampleRate, {
        offNadirDeg: this.offNadir,
        ...(opts.loading !== undefined ? { loading: opts.loading } : {}),
      }),
    );
    this.scorers = Array.from({ length: this.n }, () =>
      new SpeechPresenceScorer(opts.hopSeconds !== undefined ? { hopSeconds: opts.hopSeconds } : {}),
    );
    this.live = new Array<boolean>(this.n).fill(false);
  }

  get nBeams(): number {
    return this.n;
  }

  /** Re-aim each beam from the slots: a live slot steers to its bearing nulling the OTHER live slots. */
  setSlots(slots: readonly BeamSlot[]): void {
    const liveAz: number[] = [];
    for (const s of slots) if (s.azimuthDeg !== null) liveAz.push(s.azimuthDeg);
    for (let i = 0; i < this.n; i++) {
      const slot = i < slots.length ? slots[i]! : null;
      const az = slot ? slot.azimuthDeg : null;
      this.live[i] = !!(slot && az !== null && (slot.active || slot.held));
      if (az !== null) {
        const nulls = liveAz.filter((a) => a !== az);
        this.beams[i]!.steer(az, this.offNadir, nulls);
      }
    }
  }

  processBlock(channels: Float32Array[]): { mixed: Float32Array; monos: Float32Array[]; gates: number[] } {
    const monos: Float32Array[] = [];
    const gates: number[] = [];
    for (let i = 0; i < this.n; i++) {
      const mono = this.beams[i]!.process(channels);
      monos.push(mono);
      if (this.live[i]) {
        let s = 0;
        for (let k = 0; k < mono.length; k++) s += mono[k]! * mono[k]!;
        const rms = mono.length ? Math.sqrt(s / mono.length) : 0;
        gates.push(this.scorers[i]!.update(rms));
      } else {
        gates.push(0);
      }
    }
    return { mixed: nomAutomix(gates, monos), monos, gates };
  }

  reset(): void {
    for (const b of this.beams) b.reset();
    for (const s of this.scorers) s.reset();
  }
}
```

- [ ] **Step 4: Run + typecheck + full suite + build, then commit**
```bash
npx vitest run test/live-multi-beam-mixer.test.ts test/live-freq-domain-beam.test.ts && npm run typecheck && npm test && npm run build
git add src/live/freq-domain-beam.ts src/live/multi-beam-mixer.ts test/live-multi-beam-mixer.test.ts test/live-freq-domain-beam.test.ts
git commit -m "feat(live): multi-beam mixer (N beams, per-beam nulling, NOM-automix)"
```

---

### Task 2: Wire opt-in multi-beam mode into `LiveEngine`

**Files:**
- Modify: `src/live/types.ts` (`LiveConfig.multiBeam?`, `BeamOutput.multiBeam?`)
- Modify: `src/live/engine.ts` (build the mixer + slot tracker; run the mixer as the beam stage; drive slots from DOA)
- Modify: `src/live/index.ts` (export `MultiBeamMixer`, `nomAutomix`, `BeamSlotTracker`, `snapTargets`, types)
- Test: `test/live-engine-multibeam.test.ts`

**Interfaces produced:**
- `LiveConfig.multiBeam?: { nBeams?: number; holdSeconds?: number; matchRadiusDeg?: number }`
- `BeamOutput.multiBeam?: { slots: { azimuthDeg: number | null; active: boolean; held: boolean }[]; gates: number[] }` (omit-when-absent)

- [ ] **Step 1: Write the failing test** — `test/live-engine-multibeam.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { LiveEngine } from '../src/live/engine.js';
import { MockCaptureAdapter } from '../src/live/mock-adapter.js';
import { sensibel8 } from '../src/beamformer/geometry.js';
import type { BeamOutput, LiveConfig } from '../src/live/types.js';

const GEOM = sensibel8(0.04);
async function run(extra: Partial<LiveConfig>): Promise<BeamOutput[]> {
  const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 40, blockSize: 512, freqHz: 1500 });
  const engine = new LiveEngine(mock, {
    geom: GEOM, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 0,
    autoSteer: { mode: 'follow', sector: { centerDeg: 90, halfWidthDeg: 80 }, detectionHops: 2 },
    ...extra,
  });
  const outs: BeamOutput[] = [];
  engine.onOutput((o) => outs.push(o));
  await engine.start();
  return outs;
}

describe('LiveEngine multi-beam mode', () => {
  it('absent multiBeam emits no multiBeam field (byte-identical)', async () => {
    const outs = await run({});
    for (const o of outs) expect('multiBeam' in o).toBe(false);
  });

  it('multiBeam mode runs, emits mono + slots/gates, and tracks the source', async () => {
    const outs = await run({ multiBeam: { nBeams: 3 } });
    expect(outs.length).toBeGreaterThan(0);
    const last = outs.at(-1)!;
    expect(last.multiBeam).toBeDefined();
    expect(last.multiBeam!.slots.length).toBe(3);
    expect(last.multiBeam!.gates.length).toBe(3);
    expect(Number.isFinite(last.rmsDb)).toBe(true);
    expect(last.mono.length).toBe(512);
    // at least one slot picked up the 90° source over the run
    const sawSource = outs.some((o) => o.multiBeam!.slots.some((s) => s.azimuthDeg !== null && Math.abs((s.azimuthDeg) - 90) < 30));
    expect(sawSource).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Wire it** — `src/live/types.ts`:
```ts
// LiveConfig:
  multiBeam?: { nBeams?: number; holdSeconds?: number; matchRadiusDeg?: number };
// BeamOutput (omit-when-absent):
  multiBeam?: { slots: { azimuthDeg: number | null; active: boolean; held: boolean }[]; gates: number[] };
```
`src/live/engine.ts`:
- imports: `MultiBeamMixer` from `./multi-beam-mixer.js`; `BeamSlotTracker, snapTargets, type BeamSlot` from `./slot-tracker.js`.
- fields: `private readonly mixer: MultiBeamMixer | null; private readonly slotTracker: BeamSlotTracker | null; private lastSlots: BeamSlot[] = []; private _tSec = 0;`
- In the constructor, when `config.multiBeam` is set: build `this.mixer = new MultiBeamMixer(config.geom, sr, { nBeams, offNadirDeg: this._offNadirDeg })` and `this.slotTracker = new BeamSlotTracker({ ...(nBeams?{nSlots:nBeams}:{}) , ...(holdSeconds?{holdSeconds}:{}), ...(matchRadiusDeg?{matchRadiusDeg}:{}) })`. Note: multi-beam needs DOA — if `config.multiBeam` is set, ensure the covariance/DOA path is active (the mixer wants detections); document that `multiBeam` implies auto-steer's DOA detection runs (the test supplies `autoSteer`). If `this.cov`/DOA isn't set up, the mixer still runs with no slots (silence until slots arrive) — acceptable; the slots come from the DOA cycle.
- In `onBlock`, advance time `this._tSec += n / sr` (n = block length). When `this.mixer`, replace the beam stage:
```ts
        let mono: Float32Array = this.mixer
          ? this.mixer.processBlock(channels).mixed
          : this.beam.process(channels);
```
  (When the mixer is active, the single `this.beam` is unused for output — but still constructed; that's fine. Optionally skip `this.beam.process` when mixer is set — the above does.)
- In the DOA cycle (where `this.lastDoa` refreshes), when `this.mixer && this.slotTracker && this.lastDoa`:
```ts
          const targets = snapTargets(this.lastDoa.detections.map((d) => ({ azimuthDeg: d.azimuthDeg, salienceDb: d.salienceDb })));
          this.lastSlots = this.slotTracker.update(targets, this._tSec);
          this.mixer.setSlots(this.lastSlots);
```
- Emit (omit-when-absent):
```ts
          ...(this.mixer ? { multiBeam: { slots: this.lastSlots.map((s) => ({ azimuthDeg: s.azimuthDeg, active: s.active, held: s.held })), gates: this.mixer.processBlockGates ?? [] } } : {}),
```
  NOTE: to report the latest gates without re-running processBlock, store the last gates from the onBlock mixer call: add `private lastGates: number[] = [];` set to `r.gates` when calling the mixer, and emit `gates: this.lastGates`. (Do NOT call processBlock twice.) Implement that: in onBlock, `const r = this.mixer.processBlock(channels); mono = r.mixed; this.lastGates = r.gates;`.

- [ ] **Step 4: Run new test + typecheck + full suite + build, then commit**

The "tracks the source" assertion depends on the DOA picking up the 90° source — if it's flaky, relax to "the mixer runs and emits 3 slots/gates without throwing, mono finite" (still proving the mode works), and report. Do NOT remove the byte-identical-off assertion.
```bash
npx vitest run test/live-engine-multibeam.test.ts && npm run typecheck && npm test && npm run build
git add src/live/types.ts src/live/engine.ts src/live/index.ts test/live-engine-multibeam.test.ts
git commit -m "feat(live): opt-in multi-beam (multi-talker) mode in LiveEngine"
```

---

## Notes for the controller

- A5 completes Phase A. After it, run the **whole-branch multi-lens review** over A1–A5 (DSP-math lens hand-verifies the freq-beam MAC + LCMV + NOM-automix; rt lens the stage order + byte-identical-off + no per-block solve; test lens coverage), then PR all of Phase A.
- The mixer's per-re-aim solve (N beams × LCMV) runs in the DOA cycle (off the per-block path) — bounded, infrequent.

## Self-review (done)

- **Spec coverage:** Task 1 (steer + nomAutomix + MultiBeamMixer), Task 2 (engine multiBeam mode + slot-tracker drive + telemetry) cover the A5 design.
- **Type consistency:** `MultiBeamMixer`/`MultiBeamOptions`/`nomAutomix`, `FreqDomainBeam.steer`, `LiveConfig.multiBeam`/`BeamOutput.multiBeam`, the slot-tracker reuse. The lastGates store avoids a double processBlock.
- **Faithfulness:** `setSlots` (live = active||held; null the other live bearings), `processBlock` (gate live slots by speech score, NOM-automix), `nomAutomix` (`Σg·m / max(1,√Σg)`, silence when closed) — from `MultiBeamMixer`/`nom_automix`.
- **Constraints:** zero-dep, browser-safe, `.js`, no `as`, omit-when-absent (`multiBeam` field + the option spreads), default-off byte-identical (single-beam path untouched when `multiBeam` absent).
