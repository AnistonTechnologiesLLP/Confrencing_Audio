import { describe, it, expect } from 'vitest';
import { MultiArrayEngine } from '../src/live/multi-array-engine.js';
import { ManualCaptureAdapter } from '../src/live/manual-adapter.js';
import { planeWaveChannels } from '../src/live/mock-adapter.js';
import { sensibel8 } from '../src/beamformer/geometry.js';
import type { KitPose } from '../src/live/triangulation.js';
import type { CombinedOutput } from '../src/live/multi-array-combiner.js';

const FS = 44100;
const GEOM = sensibel8(0.04);
const poseA: KitPose = { position: { x: 0, y: 0 }, bearingDeg: 0 };
const poseB: KitPose = { position: { x: 4, y: 0 }, bearingDeg: 0 };

/** A plane-wave block from `az`, scaled to amplitude `amp` (to fake a quiet / modulated talker). */
function block(az: number, amp: number, i: number): Float32Array[] {
  const ch = planeWaveChannels(GEOM, az, 1000, 512, i, FS);
  for (const c of ch) for (let k = 0; k < c.length; k++) c[k] = c[k]! * amp;
  return ch;
}

describe('MultiArrayEngine', () => {
  it('combines two kits into one output and selects the modulated talker', async () => {
    const a0 = new ManualCaptureAdapter({ channels: 8 });
    const a1 = new ManualCaptureAdapter({ channels: 8 });
    const mae = new MultiArrayEngine(
      [
        { adapter: a0, config: { geom: GEOM, deviceName: 'k0', sampleRate: FS, azimuthDeg: 45 }, pose: poseA },
        { adapter: a1, config: { geom: GEOM, deviceName: 'k1', sampleRate: FS, azimuthDeg: 315 }, pose: poseB },
      ],
      FS,
      { combiner: { crossfadeBlocks: 4 } },
    );
    const outs: CombinedOutput[] = [];
    mae.onOutput((o) => outs.push(o));
    await mae.start();
    for (let i = 0; i < 80; i++) {
      a0.push(block(45, 0.01, i)); // kit 0: steady-quiet (low speech score)
      a1.push(block(315, i % 2 === 0 ? 0.3 : 0.02, i)); // kit 1: modulated (speech-like)
    }
    await mae.stop();

    expect(outs.length).toBeGreaterThan(0);
    const last = outs.at(-1)!;
    expect(last.mono.length).toBe(512); // one combined block
    for (const v of last.mono) expect(Number.isFinite(v)).toBe(true);
    expect(last.scores.length).toBe(2);
    expect(last.active).toBe(1); // selected the modulated kit
  });

  it('emits one combined block per kit-pair and stop() tears both engines down', async () => {
    const a0 = new ManualCaptureAdapter({ channels: 8 });
    const a1 = new ManualCaptureAdapter({ channels: 8 });
    const mae = new MultiArrayEngine(
      [
        { adapter: a0, config: { geom: GEOM, deviceName: 'k0', sampleRate: FS, azimuthDeg: 0 }, pose: poseA },
        { adapter: a1, config: { geom: GEOM, deviceName: 'k1', sampleRate: FS, azimuthDeg: 0 }, pose: poseB },
      ],
      FS,
    );
    let count = 0;
    mae.onOutput(() => count++);
    await mae.start();
    for (let i = 0; i < 10; i++) {
      a0.push(block(0, 0.2, i));
      a1.push(block(0, 0.2, i));
    }
    expect(count).toBe(10); // one combined output per pushed pair
    await expect(mae.stop()).resolves.toBeUndefined();
    expect(a0.running).toBe(false);
    expect(a1.running).toBe(false);
  });
});
