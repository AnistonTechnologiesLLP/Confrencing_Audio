import { describe, it, expect } from 'vitest';
import {
  createConfig,
  addDevice,
  setRoom,
  rectangularRoom,
  setDevicePosition,
  addTalker,
  createTalker,
  renameDevice,
  createProcessor,
  createMicrophoneArray,
  designReport,
  commissioningReport,
} from '../src/index.js';
import type { CommissioningInfo } from '../src/index.js';
import type { SystemConfig } from '../src/model/index.js';

/** Mirror of Python's `_scene()` fixture in tests/test_report.py. */
function scene(): SystemConfig {
  let c = createConfig({ name: 'Boardroom', createdAt: '2026-06-09T00:00:00Z' });
  c = setRoom(c, rectangularRoom(9, 7, 3));
  c = addDevice(c, createProcessor('P', 'DSP'));
  c = addDevice(c, createMicrophoneArray('A1', 'Ceiling Array', 'automatic'));
  c = setDevicePosition(c, 'A1', { x: 4.5, y: 3.5 });
  c = addTalker(c, createTalker('T1', 'Presenter', { x: 4.5, y: 3.5 }));
  return c;
}

describe('designReport', () => {
  it('markdown has sections and content', () => {
    const md = designReport(scene(), 'markdown');
    expect(typeof md).toBe('string');
    expect(md).toBeTruthy();
    for (const heading of [
      '# Design report',
      '## Devices',
      '## Routing',
      '## AEC references',
      '## Coverage',
      '## Validation',
    ]) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('Ceiling Array');
    expect(md).toContain('Presenter');
  });

  it('html is html and escapes labels', () => {
    const c = renameDevice(scene(), 'A1', 'A<b>x'); // injection attempt
    const out = designReport(c, 'html');
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toContain('<table');
    expect(out).toContain('&lt;b&gt;');
    expect(out).not.toContain('<b>x');
  });

  it('empty config does not crash', () => {
    const md = designReport(createConfig({ name: 'empty', createdAt: 'x' }), 'markdown');
    expect(md).toContain('Room: not defined');
  });

  it('bad format raises', () => {
    // @ts-expect-error — exercising the runtime guard for an unknown format
    expect(() => designReport(scene(), 'pdf')).toThrowError();
  });

  it('report is deterministic', () => {
    const c = scene();
    expect(designReport(c)).toBe(designReport(c));
    expect(designReport(c, 'html')).toBe(designReport(c, 'html'));
  });
});

/** Mirror of Python's commissioning tests in tests/test_report.py (TS↔Py parity). */
describe('commissioningReport', () => {
  it('layers measurements and a sign-off onto the as-built config', () => {
    const info: CommissioningInfo = {
      site: 'HQ Boardroom',
      commissionedBy: 'A. Tech',
      date: '2026-06-18',
      listeningMode: 'Whole table',
      estimatedLatencyMs: 56,
      activeCleaningStages: 'AI cleaner + dereverb',
      aecRefSource: 'WASAPI loopback',
      aecErleDb: 12.3,
      bedReductionDb: 21.7,
      rmsReductionDb: 8,
      frontOffsetDeg: 15,
      silentCapsules: [],
    };
    const md = commissioningReport(scene(), info);
    expect(md.startsWith('# Commissioning report — Boardroom')).toBe(true);
    for (const heading of [
      '## Room',
      '## Devices',
      '## Live measurements',
      '## Health & calibration',
      '## Validation',
      '## Commissioning sign-off',
    ]) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('HQ Boardroom');
    expect(md).toContain('A. Tech');
    expect(md).toContain('~56 ms');
    expect(md).toContain('within the'); // target judged
    expect(md).toContain('12.3 dB');
    expect(md).toContain('21.7 dB quieter');
    expect(md).toContain('all capsules active');
    expect(md).toContain('Checks passing:');
  });

  it('default info is config-only plus a blank sign-off', () => {
    const md = commissioningReport(scene()); // default (empty) info
    expect(md).not.toContain('## Live measurements'); // nothing measured → omitted
    expect(md).not.toContain('## Health & calibration');
    expect(md).toContain('## Devices');
    expect(md).toContain('## Commissioning sign-off');
    expect(md).toContain('________________'); // blank hand-sign form
  });

  it('sign-off reflects validation + missing room', () => {
    const c = addDevice(
      createConfig({ name: 'Bad', createdAt: 'x' }),
      createMicrophoneArray('A1', 'Arr', 'automatic'),
    );
    const md = commissioningReport(c);
    expect(md).toContain('[ ] Room geometry defined'); // room never defined → unticked
    expect(md).toContain('error(s)'); // the no-errors check is always rendered
  });

  it('flags estimated latency above target', () => {
    const md = commissioningReport(scene(), { estimatedLatencyMs: 300 });
    expect(md).toContain('ABOVE the');
    expect(md).toContain('[ ] Estimated latency within target');
  });

  it('lists silent capsules', () => {
    const md = commissioningReport(scene(), { silentCapsules: [5, 6] });
    expect(md).toContain('Silent / disabled capsules: 5, 6');
    expect(md).toContain('[ ] All capsules active (no silent capsules)');
  });

  it('html escapes labels', () => {
    const c = renameDevice(scene(), 'A1', 'A<script>x');
    const out = commissioningReport(c, { estimatedLatencyMs: 56 }, 'html');
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toContain('<table');
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<script>x');
  });

  it('bad format raises', () => {
    // @ts-expect-error — exercising the runtime guard for an unknown format
    expect(() => commissioningReport(scene(), {}, 'pdf')).toThrowError();
  });

  it('is deterministic given info', () => {
    const info: CommissioningInfo = { date: '2026-06-18', estimatedLatencyMs: 56, bedReductionDb: 21.7 };
    const c = scene();
    expect(commissioningReport(c, info)).toBe(commissioningReport(c, info));
  });
});
