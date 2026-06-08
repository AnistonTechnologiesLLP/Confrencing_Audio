/** Barrel for the matrix mixer engine. */
export * as matrixOps from './matrix.js';
export {
  createMatrix,
  set,
  route,
  clear,
  get,
  isActive,
  inputsForOutput,
  outputsForInput,
  activeCrosspoints,
  hasInputBus,
  hasOutputBus,
  DEFAULT_CROSSPOINT,
} from './matrix.js';
