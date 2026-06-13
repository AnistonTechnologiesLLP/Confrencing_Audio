/**
 * Physical microphone-array geometry (pure stdlib).
 *
 * Port of `conf_pipeline_control/geometry.py`. The conferencing engine models
 * *zones* and *routing*; it has no notion of the individual mic capsules inside
 * an array. Host-side beamforming (steering the pickup toward chosen areas,
 * nulling excluded areas) needs the actual capsule layout, so we describe it
 * here.
 *
 * Coordinates are a right-handed local frame centred on the array, in metres:
 * `x` → room +X (east), `y` → room +Y (north), `z` → up. The capsules of a
 * ceiling array lie in the horizontal plane `z = 0`; a talker on the floor below
 * is in a direction with a downward (−z) component. A purely planar array
 * therefore discriminates sources mainly by **azimuth / horizontal offset** — it
 * cannot tell two sources apart by range alone when they share a bearing. That
 * is real array physics, not a limitation of this code.
 */

/** Speed of sound in air at ~20 °C, m/s. The beam geometry scales with c/f. */
export const SOUND_SPEED_MPS = 343.0;

// --------------------------------------------------------------------------- //
// Minimal complex-number helper (TS has no built-in complex type).
// --------------------------------------------------------------------------- //

/** A complex number `re + j·im`. */
export interface Complex {
  re: number;
  im: number;
}

/** Build a complex number. */
export function complex(re: number, im = 0): Complex {
  return { re, im };
}

/** Sum of two complex numbers. */
export function cadd(a: Complex, b: Complex): Complex {
  return { re: a.re + b.re, im: a.im + b.im };
}

/** Difference of two complex numbers (`a − b`). */
export function csub(a: Complex, b: Complex): Complex {
  return { re: a.re - b.re, im: a.im - b.im };
}

/** Product of two complex numbers. */
export function cmul(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

/** Scale a complex number by a real scalar. */
export function cscale(a: Complex, s: number): Complex {
  return { re: a.re * s, im: a.im * s };
}

/** Complex conjugate. */
export function cconj(a: Complex): Complex {
  return { re: a.re, im: -a.im };
}

/** Quotient of two complex numbers (`a / b`). */
export function cdiv(a: Complex, b: Complex): Complex {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}

/** Magnitude `|a|`. */
export function cabs(a: Complex): number {
  return Math.hypot(a.re, a.im);
}

/** `exp(j·theta)` — unit-magnitude complex from a real angle (radians). */
export function cexpj(theta: number): Complex {
  return { re: Math.cos(theta), im: Math.sin(theta) };
}

// --------------------------------------------------------------------------- //
// Array geometry
// --------------------------------------------------------------------------- //

/** A capsule position `(x, y, z)` in metres in the array's local frame. */
export type Element = readonly [number, number, number];

function dist3(a: Element, b: Element): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Capsule layout of a real microphone array (immutable).
 *
 * `elements` are capsule positions `(x, y, z)` in metres in the array's local
 * frame (origin = array centre). `label` is informational. `active` is an
 * optional per-capsule on/off mask (a dead or non-audio channel can be switched
 * off); an empty array means **all capsules active**. Beamforming designs over
 * the active capsules only and gives the rest zero weight, so the full-length
 * weight vector still lines up with the device's channel count.
 */
export class ArrayGeometry {
  readonly elements: readonly Element[];
  readonly label: string;
  readonly active: readonly boolean[];

  constructor(elements: readonly Element[], label = 'array', active: readonly boolean[] = []) {
    this.elements = elements;
    this.label = label;
    this.active = active;
  }

  /** Total capsule (channel) count. */
  get nChannels(): number {
    return this.elements.length;
  }

  /** Indices of the capsules currently in use (all, if no mask is set). */
  activeIndices(): number[] {
    if (this.active.length === 0) {
      return this.elements.map((_e, i) => i);
    }
    const out: number[] = [];
    for (let i = 0; i < this.active.length; i++) {
      if (this.active[i] && i < this.elements.length) out.push(i);
    }
    return out;
  }

  /** Number of active capsules. */
  get nActive(): number {
    return this.activeIndices().length;
  }

  /** Largest centre-to-centre spacing between any two active capsules (m). */
  apertureM(): number {
    const idx = this.activeIndices();
    const pts = idx.map((i) => this.elements[i]!);
    let best = 0.0;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = dist3(pts[i]!, pts[j]!);
        if (d > best) best = d;
      }
    }
    return best;
  }
}

/**
 * Return a copy of `geom` with a per-capsule active mask.
 *
 * `active` is an iterable of bools, one per capsule. Throws if its length
 * doesn't match the capsule count, or if it would leave no capsule active.
 */
export function withActiveChannels(geom: ArrayGeometry, active: Iterable<boolean>): ArrayGeometry {
  const mask = Array.from(active, (x) => Boolean(x));
  if (mask.length !== geom.nChannels) {
    throw new Error(
      `active mask has ${mask.length} entries but array has ${geom.nChannels} capsules`,
    );
  }
  if (!mask.some((x) => x)) {
    throw new Error('at least one capsule must stay active');
  }
  return new ArrayGeometry(geom.elements, geom.label, mask);
}

/**
 * `n` capsules equally spaced on a horizontal circle of `radiusM`.
 *
 * `centerElement` adds one capsule at the origin (some arrays have a centre
 * mic). `phase0Deg` rotates the ring. Capsule 0 is at bearing `phase0Deg`.
 */
export function circularArray(
  n: number,
  radiusM: number,
  options: { centerElement?: boolean; label?: string; phase0Deg?: number } = {},
): ArrayGeometry {
  const { centerElement = false, label = 'array', phase0Deg = 0.0 } = options;
  if (n < 1) throw new Error('n must be >= 1');
  if (radiusM <= 0) throw new Error('radiusM must be > 0');
  const elems: Element[] = [];
  if (centerElement) elems.push([0.0, 0.0, 0.0]);
  for (let m = 0; m < n; m++) {
    const ang = (phase0Deg * Math.PI) / 180 + (2.0 * Math.PI * m) / n;
    elems.push([radiusM * Math.cos(ang), radiusM * Math.sin(ang), 0.0]);
  }
  return new ArrayGeometry(elems, label);
}

/**
 * The sensiBel-style 8-capsule circular array.
 *
 * `radiusM` is the capsule-circle radius. **Set this to your array's actual
 * radius** — the default (0.05 m) is a documented placeholder; the absolute
 * beamwidth scales inversely with the radius, so the number matters for any
 * quantitative reading. The relative behaviour (which way the beam steers, where
 * nulls land) is correct for whatever radius you pass.
 */
export function sensibel8(radiusM = 0.05): ArrayGeometry {
  return circularArray(8, radiusM, { label: 'sensiBel-8' });
}
