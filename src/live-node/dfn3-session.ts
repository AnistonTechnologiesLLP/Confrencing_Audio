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
 * **Generation protocol.** The control region is two Int32 words: `[reqSeq, respSeq]`. Each `run()` stamps a
 * fresh monotonic `reqSeq` and waits until `respSeq` echoes it. The worker writes the result THEN stores
 * `respSeq = reqSeq`. This makes a timeout **recoverable**: a slow worker's late response carries an OLD
 * seq, so the next `run()` (waiting on a higher seq) skips it instead of mis-reading a stale result — and a
 * single transient stall does not permanently brick the session. Only a real worker `error` (a crash) is
 * terminal. `timeoutMs` defaults to a small audio-appropriate bound (a hung worker should not block the
 * audio thread for seconds); on timeout `run()` throws and the cleaner falls back to raw passthrough.
 *
 * **Realtime note (load-bearing).** `run()` blocks the calling thread by design (the sync seam). The worker
 * starts loading the model the instant it spawns (not on the first frame), so cold-load happens during host
 * setup, off the audio callback — but the host should still drive a few priming frames before going live.
 * The host that creates the session **owns `close()`** (the engine/cleaner only borrow the seam).
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

/** Control-word indices (Int32, the Atomics futex words): request seq, response seq. */
const REQ_IDX = 0;
const RESP_IDX = 1;
const CTRL_BYTES = 8; // two Int32 control words
const MAX_SEQ = 0x7fffffff;

/** Default per-inference wait. Small: a hung worker must not block the audio thread for seconds. */
const DEFAULT_TIMEOUT_MS = 250;

/** A {@link Dfn3Session} backed by a worker thread, plus a `close()` to terminate it. */
export interface Dfn3SyncSession extends Dfn3Session {
  close(): Promise<void>;
}

export interface Dfn3SyncSessionOptions {
  /** Worker module source (CommonJS). Defaults to {@link DFN3_ONNX_WORKER_SOURCE} (real onnxruntime-node). */
  workerSource?: string;
  /** Extra data merged into the worker's `workerData` (e.g. `{ modelPath, attenLimDb }`). */
  workerData?: Record<string, unknown>;
  /** Max wait per inference before `run()` throws (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/** Byte offsets into the SAB: [reqSeq i32][respSeq i32][frame f32·HOP][statesIn f32·STATE][out f32·HOP][statesOut f32·STATE]. */
const FRAME_OFF = CTRL_BYTES;
const STATES_IN_OFF = FRAME_OFF + DFN3_HOP * 4;
const OUT_OFF = STATES_IN_OFF + DFN3_STATE_LEN * 4;
const STATES_OUT_OFF = OUT_OFF + DFN3_HOP * 4;
const SAB_BYTES = STATES_OUT_OFF + DFN3_STATE_LEN * 4;

/**
 * Build a synchronous DFN3 session over a worker thread. The returned `run()` blocks the calling thread
 * until the worker echoes the request's generation (or `timeoutMs` elapses → throws, recoverably).
 * `close()` terminates the worker.
 */
export function createDfn3SyncSession(opts: Dfn3SyncSessionOptions = {}): Dfn3SyncSession {
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const ctrl = new Int32Array(sab, 0, 2);
  const frameView = new Float32Array(sab, FRAME_OFF, DFN3_HOP);
  const statesInView = new Float32Array(sab, STATES_IN_OFF, DFN3_STATE_LEN);
  const outView = new Float32Array(sab, OUT_OFF, DFN3_HOP);
  const statesOutView = new Float32Array(sab, STATES_OUT_OFF, DFN3_STATE_LEN);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const source = opts.workerSource ?? DFN3_ONNX_WORKER_SOURCE;
  const worker = new Worker(source, {
    eval: true,
    workerData: { sab, hop: DFN3_HOP, stateLen: DFN3_STATE_LEN, ...(opts.workerData ?? {}) },
  });
  worker.unref(); // a borrowed worker must not keep the host process alive; close() reaps it
  let workerError: Error | null = null;
  worker.on('error', (e) => {
    workerError = e instanceof Error ? e : new Error(String(e)); // a crashed worker is terminal (no recovery)
  });
  let seq = 0;

  return {
    run(frame: Float32Array, states: Float32Array): { out: Float32Array; states: Float32Array } {
      if (workerError !== null) throw workerError;
      frameView.set(frame.subarray(0, DFN3_HOP));
      statesInView.set(states.subarray(0, DFN3_STATE_LEN));
      seq = seq >= MAX_SEQ ? 1 : seq + 1; // monotonic generation, wraps, never 0 (respSeq starts at 0)
      Atomics.store(ctrl, REQ_IDX, seq);
      worker.postMessage(seq); // wake the worker (it reads the SAB, infers, echoes seq into respSeq, notifies)
      const deadline = Date.now() + timeoutMs;
      let cur = Atomics.load(ctrl, RESP_IDX);
      while (cur !== seq) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`dfn3 worker did not respond within ${timeoutMs}ms`);
        Atomics.wait(ctrl, RESP_IDX, cur, remaining);
        if (workerError !== null) throw workerError; // worker crashed (observable once wait returns)
        cur = Atomics.load(ctrl, RESP_IDX); // a stale (older-seq) response just loops; ours sets cur === seq
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
 * single-threaded inference session from `workerData.modelPath` **eagerly at spawn** (so cold-load happens
 * off the first audio frame), and on each request runs one DFN3 frame (inputs `input_frame`/`states`/
 * `atten_lim_db`; outputs taken in declared order: cleaned frame, new states), then echoes the request seq
 * into `respSeq`. **Any error → identity passthrough** (`out = frame`, `statesOut = statesIn`) so the cleaner
 * gets raw audio. Not exercised in CI (needs the model + peer-dep); the bridge is covered with a stub worker.
 */
export const DFN3_ONNX_WORKER_SOURCE = `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { sab, hop, stateLen, modelPath, attenLimDb } = workerData;
const RESP = 1;
const ctrl = new Int32Array(sab, 0, 2);
const frame = new Float32Array(sab, 8, hop);
const statesIn = new Float32Array(sab, 8 + hop * 4, stateLen);
const out = new Float32Array(sab, 8 + hop * 4 + stateLen * 4, hop);
const statesOut = new Float32Array(sab, 8 + hop * 4 + stateLen * 4 + hop * 4, stateLen);

let ort = null, sess = null, atten = null, readyPromise = null;
function ensure() {
  if (!readyPromise) {
    readyPromise = (async () => {
      ort = require('onnxruntime-node');
      sess = await ort.InferenceSession.create(modelPath, {
        intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential',
      });
      atten = new ort.Tensor('float32', Float32Array.from([typeof attenLimDb === 'number' ? attenLimDb : 32.0]), []);
    })();
  }
  return readyPromise;
}
ensure().catch(() => {}); // start loading the model immediately, off the first audio frame

parentPort.on('message', async (seq) => {
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
  Atomics.store(ctrl, RESP, seq); // echo the request seq so a stale response can't be mis-read as the next
  Atomics.notify(ctrl, RESP);
});
`;
