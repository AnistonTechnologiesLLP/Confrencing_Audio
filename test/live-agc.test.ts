import { describe, it, expect } from 'vitest';
import { TargetLoudnessAgc } from '../src/live/agc.js';

function rms(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / Math.max(1, x.length));
}
function tone(n: number, amp: number) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * 300 * i) / 44100);
  return a;
}

describe('TargetLoudnessAgc', () => {
  it('boosts a quiet signal toward the target loudness', () => {
    const agc = new TargetLoudnessAgc(44100, { targetDb: -20 }); // target RMS ~0.1
    const quiet = tone(256, 0.02);
    let out;
    for (let b = 0; b < 80; b++) out = agc.process(tone(256, 0.02), false);
    expect(rms(out!)).toBeGreaterThan(rms(quiet) * 1.5); // gain slewed up
    expect(agc.gainLinear).toBeGreaterThan(1);
  });

  it('attenuates a loud signal toward the target', () => {
    const agc = new TargetLoudnessAgc(44100, { targetDb: -20 });
    let out;
    for (let b = 0; b < 80; b++) out = agc.process(tone(256, 0.5), false);
    expect(rms(out!)).toBeLessThan(rms(tone(256, 0.5))); // gain slewed down
    expect(agc.gainLinear).toBeLessThan(1);
  });

  it('clamps the gain to ±maxGainDb', () => {
    const agc = new TargetLoudnessAgc(44100, { targetDb: 0, maxGainDb: 12 }); // target RMS 1.0
    for (let b = 0; b < 200; b++) agc.process(tone(256, 0.001), false); // extreme boost demand
    expect(agc.gainLinear).toBeLessThanOrEqual(Math.pow(10, 12 / 20) + 1e-6); // capped at +12 dB
  });

  it('holds the gain on silence (no pump)', () => {
    const agc = new TargetLoudnessAgc(44100, { targetDb: -20 });
    for (let b = 0; b < 40; b++) agc.process(tone(256, 0.05), false); // seed some gain
    const g0 = agc.gainLinear;
    for (let b = 0; b < 60; b++) agc.process(new Float32Array(256), false); // silence
    expect(agc.gainLinear).toBeCloseTo(g0, 6); // held, did not ramp up
  });

  it('slews gradually toward a new target when the level changes', () => {
    // ExponentialTracker seeds to the FIRST value, so a cold steady input jumps to its target on block 1.
    // The slew is observable on a LEVEL CHANGE: converge at one level, then drop the level and check the
    // gain moves only partway toward the new (higher) target in one alpha-0.15 step.
    const agc = new TargetLoudnessAgc(44100, { targetDb: -20, slewAlpha: 0.15 });
    for (let b = 0; b < 60; b++) agc.process(tone(256, 0.1), false); // converge at the louder level
    const gA = agc.gainLinear;
    agc.process(tone(256, 0.01), false); // level drops 10x → desired gain jumps up; gain must slew, not jump
    const g1 = agc.gainLinear;
    expect(g1).toBeGreaterThan(gA); // moving up toward the new target
    expect(g1).toBeLessThan(gA + (Math.pow(10, 18 / 20) - gA) * 0.5); // far short of the +18 dB clamp after one step
  });

  it('the peak limiter keeps the output peak at/under the ceiling', () => {
    const agc = new TargetLoudnessAgc(44100, { targetDb: 0 }); // big boost demand
    let out;
    for (let b = 0; b < 200; b++) out = agc.process(tone(256, 0.4), false);
    expect(Math.max(...out!.subarray(0).map(Math.abs))).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 0.02);
  });

  it('reset() clears the slew + limiter', () => {
    const mk = () => new TargetLoudnessAgc(44100, { targetDb: -20 });
    const x = () => tone(256, 0.05);
    const fresh = mk().process(x(), false);
    const re = mk();
    for (let b = 0; b < 30; b++) re.process(x(), false);
    re.reset();
    const after = re.process(x(), false);
    for (let i = 0; i < after.length; i++) expect(after[i]!).toBeCloseTo(fresh[i]!, 9);
  });
});
