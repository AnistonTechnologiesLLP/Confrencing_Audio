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
} from '../src/index.js';
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
