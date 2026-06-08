import { describe, it, expect } from 'vitest';
import {
  createConfig,
  addDevice,
  route,
  matrixFor,
  setAec,
  validate,
} from '../src/index.js';
import {
  createProcessor,
  createWirelessMic,
  createLoudspeaker,
  createCodec,
} from '../src/devices/factories.js';
import type { SystemConfig } from '../src/model/config.js';

/**
 * Build a base scene: processor P, wireless mic M (reinforced to loudspeaker S),
 * codec C providing the far-end. Returns ids and the config.
 */
function scene(): SystemConfig {
  let cfg = createConfig({ name: 'aec', createdAt: '2026-01-01T00:00:00Z' });
  cfg = addDevice(cfg, createProcessor('P', 'Processor'));
  cfg = addDevice(cfg, createWirelessMic('M', 'Presenter', 'dante'));
  cfg = addDevice(cfg, createLoudspeaker('S', 'Speaker', 'analog'));
  cfg = addDevice(cfg, createCodec('C', 'Codec', 'dante'));

  // Mic and far-end into the processor.
  cfg = route(cfg, 'M-out-dante-1', 'P-in-dante-1'); // mic -> input bus P-in-dante-1
  cfg = route(cfg, 'C-out-dante-1', 'P-in-dante-2'); // far-end -> input bus P-in-dante-2

  // Speaker feed (analog out 1): plays far-end + the (reinforced) mic.
  cfg = route(cfg, 'P-out-analog-1', 'S-in-analog-1');
  cfg = matrixFor(cfg, 'P').route('P-in-dante-1', 'P-out-analog-1'); // mic -> speakers (reinforcement)
  cfg = matrixFor(cfg, 'P').route('P-in-dante-2', 'P-out-analog-1'); // far-end -> speakers
  return cfg;
}

const codesOf = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('AEC self-reference detection', () => {
  it('POSITIVE: reinforced mic referencing its own speaker feed → AEC_REINFORCED_SHARED_REFERENCE', () => {
    let cfg = scene();
    // Trap: AEC reference is the very speaker-feed bus that carries the mic.
    cfg = setAec(cfg, 'M', { enabled: true, referenceBusId: 'P-out-analog-1' });
    const res = validate(cfg);
    expect(res.ok).toBe(false);
    expect(codesOf(res.errors)).toContain('AEC_REINFORCED_SHARED_REFERENCE');
  });

  it('POSITIVE: reference bus that carries the mic but is not a speaker feed → AEC_SELF_REFERENCE', () => {
    let cfg = scene();
    // Sum the mic (and far-end) into an unused output bus, then reference it.
    cfg = matrixFor(cfg, 'P').route('P-in-dante-1', 'P-out-dante-1'); // mic into the ref bus
    cfg = matrixFor(cfg, 'P').route('P-in-dante-2', 'P-out-dante-1'); // far-end into the ref bus
    cfg = setAec(cfg, 'M', { enabled: true, referenceBusId: 'P-out-dante-1' });
    const res = validate(cfg);
    expect(res.ok).toBe(false);
    expect(codesOf(res.errors)).toContain('AEC_SELF_REFERENCE');
    expect(codesOf(res.errors)).not.toContain('AEC_REINFORCED_SHARED_REFERENCE');
  });

  it('NEGATIVE: dedicated far-end-only reference bus → passes', () => {
    let cfg = scene();
    // Far-end only (NOT the mic) into an unused output bus; reference that.
    cfg = matrixFor(cfg, 'P').route('P-in-dante-2', 'P-out-dante-2');
    cfg = setAec(cfg, 'M', { enabled: true, referenceBusId: 'P-out-dante-2' });
    const res = validate(cfg);
    expect(res.ok).toBe(true);
    expect(codesOf(res.errors)).toHaveLength(0);
  });

  it('WARNING: AEC enabled with no reference assigned → AEC_REFERENCE_MISSING', () => {
    let cfg = scene();
    cfg = setAec(cfg, 'M', { enabled: true, referenceBusId: null });
    const res = validate(cfg);
    expect(res.ok).toBe(true); // warning, not error
    expect(codesOf(res.warnings)).toContain('AEC_REFERENCE_MISSING');
  });

  it('WARNING: reference bus with no sources → AEC_REFERENCE_EMPTY', () => {
    let cfg = scene();
    cfg = setAec(cfg, 'M', { enabled: true, referenceBusId: 'P-out-dante-3' }); // nothing routed in
    const res = validate(cfg);
    expect(res.ok).toBe(true);
    expect(codesOf(res.warnings)).toContain('AEC_REFERENCE_EMPTY');
  });

  it('disabled AEC produces no AEC diagnostics', () => {
    let cfg = scene();
    cfg = setAec(cfg, 'M', { enabled: false, referenceBusId: 'P-out-analog-1' });
    const res = validate(cfg);
    const aecCodes = [...res.errors, ...res.warnings]
      .map((i) => i.code)
      .filter((c) => c.startsWith('AEC_'));
    expect(aecCodes).toHaveLength(0);
  });
});
