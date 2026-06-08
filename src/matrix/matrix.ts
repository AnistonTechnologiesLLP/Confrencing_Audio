import type { Bus, Crosspoint, MatrixMixer } from '../model/matrix.js';
import type { Port } from '../model/ports.js';

/**
 * Pure crosspoint-matrix engine. Every operation returns a **new**
 * {@link MatrixMixer} (the input is never mutated), so configs stay immutable
 * and safe to share. No audio is processed — gains are stored config values.
 */

/** Default crosspoint applied by {@link route} when none is given. */
export const DEFAULT_CROSSPOINT: Crosspoint = { enabled: true, gainDb: 0 };

/**
 * Build an empty matrix for a processor from its input/output ports. Each input
 * port becomes one input bus (row) and each output port one output bus (column),
 * with bus id === port id by convention.
 *
 * @param processorId Owning processor id.
 * @param inputPorts  Processor input ports (rows).
 * @param outputPorts Processor output ports (columns).
 */
export function createMatrix(
  processorId: string,
  inputPorts: Port[],
  outputPorts: Port[],
): MatrixMixer {
  const inputBuses: Bus[] = inputPorts.map((p) => ({
    id: p.id,
    processorId,
    kind: 'input',
    portId: p.id,
    label: p.label,
  }));
  const outputBuses: Bus[] = outputPorts.map((p) => ({
    id: p.id,
    processorId,
    kind: 'output',
    portId: p.id,
    label: p.label,
  }));
  return { processorId, inputBuses, outputBuses, cells: {} };
}

/** Whether `inputBusId` is a declared row of `matrix`. */
export function hasInputBus(matrix: MatrixMixer, inputBusId: string): boolean {
  return matrix.inputBuses.some((b) => b.id === inputBusId);
}

/** Whether `outputBusId` is a declared column of `matrix`. */
export function hasOutputBus(matrix: MatrixMixer, outputBusId: string): boolean {
  return matrix.outputBuses.some((b) => b.id === outputBusId);
}

function assertBuses(matrix: MatrixMixer, inputBusId: string, outputBusId: string): void {
  if (!hasInputBus(matrix, inputBusId)) {
    throw new Error(`Unknown matrix input bus: ${inputBusId}`);
  }
  if (!hasOutputBus(matrix, outputBusId)) {
    throw new Error(`Unknown matrix output bus: ${outputBusId}`);
  }
}

/** Deep-ish clone of the sparse cell grid (cells are flat value objects). */
function cloneCells(
  cells: Record<string, Record<string, Crosspoint>>,
): Record<string, Record<string, Crosspoint>> {
  const out: Record<string, Record<string, Crosspoint>> = {};
  for (const [row, cols] of Object.entries(cells)) {
    out[row] = { ...cols };
  }
  return out;
}

/**
 * Set an explicit crosspoint at `[inputBusId][outputBusId]`. Returns a new
 * matrix. Throws if either bus is unknown.
 */
export function set(
  matrix: MatrixMixer,
  inputBusId: string,
  outputBusId: string,
  crosspoint: Crosspoint,
): MatrixMixer {
  assertBuses(matrix, inputBusId, outputBusId);
  const cells = cloneCells(matrix.cells);
  const row = cells[inputBusId] ?? {};
  row[outputBusId] = { ...crosspoint };
  cells[inputBusId] = row;
  return { ...matrix, cells };
}

/**
 * Enable a crosspoint with {@link DEFAULT_CROSSPOINT} (or a supplied gain).
 * Convenience over {@link set}.
 */
export function route(
  matrix: MatrixMixer,
  inputBusId: string,
  outputBusId: string,
  gainDb = 0,
): MatrixMixer {
  return set(matrix, inputBusId, outputBusId, { enabled: true, gainDb });
}

/** Clear (delete) a crosspoint. Returns a new matrix. No-op if absent. */
export function clear(
  matrix: MatrixMixer,
  inputBusId: string,
  outputBusId: string,
): MatrixMixer {
  assertBuses(matrix, inputBusId, outputBusId);
  if (matrix.cells[inputBusId]?.[outputBusId] === undefined) return matrix;
  const cells = cloneCells(matrix.cells);
  const row = cells[inputBusId];
  if (row) {
    delete row[outputBusId];
    if (Object.keys(row).length === 0) delete cells[inputBusId];
  }
  return { ...matrix, cells };
}

/** Read a crosspoint. Returns `undefined` if the cell was never set. */
export function get(
  matrix: MatrixMixer,
  inputBusId: string,
  outputBusId: string,
): Crosspoint | undefined {
  return matrix.cells[inputBusId]?.[outputBusId];
}

/** Whether a crosspoint exists and is enabled. */
export function isActive(
  matrix: MatrixMixer,
  inputBusId: string,
  outputBusId: string,
): boolean {
  return get(matrix, inputBusId, outputBusId)?.enabled === true;
}

/** List the input bus ids actively summed into `outputBusId`. */
export function inputsForOutput(matrix: MatrixMixer, outputBusId: string): string[] {
  const result: string[] = [];
  for (const [inputBusId, cols] of Object.entries(matrix.cells)) {
    if (cols[outputBusId]?.enabled === true) result.push(inputBusId);
  }
  return result;
}

/** List the output bus ids that `inputBusId` is actively summed into. */
export function outputsForInput(matrix: MatrixMixer, inputBusId: string): string[] {
  const cols = matrix.cells[inputBusId];
  if (!cols) return [];
  return Object.entries(cols)
    .filter(([, cp]) => cp.enabled)
    .map(([outputBusId]) => outputBusId);
}

/** All active crosspoints as flat triples, useful for inspection/export. */
export function activeCrosspoints(
  matrix: MatrixMixer,
): Array<{ inputBusId: string; outputBusId: string; crosspoint: Crosspoint }> {
  const out: Array<{ inputBusId: string; outputBusId: string; crosspoint: Crosspoint }> = [];
  for (const [inputBusId, cols] of Object.entries(matrix.cells)) {
    for (const [outputBusId, crosspoint] of Object.entries(cols)) {
      if (crosspoint.enabled) out.push({ inputBusId, outputBusId, crosspoint });
    }
  }
  return out;
}
