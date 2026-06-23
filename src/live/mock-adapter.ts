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
      opts.onBlock(block as Float32Array[], opts.sampleRate);
    }
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.running = false;
    return Promise.resolve();
  }
}
