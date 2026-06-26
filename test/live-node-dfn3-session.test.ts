import { describe, it, expect } from 'vitest';
import { createDfn3SyncSession } from '../src/live-node/dfn3-session.js';
import { Dfn3Cleaner, DFN3_HOP, DFN3_STATE_LEN } from '../src/live/dfn3-cleaner.js';

/**
 * Stub worker (CommonJS source): out = 0.5·frame, statesOut = statesIn + 1, echoing the request seq into
 * respSeq (index 1). Proves the SAB layout + the generation request/response round-trip + state carry —
 * without any real onnxruntime. Offsets: two Int32 control words (8 bytes), then the float regions.
 */
const STUB_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { sab, hop, stateLen } = workerData;
const ctrl = new Int32Array(sab, 0, 2);
const frame = new Float32Array(sab, 8, hop);
const statesIn = new Float32Array(sab, 8 + hop * 4, stateLen);
const out = new Float32Array(sab, 8 + hop * 4 + stateLen * 4, hop);
const statesOut = new Float32Array(sab, 8 + hop * 4 + stateLen * 4 + hop * 4, stateLen);
parentPort.on('message', (seq) => {
  for (let i = 0; i < hop; i++) out[i] = frame[i] * 0.5;
  for (let i = 0; i < stateLen; i++) statesOut[i] = statesIn[i] + 1;
  Atomics.store(ctrl, 1, seq);
  Atomics.notify(ctrl, 1);
});
`;

/** A worker that never replies — to exercise the run() timeout path. */
const SILENT_WORKER = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', () => { /* deliberately never notifies */ });
`;

/** Drops the FIRST request (→ that run() times out), then responds normally — proves timeout is recoverable. */
const SKIP_FIRST_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { sab, hop, stateLen } = workerData;
const ctrl = new Int32Array(sab, 0, 2);
const frame = new Float32Array(sab, 8, hop);
const out = new Float32Array(sab, 8 + hop * 4 + stateLen * 4, hop);
let n = 0;
parentPort.on('message', (seq) => {
  if (++n === 1) return; // drop the first → run() #1 times out
  for (let i = 0; i < hop; i++) out[i] = frame[i];
  Atomics.store(ctrl, 1, seq);
  Atomics.notify(ctrl, 1);
});
`;

describe('createDfn3SyncSession (async->sync worker bridge)', () => {
  it('round-trips a frame synchronously through the worker (SAB + generation protocol)', async () => {
    const sess = createDfn3SyncSession({ workerSource: STUB_WORKER });
    const frame = Float32Array.from({ length: DFN3_HOP }, (_v, i) => Math.sin(i * 0.1));
    const states = new Float32Array(DFN3_STATE_LEN); // zeros
    const r1 = sess.run(frame, states);
    expect(r1.out.length).toBe(DFN3_HOP);
    expect(r1.states.length).toBe(DFN3_STATE_LEN);
    for (let i = 0; i < DFN3_HOP; i++) expect(r1.out[i]).toBeCloseTo(frame[i]! * 0.5, 5);
    expect(r1.states[0]).toBeCloseTo(1, 5); // state advanced once
    // the returned views are copies (next run must not mutate the prior result)
    const r2 = sess.run(frame, r1.states);
    expect(r2.states[0]).toBeCloseTo(2, 5);
    expect(r1.states[0]).toBeCloseTo(1, 5); // r1 untouched by r2
    await sess.close();
  });

  it('drives the Dfn3Cleaner end-to-end via the worker session', async () => {
    const sess = createDfn3SyncSession({ workerSource: STUB_WORKER });
    const cleaner = new Dfn3Cleaner(48000, { session: sess }); // sr==48k → no resampler, frame-aligned
    let sawOutput = false;
    for (let b = 0; b < 20; b++) {
      const block = Float32Array.from({ length: 480 }, (_v, i) => 0.2 * Math.sin((b * 480 + i) * 0.05));
      const out = cleaner.process(block, false);
      expect(out.length).toBe(480);
      for (const v of out) expect(Number.isFinite(v)).toBe(true);
      if (out.some((v) => v !== 0)) sawOutput = true;
    }
    expect(sawOutput).toBe(true); // the cleaned audio flowed through the worker
    await sess.close();
  });

  it('throws when the worker does not respond within the timeout', async () => {
    const sess = createDfn3SyncSession({ workerSource: SILENT_WORKER, timeoutMs: 150 });
    expect(() => sess.run(new Float32Array(DFN3_HOP), new Float32Array(DFN3_STATE_LEN))).toThrow(/did not respond/);
    await sess.close();
  });

  it('recovers after a timeout — a transient stall does not permanently brick the session', async () => {
    const sess = createDfn3SyncSession({ workerSource: SKIP_FIRST_WORKER, timeoutMs: 120 });
    const frame = Float32Array.from({ length: DFN3_HOP }, (_v, i) => Math.cos(i * 0.07));
    const states = new Float32Array(DFN3_STATE_LEN);
    expect(() => sess.run(frame, states)).toThrow(/did not respond/); // 1st request dropped → timeout
    const r = sess.run(frame, states); // SAME session — must work again (no latched error, no stale read)
    for (let i = 0; i < DFN3_HOP; i++) expect(r.out[i]).toBeCloseTo(frame[i]!, 5);
    await sess.close();
  });
});
