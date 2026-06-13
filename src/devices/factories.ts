import type { Port, Transport } from '../model/ports.js';
import type {
  Processor,
  WiredMic,
  WirelessMic,
  Loudspeaker,
  Codec,
  ConferencingCamera,
} from '../model/devices.js';
import { createMatrix } from '../matrix/matrix.js';
import { defaultProfileId } from '../profiles/profiles.js';

/**
 * Factory functions for the generic device catalog. Devices are modeled on
 * common conferencing-system behavior and are NOT a specific manufacturer's
 * product. Port counts are parameters.
 */

function makePort(
  deviceId: string,
  kind: 'input' | 'output',
  transport: Transport,
  index: number,
): Port {
  const dir = kind === 'input' ? 'in' : 'out';
  return {
    id: `${deviceId}-${dir}-${transport}-${index}`,
    deviceId,
    kind,
    transport,
    label: `${transport === 'dante' ? 'Dante' : 'Analog'} ${kind === 'input' ? 'In' : 'Out'} ${index}`,
  };
}

function makePorts(
  deviceId: string,
  kind: 'input' | 'output',
  transport: Transport,
  count: number,
): Port[] {
  const ports: Port[] = [];
  for (let i = 1; i <= count; i++) ports.push(makePort(deviceId, kind, transport, i));
  return ports;
}

/** Port-count spec for a {@link Processor}. */
export interface ProcessorPortSpec {
  danteInputs?: number;
  danteOutputs?: number;
  analogInputs?: number;
  analogOutputs?: number;
}

/**
 * Create a DSP processor with the given port counts. Builds the crosspoint
 * matrix and internal buses (1:1 with input/output ports). Defaults to a
 * modest 8×8 Dante + 2×2 analog frame.
 */
export function createProcessor(
  id: string,
  label: string,
  spec: ProcessorPortSpec = {},
): Processor {
  const danteInputs = spec.danteInputs ?? 8;
  const danteOutputs = spec.danteOutputs ?? 8;
  const analogInputs = spec.analogInputs ?? 2;
  const analogOutputs = spec.analogOutputs ?? 2;

  const inputPorts = [
    ...makePorts(id, 'input', 'dante', danteInputs),
    ...makePorts(id, 'input', 'analog', analogInputs),
  ];
  const outputPorts = [
    ...makePorts(id, 'output', 'dante', danteOutputs),
    ...makePorts(id, 'output', 'analog', analogOutputs),
  ];
  const matrix = createMatrix(id, inputPorts, outputPorts);

  return {
    id,
    type: 'processor',
    label,
    ports: [...inputPorts, ...outputPorts],
    matrix,
    buses: [...matrix.inputBuses, ...matrix.outputBuses],
    profileId: defaultProfileId('processor'),
    dspBlocks: [],
  };
}

/** Create a single-channel wireless mic (one output port). AEC starts off. */
export function createWirelessMic(
  id: string,
  label: string,
  transport: Transport = 'dante',
): WirelessMic {
  return {
    id,
    type: 'wirelessMic',
    label,
    ports: [makePort(id, 'output', transport, 1)],
    aec: { enabled: false, referenceBusId: null },
    profileId: defaultProfileId('wirelessMic'),
    dspBlocks: [],
  };
}

/** Create a single-channel wired mic (one output port). AEC starts off. */
export function createWiredMic(
  id: string,
  label: string,
  transport: Transport = 'analog',
): WiredMic {
  return {
    id,
    type: 'wiredMic',
    label,
    ports: [makePort(id, 'output', transport, 1)],
    aec: { enabled: false, referenceBusId: null },
    profileId: defaultProfileId('wiredMic'),
    dspBlocks: [],
  };
}

/** Create a loudspeaker (one input port). */
export function createLoudspeaker(
  id: string,
  label: string,
  transport: Transport = 'analog',
): Loudspeaker {
  return {
    id,
    type: 'loudspeaker',
    label,
    ports: [makePort(id, 'input', transport, 1)],
    profileId: defaultProfileId('loudspeaker'),
    dspBlocks: [],
  };
}

/**
 * Create a codec / far-end interface. Its **output** port carries far-end audio
 * INTO the system; its **input** port carries the near-end mix OUT to the far end.
 */
export function createCodec(id: string, label: string, transport: Transport = 'dante'): Codec {
  return {
    id,
    type: 'codec',
    label,
    ports: [makePort(id, 'output', transport, 1), makePort(id, 'input', transport, 1)],
    profileId: defaultProfileId('codec'),
    dspBlocks: [],
  };
}

/**
 * Create a conferencing camera (v4, coverage-only). No audio ports — routing is
 * deferred, so it never participates in auto-route. Pose starts level/north.
 */
export function createCamera(
  id: string,
  label: string,
  profileId = 'generic-ptz-camera',
): ConferencingCamera {
  return {
    id,
    type: 'camera',
    label,
    ports: [],
    profileId,
    dspBlocks: [],
    bearingDeg: 0,
    tiltDeg: 0,
  };
}
