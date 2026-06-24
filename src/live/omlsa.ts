/**
 * OM-LSA / Wiener denoiser gain laws (decision-directed, Cohen 2003) layered on
 * the streaming STFT base. Pure DSP — the exponential integral E1 is vendored
 * (Abramowitz–Stegun), no scipy. Port of the Python StreamingCleaner._gain.
 */
import { StreamingSpectralProcessor, type SpectralOptions } from './spectral-processor.js';

/** Exponential integral E1(x), x > 0 (Abramowitz & Stegun 5.1.53 / 5.1.56). */
export function expE1(x: number): number {
  if (x <= 1) {
    const a = [-0.57721566, 0.99999193, -0.24991055, 0.05519968, -0.00976004, 0.00107857];
    let poly = 0;
    let xp = 1;
    for (let k = 0; k < a.length; k++) { poly += a[k]! * xp; xp *= x; }
    return -Math.log(x) + poly;
  }
  const num = x * x + 2.334733 * x + 0.250621;
  const den = x * x + 3.330657 * x + 1.681534;
  return (Math.exp(-x) / x) * (num / den);
}

export interface OmlsaOptions extends SpectralOptions {
  mode?: 'omlsa' | 'wiener' | 'gate';
  cleanerAlpha?: number;
  gminDb?: number;
  gammaThresh?: number;
  nuMin?: number;
  nuMax?: number;
}

export class OmlsaProcessor extends StreamingSpectralProcessor {
  private readonly mode: 'omlsa' | 'wiener' | 'gate';
  private readonly ddAlpha: number;
  private readonly gFloorOm: number; // amplitude gain floor 10^(gmin/20) (the OM-LSA Gmin bed)
  private readonly xiFloor: number; // power a-priori-SNR floor 10^(gmin/10)
  private readonly gammaThresh: number;
  private readonly nuMin: number;
  private readonly nuMax: number;
  private prevClean: Float64Array;
  private prevCleanFresh = true;

  constructor(sampleRate: number, opts: OmlsaOptions = {}) {
    super(sampleRate, opts);
    this.mode = opts.mode ?? 'omlsa';
    this.ddAlpha = opts.cleanerAlpha ?? 0.985;
    const gminDb = opts.gminDb ?? -18;
    this.gFloorOm = Math.pow(10, gminDb / 20);
    this.xiFloor = Math.pow(10, gminDb / 10);
    this.gammaThresh = opts.gammaThresh ?? 2.0;
    this.nuMin = opts.nuMin ?? 1e-3;
    this.nuMax = opts.nuMax ?? 500;
    this.prevClean = new Float64Array(this.nb);
  }

  protected override computeGain(power: Float64Array, noiseMag: Float64Array): Float64Array {
    if (this.mode === 'gate') return super.computeGain(power, noiseMag);
    const nb = this.nb;
    const g = this._gBuf;
    const prev = this.prevClean;
    const first = this.prevCleanFresh;
    for (let k = 0; k < nb; k++) {
      const noise2 = noiseMag[k]! * noiseMag[k]! + 1e-20;
      const gamma = power[k]! / noise2;
      const gpost = Math.max(gamma - 1, 0);
      let xi = first ? gpost : this.ddAlpha * (prev[k]! / noise2) + (1 - this.ddAlpha) * gpost;
      if (xi < this.xiFloor) xi = this.xiFloor;
      const gw = xi / (1 + xi);
      prev[k] = gw * gw * power[k]!; // clean power carried to next frame
      if (this.mode === 'wiener') {
        g[k] = Math.max(gw, this.gFloorOm);
      } else {
        let nu = gw * gamma;
        if (nu < this.nuMin) nu = this.nuMin;
        if (nu > this.nuMax) nu = this.nuMax;
        const gh1 = Math.min(gw * Math.exp(0.5 * expE1(nu)), 1);
        const spp = gamma / (gamma + this.gammaThresh);
        g[k] = Math.pow(gh1, spp) * Math.pow(this.gFloorOm, 1 - spp);
      }
    }
    this.prevCleanFresh = false;
    return g;
  }

  override reset(): void {
    super.reset();
    this.prevClean.fill(0);
    this.prevCleanFresh = true;
  }
}
