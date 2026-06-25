// src/live-node/index.ts
/** Node-only live-audio backends (PortAudio via the optional `naudiodon2` addon). */
export { NodeCaptureAdapter } from './naudiodon-adapter.js';
export { NodeOutputSink } from './output-sink.js';
export {
  createDfn3SyncSession,
  DFN3_ONNX_WORKER_SOURCE,
  type Dfn3SyncSession,
  type Dfn3SyncSessionOptions,
} from './dfn3-session.js';
