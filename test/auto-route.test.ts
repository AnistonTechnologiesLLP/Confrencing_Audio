/**
 * Auto-Route tests (pure engine). Mirrors the Python pytest suite
 * `tests/test_auto_route.py`. The cardinal invariant: the result must validate
 * with zero errors (the AEC self-reference rule) and be idempotent.
 */
import { describe, it, expect } from 'vitest';
import {
  createConfig,
  addDevice,
  route,
  autoRoute,
  autoConfigure,
  validate,
  serialize,
  createProcessor,
  createMicrophoneArray,
  createCodec,
  createLoudspeaker,
  getPrimaryProcessor,
  isMicDevice,
  analyzeAecReference,
} from '../src/index.js';

function scene() {
  let c = createConfig({ name: 'ar', createdAt: '2026-06-09T00:00:00Z' });
  c = addDevice(c, createProcessor('P', 'DSP'));
  c = addDevice(c, createMicrophoneArray('A1', 'Array', 'automatic'));
  c = addDevice(c, createCodec('C', 'Codec', 'dante'));
  c = addDevice(c, createLoudspeaker('L1', 'Speaker', 'analog'));
  c = route(c, 'A1-out-mix', 'P-in-dante-1');
  c = route(c, 'C-out-dante-1', 'P-in-dante-2');
  return c;
}

describe('auto_route', () => {
  it('validates clean (no errors) and produces a non-empty change summary', () => {
    const res = autoRoute(scene());
    expect(validate(res.config).errors).toEqual([]);
    expect(res.changes.length).toBeGreaterThan(0); // non-empty summary
  });

  it('is AEC self-reference safe for every mic', () => {
    const res = autoRoute(scene());
    const proc = getPrimaryProcessor(res.config)!;
    for (const m of res.config.devices.filter(isMicDevice)) {
      const analysis = analyzeAecReference(res.config, proc, m.id, m.aec.referenceBusId);
      expect(analysis.containsOwnSignal).toBe(false);
    }
  });

  it('feeds the loudspeaker', () => {
    const res = autoRoute(scene());
    expect(res.config.routes.some((r) => r.toPortId === 'L1-in-analog-1')).toBe(true);
    expect(res.counts.routes ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('creates exactly one mute link', () => {
    const res = autoRoute(scene());
    expect(res.config.muteLinks.length).toBeGreaterThan(0);
    expect(res.counts.muteLinks ?? 0).toBe(1);
  });

  it('is idempotent (second run reports "No changes" and identical serialization)', () => {
    const once = autoRoute(scene()).config;
    const twice = autoRoute(once);
    expect(twice.changes).toEqual(['No changes — the design is already routed.']);
    expect(serialize(twice.config)).toBe(serialize(once));
  });

  it('no processor — returns the input config unchanged with a "No processor" message', () => {
    const c = createConfig({ name: 'np', createdAt: 'x' });
    const res = autoRoute(c);
    expect(res.config).toBe(c);
    expect(res.changes[0]).toContain('No processor');
  });

  it('no codec or loudspeaker still validates with no errors', () => {
    let c = createConfig({ name: 'min', createdAt: 'x' });
    c = addDevice(c, createProcessor('P', 'DSP'));
    c = addDevice(c, createMicrophoneArray('A1', 'A', 'automatic'));
    c = route(c, 'A1-out-mix', 'P-in-dante-1');
    const res = autoRoute(c);
    expect(validate(res.config).errors).toEqual([]);
  });

  it('auto_configure remains unchanged regression (validates standalone)', () => {
    // auto_route builds on auto_configure; the latter must still work standalone
    const res = autoConfigure(scene());
    expect(validate(res).errors).toEqual([]);
  });
});
