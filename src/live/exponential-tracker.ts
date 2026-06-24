/** One-pole EMA: y = α·x + (1−α)·y, seeded to the first sample. Pure, zero-dep. */
export class ExponentialTracker {
  private readonly alpha: number;
  private state = 0;
  private seeded = false;

  constructor(alpha: number) {
    this.alpha = Math.min(1, Math.max(0, alpha));
  }

  update(x: number): number {
    if (!this.seeded) { this.state = x; this.seeded = true; }
    else this.state = this.alpha * x + (1 - this.alpha) * this.state;
    return this.state;
  }

  get value(): number {
    return this.state;
  }

  reset(): void {
    this.state = 0;
    this.seeded = false;
  }
}
