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
    for (let i = 0; i < n; i++) out[i] = out[i]! + g * m[i]!;
  }
  for (let i = 0; i < n; i++) out[i] = out[i]! / denom;
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
