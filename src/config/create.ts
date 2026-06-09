import type { SystemConfig } from '../model/config.js';
import { CONFIG_VERSION } from '../model/config.js';

/** Create an empty configuration. Matrix/automixer are wired when the first processor is added. */
export function createConfig(meta: { name: string; createdAt: string }): SystemConfig {
  return {
    version: CONFIG_VERSION,
    devices: [],
    routes: [],
    matrix: { processorId: '', inputBuses: [], outputBuses: [], cells: {} },
    automixer: { processorId: '', channels: [], nlp: 'medium', outputBusId: null },
    muteLinks: [],
    talkers: [],
    metadata: { ...meta },
  };
}
