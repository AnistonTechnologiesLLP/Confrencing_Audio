/**
 * A single-channel circular buffer of the most-recent far-end reference audio, for
 * the live AEC. The host pushes the program/loudspeaker audio via `push`; the AEC
 * pulls a fixed-size window via `recent` per mic block. Pure, zero-dep, browser-safe.
 * Port of the Python `_Ring` (reference_capture.py). JS is single-threaded — no lock.
 */
export class ReferenceRing {
  private readonly buf: Float32Array;
  private readonly n: number;
  private w = 0; // next write index
  private filled = 0; // total valid samples (capped at n)

  constructor(sampleRate: number, seconds = 2) {
    this.n = Math.max(1, Math.round(sampleRate * seconds));
    this.buf = new Float32Array(this.n);
  }

  get capacity(): number {
    return this.n;
  }

  push(block: Float32Array): void {
    const n = this.n;
    const len = block.length;
    if (len >= n) {
      // keep only the newest n samples
      this.buf.set(block.subarray(len - n));
      this.w = 0;
      this.filled = n;
      return;
    }
    for (let i = 0; i < len; i++) {
      this.buf[this.w] = block[i]!;
      this.w = (this.w + 1) % n;
    }
    this.filled = Math.min(n, this.filled + len);
  }

  /** Fill `out` with the most recent out.length samples (newest last; zero-front-padded). */
  recent(out: Float32Array): Float32Array {
    const m = out.length;
    const n = this.n;
    for (let i = 0; i < m; i++) {
      // position i in `out` (i = m-1 is newest). age from newest = (m-1-i).
      const age = m - 1 - i;
      if (age >= this.filled) {
        out[i] = 0;
      } else {
        // newest written sample is at index (w-1) mod n
        const idx = (((this.w - 1 - age) % n) + n) % n;
        out[i] = this.buf[idx]!;
      }
    }
    return out;
  }

  reset(): void {
    this.buf.fill(0);
    this.w = 0;
    this.filled = 0;
  }
}
