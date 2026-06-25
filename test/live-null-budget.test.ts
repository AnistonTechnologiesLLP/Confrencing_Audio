import { describe, it, expect } from 'vitest';
import { composeNulls, NULL_MIN_SEP_DEG, NULL_MERGE_SEP_DEG } from '../src/live/null-budget.js';

describe('composeNulls', () => {
  it('returns [] when budget <= 0', () => {
    expect(composeNulls(0, [90, 180], 0)).toEqual([]);
  });

  it('detected interferers win the budget', () => {
    const out = composeNulls(0, [60, 120, 200], 7, { exclusion: [90], seats: [150] });
    expect(out.slice(0, 3)).toEqual([60, 120, 200]); // detected first, in order
  });

  it('drops a null within 8° of the look (would null the target)', () => {
    expect(composeNulls(0, [5, 90], 7)).toEqual([90]); // 5° dropped
    expect(composeNulls(0, [], 7, { exclusion: [4] })).toEqual([]); // 4° exclusion dropped
  });

  it('dedupes within 6° across sources (one null per constraint)', () => {
    // detected 90; exclusion 93 (within 6° of detected) → dropped
    expect(composeNulls(0, [90], 7, { exclusion: [93] })).toEqual([90]);
    // two near-duplicate detected collapse to one
    expect(composeNulls(0, [90, 94], 7)).toEqual([90]);
  });

  it('fills detected, then exclusions, then seats (precedence) and caps at budget', () => {
    const out = composeNulls(0, [60], 3, { exclusion: [120], seats: [180, 240] });
    // detected, exclusion, then the NEAREST seat (240° is sep 120 from 0° vs 180° at sep 180); capped at 3
    expect(out).toEqual([60, 120, 240]);
  });

  it('orders seats nearest-to-look first and respects seatNullMaxCount', () => {
    const out = composeNulls(0, [], 7, { seats: [200, 100, 160], seatNullMaxCount: 2 });
    // nearest-to-look (wrap-aware): 100 (sep 100), 160 (sep 160), 200 (sep 160) → 100 then 160; capped 2
    expect(out.length).toBe(2);
    expect(out[0]).toBe(100);
  });

  it('drops an exclusion/seat that does not fit the remaining budget', () => {
    const out = composeNulls(0, [40, 80, 130], 3, { exclusion: [170], seats: [220] });
    expect(out).toEqual([40, 80, 130]); // budget full on detected; exclusion+seat dropped
  });

  it('exposes the Python-parity constants', () => {
    expect(NULL_MIN_SEP_DEG).toBe(8);
    expect(NULL_MERGE_SEP_DEG).toBe(6);
  });
});
