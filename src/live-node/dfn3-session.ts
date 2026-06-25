/**
 * Node-only DeepFilterNet3 inference session: the host glue that lets the **synchronous** {@link Dfn3Session}
 * seam (the cleaner runs sync, like the Python) be satisfied by **asynchronous** `onnxruntime-node.run()`.
 *
 * onnxruntime-node only exposes an async `run()`, but {@link Dfn3Cleaner} calls `session.run(frame, states)`
 * synchronously inside the realtime block. We bridge async→sync with a **worker thread + SharedArrayBuffer +
 * Atomics**: the cleaner writes the frame/state into the SAB and `Atomics.wait`s; the worker (its own event
 * loop, so it CAN await the async inference) reads the SAB, runs ONNX, writes the result back, and
 * `Atomics.notify`s — unblocking the cleaner. This is the same blocking-per-frame shape the Python's sync
 * `ort` already has; the inference is sub-millisecond so the block stall is bounded.
 *
 * `src/live/` stays browser-safe — this module (worker_threads, SAB) lives in the node subpath. The ONNX
 * worker lazy-`require`s `onnxruntime-node` and falls back to **identity passthrough on any error** (missing
 * peer-dep, missing model, bad I/O names) so a misconfigured host degrades to raw audio, never a crash. The
 * model is NOT bundled; the host passes `modelPath`. The worker is injected as a source string so the bridge
 * mechanism is testable with a stub (no real ONNX in CI).
 */
import { Worker } from 'node:worker_threads';
import type { Dfn3Session } from '../live/dfn3-cleaner.js';
import { DFN3_HOP, DFN3_STATE_LEN } from '../live/dfn3-cleaner.js';

/** SAB control-word states (Int32, the Atomics futex). */
const REQUEST = 1;
const DONE = 2;

/** A {@link Dfn3Session} backed by a worker thread, plus a `close()` to terminate it. */
export interface Dfn3SyncSession extends Dfn3Session {
  close(): Promise<void>;
}

export interface Dfn3SyncSessionOptions {
  /** Worker module source (CommonJS). Defaults to {@link DFN3_ONNX_WORKER_SOURCE} (real onnxruntime-node). */
  workerSource?: string;
  /** Extra data merged into the worker's `workerData` (e.g. `{ modelPath, attenLimDb }`). */
  workerData?: Record<string, unknown>;
  /** Max wait per inference before `run()` throws (default 2000 ms). */
  timeoutMs?: number;
}

/** Byte offsets into the SAB: [ctrl i32][frame f32·HOP][statesIn f32·STATE][out f32·HOP][statesOut f32·STATE]. */
const CTRL_BYTES = 4;
const FRAME_OFF = CTRL_BYTES;
const STATES_IN_OFF = FRAME_OFF + DFN3_HOP * 4;
const OUT_OFF = STATES_IN_OFF + DFN3_STATE_LEN * 4;
const STATES_OUT_OFF = OUT_OFF + DFN3_HOP * 4;
const SAB_BYTES = STATES_OUT_OFF + DFN3_STATE_LEN * 4;

/**
 * Build a synchronous DFN3 session over a worker thread. The returned `run()` blocks the calling thread
 * until the worker responds (or `timeoutMs` elapses → throws). `close()` terminates the worker.
 */
export function createDfn3SyncSession(opts: Dfn3SyncSessionOptions = {}): Dfn3SyncSession {
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const ctrl = new Int32Array(sab, 0, 1);
  const frameView = new Float32Array(sab, FRAME_OFF, DFN3_HOP);
  const statesInView = new Float32Array(sab, STATES_IN_OFF, DFN3_STATE_LEN);
  const outView = new Float32Array(sab, OUT_OFF, DFN3_HOP);
  const statesOutView = new Float32Array(sab, STATES_OUT_OFF, DFN3_STATE_LEN);

  const timeoutMs = opts.timeoutMs ?? 2000;
  const source = opts.workerSource ?? DFN3_ONNX_WORKER_SOURCE;
  const worker = new Worker(source, {
    eval: true,
    workerData: { sab, hop: DFN3_HOP, stateLen: DFN3_STATE_LEN, ...(opts.workerData ?? {}) },
  });
  let workerError: Error | null = null;
  worker.on('error', (e) => {
    workerError = e instanceof Error ? e : new Error(String(e));
  });

  return {
    run(frame: Float32Array, states: Float32Array): { out: Float32Array; states: Float32Array } {
      if (workerError !== null) throw workerError;
      frameView.set(frame.subarray(0, DFN3_HOP));
      statesInView.set(states.subarray(0, DFN3_STATE_LEN));
      Atomics.store(ctrl, 0, REQUEST);
      worker.postMessage(0); // wake the worker's event loop (it reads the SAB, infers, notifies)
      const r = Atomics.wait(ctrl, 0, REQUEST, timeoutMs);
      if (r === 'timed-out') throw new Error(`dfn3 worker did not respond within ${timeoutMs}ms`);
      if (Atomics.load(ctrl, 0) !== DONE) {
        if (workerError !== null) throw workerError;
        throw new Error('dfn3 worker signaled an unexpected state');
      }
      // copy out of the shared buffer before the next request overwrites it
      return { out: outView.slice(), states: statesOutView.slice() };
    },
    async close(): Promise<void> {
      await worker.terminate();
    },
  };
}

/**
 * The real onnxruntime-node worker (CommonJS source string). Lazy-`require`s `onnxruntime-node`, creates the
 * single-threaded inference session from `workerData.modelPath`, and on each request runs one DFN3 frame
 * (inputs `input_frame`/`states`/`atten_lim_db`; outputs taken in declared order: cleaned frame, new states).
 * **Any error → identity passthrough** (`out = frame`, `statesOut = statesIn`) so the cleaner gets raw audio.
 * Not exercised in CI (needs the model + peer-dep); the bridge mechanism is covered with a stub worker.
 */
export const DFN3_ONNX_WORKER_SOURCE = `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { sab, hop, stateLen, modelPath, attenLimDb } = workerData;
const ctrl = new Int32Array(sab, 0, 1);
const frame = new Float32Array(sab, 4, hop);
const statesIn = new Float32Array(sab, 4 + hop * 4, stateLen);
const out = new Float32Array(sab, 4 + hop * 4 + stateLen * 4, hop);
const statesOut = new Float32Array(sab, 4 + hop * 4 + stateLen * 4 + hop * 4, stateLen);

let ort = null, sess = null, atten = null, ready = false;
async function ensure() {
  if (ready) return;
  ort = require('onnxruntime-node');
  sess = await ort.InferenceSession.create(modelPath, {
    intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential',
  });
  atten = new ort.Tensor('float32', Float32Array.from([typeof attenLimDb === 'number' ? attenLimDb : 32.0]), []);
  ready = true;
}

parentPort.on('message', async () => {
  try {
    await ensure();
    const res = await sess.run({
      input_frame: new ort.Tensor('float32', frame.slice(), [hop]),
      states: new ort.Tensor('float32', statesIn.slice(), [stateLen]),
      atten_lim_db: atten,
    });
    const keys = sess.outputNames || Object.keys(res);
    out.set(res[keys[0]].data.subarray(0, hop));
    statesOut.set(res[keys[1]].data.subarray(0, stateLen));
  } catch (e) {
    out.set(frame); // identity passthrough on any failure
    statesOut.set(statesIn);
  }
  Atomics.store(ctrl, 0, 2);
  Atomics.notify(ctrl, 0);
});
`;
