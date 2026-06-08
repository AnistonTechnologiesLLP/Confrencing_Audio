import { describe, it, expect } from 'vitest';
import {
  createConfig,
  addDevice,
  route,
  matrixFor,
  setAec,
  autoConfigure,
  validate,
} from '../src/index.js';
import {
  createProcessor,
  createWirelessMic,
  createLoudspeaker,
  createCodec,
} from '../src/devices/factories.js';
import { createMicrophoneArray } from '../src/coverage/coverage.js';

/**
 * Worked scenario (spec §9): two ceiling arrays + one wireless presenter mic +
 * a processor + two loudspeakers + a codec (far-end). The presenter is
 * reinforced locally, so it gets a DEDICATED far-end-only AEC reference bus.
 *
 *   arrays/presenter --route--> processor inputs
 *   presenter + far-end --matrix--> speaker feed (P-out-analog-1) --route--> L1,L2
 *   all mics --matrix--> automix/far-end out (P-out-dante-1) --route--> codec near-end in
 *   far-end only --matrix--> dedicated reference bus (P-out-dante-2)  [presenter AEC ref]
 */
function buildScene() {
  let cfg = createConfig({ name: 'boardroom', createdAt: '2026-06-08T00:00:00Z' });
  cfg = addDevice(cfg, createProcessor('P', 'DSP'));
  cfg = addDevice(cfg, createMicrophoneArray('A1', 'Ceiling Array 1', 'automatic'));
  cfg = addDevice(cfg, createMicrophoneArray('A2', 'Ceiling Array 2', 'automatic'));
  cfg = addDevice(cfg, createWirelessMic('PM', 'Presenter Mic', 'dante'));
  cfg = addDevice(cfg, createLoudspeaker('L1', 'Speaker L', 'analog'));
  cfg = addDevice(cfg, createLoudspeaker('L2', 'Speaker R', 'analog'));
  cfg = addDevice(cfg, createCodec('C', 'Codec', 'dante'));

  // Sources into the processor.
  cfg = route(cfg, 'A1-out-mix', 'P-in-dante-1');
  cfg = route(cfg, 'A2-out-mix', 'P-in-dante-2');
  cfg = route(cfg, 'PM-out-dante-1', 'P-in-dante-3');
  cfg = route(cfg, 'C-out-dante-1', 'P-in-dante-4'); // far-end IN

  // Speaker feed: far-end + reinforced presenter.
  cfg = route(cfg, 'P-out-analog-1', 'L1-in-analog-1');
  cfg = route(cfg, 'P-out-analog-1', 'L2-in-analog-1');
  cfg = matrixFor(cfg, 'P').route('P-in-dante-4', 'P-out-analog-1'); // far-end -> speakers
  cfg = matrixFor(cfg, 'P').route('P-in-dante-3', 'P-out-analog-1'); // presenter -> speakers (reinforcement)

  // Automix / far-end (conferencing) output: all mics summed -> codec near-end in.
  cfg = matrixFor(cfg, 'P').route('P-in-dante-1', 'P-out-dante-1');
  cfg = matrixFor(cfg, 'P').route('P-in-dante-2', 'P-out-dante-1');
  cfg = matrixFor(cfg, 'P').route('P-in-dante-3', 'P-out-dante-1');
  cfg = route(cfg, 'P-out-dante-1', 'C-in-dante-1');

  // Dedicated far-end-ONLY reference bus for the reinforced presenter.
  cfg = matrixFor(cfg, 'P').route('P-in-dante-4', 'P-out-dante-2');

  // AEC: non-reinforced arrays use the speaker feed; presenter uses the dedicated bus.
  cfg = setAec(cfg, 'A1', { enabled: true, referenceBusId: 'P-out-analog-1' });
  cfg = setAec(cfg, 'A2', { enabled: true, referenceBusId: 'P-out-analog-1' });
  cfg = setAec(cfg, 'PM', { enabled: true, referenceBusId: 'P-out-dante-2' });
  return cfg;
}

describe('integration — reference AEC scenario', () => {
  it('the correctly-built scene validates with no errors', () => {
    const res = validate(buildScene());
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('removing the dedicated reference (presenter lands on the shared mic bus) → AEC_SELF_REFERENCE', () => {
    let cfg = buildScene();
    // Drop the dedicated far-end-only reference; presenter falls back to the
    // automix/far-end output bus, which now contains the presenter itself.
    cfg = setAec(cfg, 'PM', { enabled: true, referenceBusId: 'P-out-dante-1' });
    const res = validate(cfg);
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain('AEC_SELF_REFERENCE');
  });

  it('pointing the reinforced presenter at the speaker feed → AEC_REINFORCED_SHARED_REFERENCE', () => {
    let cfg = buildScene();
    cfg = setAec(cfg, 'PM', { enabled: true, referenceBusId: 'P-out-analog-1' });
    const res = validate(cfg);
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain('AEC_REINFORCED_SHARED_REFERENCE');
  });

  it('autoConfigure on the raw routed scene yields a config with no validation errors', () => {
    // Strip AEC assignments, keep routing; let autoConfigure resolve references.
    let cfg = buildScene();
    cfg = setAec(cfg, 'A1', { enabled: false, referenceBusId: null });
    cfg = setAec(cfg, 'A2', { enabled: false, referenceBusId: null });
    cfg = setAec(cfg, 'PM', { enabled: false, referenceBusId: null });
    const configured = autoConfigure(cfg);
    const res = validate(configured);
    expect(res.errors).toEqual([]);
  });
});
