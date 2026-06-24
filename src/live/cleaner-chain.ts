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
