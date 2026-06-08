/**
 * Matrix mixer (crosspoint) model — the any-input-to-any-output grid inside a
 * processor. Pure data + transforms; no audio is processed.
 *
 * Buses map 1:1 to the processor's ports:
 *  - each processor **input** port is one matrix **row**    (an input bus)
 *  - each processor **output** port is one matrix **column** (an output bus)
 *
 * A crosspoint `[inputBusId][outputBusId]` says whether (and at what gain) the
 * input bus is summed into the output bus. Source tracing for AEC reference
 * resolution walks these crosspoints back to the external routes feeding the
 * input ports (see `src/dsp/aec.ts`).
 */

/** Whether a bus is a matrix row (input) or column (output). */
export type BusKind = 'input' | 'output';

/** An internal mixer bus, mapped 1:1 to a processor port of the same kind. */
export interface Bus {
  /** Stable unique id. By convention mirrors the backing port id. */
  id: string;
  /** Owning processor id. */
  processorId: string;
  /** Row (input) or column (output). */
  kind: BusKind;
  /** The processor port this bus is backed by. */
  portId: string;
  /** Human-readable label. */
  label: string;
}

/** A single crosspoint cell. */
export interface Crosspoint {
  /** Whether the input bus is summed into the output bus. */
  enabled: boolean;
  /** Crosspoint gain in decibels. Stored config value; no audio applied. */
  gainDb: number;
}

/**
 * Sparse crosspoint grid. Only enabled/initialized cells are stored, keyed
 * `inputBusId -> outputBusId -> Crosspoint`. Absent cell === disabled at 0 dB.
 */
export interface MatrixMixer {
  /** Processor that owns this matrix. */
  processorId: string;
  /** Declared input buses (rows). */
  inputBuses: Bus[];
  /** Declared output buses (columns). */
  outputBuses: Bus[];
  /** Sparse cells: `cells[inputBusId][outputBusId]`. */
  cells: Record<string, Record<string, Crosspoint>>;
}
