import { describe, it, expect } from 'vitest';
import { KitSelector, DEFAULT_SWITCH_MARGIN, DEFAULT_SPEECH_THRESHOLD } from '../src/live/kit-selector.js';

describe('KitSelector', () => {
  it('throws on a score-count mismatch', () => {
    const s = new KitSelector({ nKits: 2 });
    expect(() => s.update([0.5], 0)).toThrow();
  });

  it('starts on kit 0; a clearly-louder talker on kit 1 switches (fast attack)', () => {
    const s = new KitSelector({ nKits: 2 });
    const r = s.update([0.1, 0.9], 0); // kit 1 well above kit 0 + margin and the threshold
    expect(r.active).toBe(1);
    expect(r.switching).toBe(true);
    expect(r.speechPresent).toBe(true);
    expect(r.scores).toEqual([0.1, 0.9]);
  });

  it('does NOT switch when the challenger only marginally beats the incumbent (< switchMargin)', () => {
    const s = new KitSelector({ nKits: 2, switchMargin: DEFAULT_SWITCH_MARGIN });
    // incumbent 0 at 0.5; challenger 1 at 0.5 + 0.05 (< 0.12 margin) → hold incumbent
    const r = s.update([0.5, 0.55], 0);
    expect(r.active).toBe(0);
    expect(r.switching).toBe(false);
  });

  it('never switches TO a non-talker (best below the speech threshold)', () => {
    const s = new KitSelector({ nKits: 2, speechThreshold: DEFAULT_SPEECH_THRESHOLD });
    // both kits below threshold (fan-only room) → hold kit 0, no switch
    const r = s.update([0.05, 0.1], 0);
    expect(r.active).toBe(0);
    expect(r.switching).toBe(false);
    expect(r.speechPresent).toBe(false);
  });

  it('coasts speechPresent through a brief pause (holdSeconds) then drops', () => {
    const s = new KitSelector({ nKits: 2, holdSeconds: 0.4 });
    s.update([0.1, 0.9], 0); // speech at t=0
    expect(s.update([0.05, 0.05], 0.3).speechPresent).toBe(true); // within hold
    expect(s.update([0.05, 0.05], 0.6).speechPresent).toBe(false); // past hold (t - 0 > 0.4)
  });

  it('holds the active kit across the pause (does not reset to kit 0)', () => {
    const s = new KitSelector({ nKits: 2 });
    s.update([0.1, 0.9], 0); // switch to kit 1
    const r = s.update([0.05, 0.05], 0.2); // silence within hold
    expect(r.active).toBe(1); // still kit 1
  });

  it('reset() returns to kit 0 / no speaker', () => {
    const s = new KitSelector({ nKits: 2 });
    s.update([0.1, 0.9], 0);
    s.reset();
    const r = s.update([0.05, 0.05], 0);
    expect(r.active).toBe(0);
    expect(r.speechPresent).toBe(false);
  });
});
