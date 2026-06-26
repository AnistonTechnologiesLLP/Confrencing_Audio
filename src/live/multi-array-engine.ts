/**
 * Dual-array orchestrator: run **two** single-array {@link LiveEngine}s (one per POLARIS kit), tap each kit's
 * per-block beamformed mono + DOA bearing, and feed them to the {@link MultiArrayCombiner} → one glitch-free
 * combined output (select active kit → equal-power cross-fade → ONE combined AGC, with an optional triangulation
 * fence veto). The host-wiring layer for Phase B (the pure combiner + triangulation were already tested).
 *
 * **Per-kit AGC should be OFF** in each kit's `LiveConfig` — the combiner applies the single combined AGC
 * (otherwise the two kits would be leveled independently before the mix). The two engines run on independent
 * clocks; outputs are paired as they arrive (no inter-kit sample alignment — the cross-fade is equal-power by
 * design, see the combiner). Testable with two host-driven `ManualCaptureAdapter`s; real two-device capture +
 * clock handling is the node host's job.
 */
import { LiveEngine } from './engine.js';
import { MultiArrayCombiner, type CombinedOutput, type MultiArrayCombinerOptions, type KitBlock } from './multi-array-combiner.js';
import type { CaptureAdapter, LiveConfig, BeamOutput } from './types.js';
import type { KitPose } from './triangulation.js';
import type { Point2D } from '../model/geometry.js';

/** One kit: its capture adapter, its (per-kit, AGC-off) live config, and its room pose for triangulation. */
export interface KitSpec {
  adapter: CaptureAdapter;
  config: LiveConfig;
  pose: KitPose;
}

export interface MultiArrayEngineOptions {
  /** Combiner options (selection / cross-fade / combined AGC / fence). `nKits` is forced to 2. */
  combiner?: MultiArrayCombinerOptions;
  /** Fence polygon in room coordinates (empty / absent = no fence veto). */
  polygon?: readonly Point2D[];
}

export class MultiArrayEngine {
  private readonly engines: [LiveEngine, LiveEngine];
  private readonly combiner: MultiArrayCombiner;
  private readonly poses: [KitPose, KitPose];
  private readonly polygon: readonly Point2D[];
  private readonly sr: number;
  private readonly latest: (KitBlock | null)[] = [null, null];
  private readonly fresh: [boolean, boolean] = [false, false];
  private cb: ((out: CombinedOutput) => void) | null = null;
  private tSec = 0;

  constructor(kits: readonly [KitSpec, KitSpec], sampleRate: number, opts: MultiArrayEngineOptions = {}) {
    // Per-kit AGC must be OFF: the combiner applies the single combined AGC. Two independently-leveled kits
    // would degenerate the speech-presence selection (both score the same) and pump against the combined AGC.
    for (let i = 0; i < 2; i++) {
      if (kits[i]!.config.agc !== undefined) {
        throw new Error(`MultiArrayEngine: kit ${i} must have AGC off — the combiner applies the single combined AGC`);
      }
    }
    this.sr = sampleRate;
    this.poses = [kits[0].pose, kits[1].pose];
    this.polygon = opts.polygon ?? [];
    this.combiner = new MultiArrayCombiner(sampleRate, { ...(opts.combiner ?? {}), nKits: 2 });
    this.engines = [this.buildEngine(kits[0], 0), this.buildEngine(kits[1], 1)];
  }

  private buildEngine(kit: KitSpec, i: number): LiveEngine {
    const e = new LiveEngine(kit.adapter, kit.config);
    e.onOutput((o) => this.onKit(i, o));
    return e;
  }

  private onKit(i: number, o: BeamOutput): void {
    // bearing for triangulation: the strongest DOA detection, else the current look
    const bearing = o.detected && o.detected.azimuths.length > 0 ? o.detected.azimuths[0]! : o.azimuthDeg;
    const salienceDb = o.detected && o.detected.salienceDb.length > 0 ? o.detected.salienceDb[0]! : 0;
    this.latest[i] = { mono: o.mono, azimuthDeg: bearing, salienceDb };
    this.fresh[i] = true;
    if (this.fresh[0] && this.fresh[1]) this.combine();
  }

  private combine(): void {
    this.fresh[0] = false;
    this.fresh[1] = false;
    let k0 = this.latest[0]!;
    let k1 = this.latest[1]!;
    // The two engines run on independent clocks; if they ever produce different-length blocks (mismatched
    // host block sizes), clamp both to the shorter so the combiner's per-sample mix can't read past an end
    // and emit NaN. Equal lengths (the normal case) hit the fast path with no allocation.
    const n = Math.min(k0.mono.length, k1.mono.length);
    if (k0.mono.length !== n) k0 = { ...k0, mono: k0.mono.subarray(0, n) };
    if (k1.mono.length !== n) k1 = { ...k1, mono: k1.mono.subarray(0, n) };
    this.tSec += n / this.sr;
    const out =
      this.polygon.length > 0
        ? this.combiner.process([k0, k1], this.tSec, { poses: this.poses, polygon: this.polygon })
        : this.combiner.process([k0, k1], this.tSec);
    this.cb?.(out);
  }

  onOutput(cb: (out: CombinedOutput) => void): void {
    this.cb = cb;
  }

  async start(): Promise<void> {
    await Promise.all(this.engines.map((e) => e.start()));
  }

  async stop(): Promise<void> {
    await Promise.all(this.engines.map((e) => e.stop()));
    this.combiner.reset();
    this.latest[0] = null;
    this.latest[1] = null;
    this.fresh[0] = false;
    this.fresh[1] = false;
    this.tSec = 0; // restart the combiner time base cleanly on a stop/restart
  }
}
