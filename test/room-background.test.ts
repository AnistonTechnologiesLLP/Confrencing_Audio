import { describe, it, expect } from 'vitest';
import {
  createConfig,
  setRoom,
  rectangularRoom,
  setRoomBackground,
  setRoomBackgroundScale,
  clearRoomBackground,
  calibratedScale,
  serialize,
  deserialize,
} from '../src/index.js';

/** Mirrors the Python `_room_cfg()` helper: a config with a 10x8x3 rectangular room. */
function roomCfg() {
  return setRoom(createConfig({ name: 'bg', createdAt: 'x' }), rectangularRoom(10, 8, 3));
}

describe('floor-plan background (engine): round-trip, builders, calibration math', () => {
  it('test_set_and_roundtrip', () => {
    let c = roomCfg();
    c = setRoomBackground(c, {
      path: 'plan.png',
      imageWidthPx: 1000,
      imageHeightPx: 800,
      scaleMPerPx: 0.01,
      origin: { x: 0, y: 0 },
      opacity: 0.6,
    });
    expect(serialize(deserialize(serialize(c)))).toBe(serialize(c));
    const bg = c.room!.background!;
    expect(bg.path).toBe('plan.png');
    expect(bg.imageWidthPx).toBe(1000);
    expect(bg.scaleMPerPx).toBe(0.01);
    expect(bg.opacity).toBe(0.6);
  });

  it('test_none_background_omitted_from_json', () => {
    const obj = JSON.parse(serialize(roomCfg()));
    expect('background' in obj.room).toBe(false);
  });

  it('test_uncalibrated_scale_omitted_and_roundtrips', () => {
    const c = setRoomBackground(roomCfg(), {
      path: 'plan.png',
      imageWidthPx: 800,
      imageHeightPx: 600,
    }); // no scale
    const obj = JSON.parse(serialize(c));
    expect('scaleMPerPx' in obj.room.background).toBe(false);
    expect(deserialize(serialize(c)).room!.background!.scaleMPerPx).toBeUndefined();
  });

  it('test_set_scale_preserves_other_fields', () => {
    let c = setRoomBackground(roomCfg(), {
      path: 'p.png',
      imageWidthPx: 100,
      imageHeightPx: 100,
      scaleMPerPx: 0.02,
      origin: { x: 1, y: 2 },
      opacity: 0.4,
    });
    c = setRoomBackgroundScale(c, 0.05);
    const bg = c.room!.background!;
    expect(bg.scaleMPerPx).toBe(0.05);
    expect(bg.origin).toEqual({ x: 1, y: 2 });
    expect(bg.opacity).toBe(0.4);
    expect(bg.path).toBe('p.png');
  });

  it('test_clear_background', () => {
    const c = setRoomBackground(roomCfg(), {
      path: 'p.png',
      imageWidthPx: 10,
      imageHeightPx: 10,
    });
    expect(clearRoomBackground(c).room!.background).toBeUndefined();
  });

  it('test_calibrated_scale_math', () => {
    // a line spanning 2 m on the floor that's really 4 m -> scale doubles
    expect(calibratedScale(0.01, 2.0, 4.0)).toBeCloseTo(0.02, 12);
    expect(() => calibratedScale(0.01, 0.0, 4.0)).toThrow();
  });

  it('test_opacity_clamped', () => {
    const c = setRoomBackground(roomCfg(), {
      path: 'p.png',
      imageWidthPx: 10,
      imageHeightPx: 10,
      opacity: 5.0,
    });
    expect(c.room!.background!.opacity).toBe(1.0);
  });

  it('test_no_room_raises', () => {
    expect(() =>
      setRoomBackground(createConfig({ name: 'x', createdAt: 'y' }), {
        path: 'p.png',
        imageWidthPx: 10,
        imageHeightPx: 10,
      }),
    ).toThrow();
  });
});
