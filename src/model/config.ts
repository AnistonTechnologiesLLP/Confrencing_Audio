import type { Device } from './devices.js';
import type { Port } from './ports.js';
import type { MatrixMixer } from './matrix.js';
import type { AutomixerConfig, MuteLink } from './dsp.js';
import type { RoomLayout } from './room.js';
import type { Talker } from './talker.js';

/** Current serialization schema version. Bump on breaking model changes. */
export const CONFIG_VERSION = 1;

/** A directed connection between an output port and an input port. */
export interface Route {
  /** Stable unique id. */
  id: string;
  /** Source port id (must be an `output` port). */
  fromPortId: string;
  /** Destination port id (must be an `input` port). */
  toPortId: string;
}

/** The root configuration document. Round-trippable to/from JSON. */
export interface SystemConfig {
  /** Schema version. */
  version: number;
  /** Optional room layout interop (see {@link RoomLayout}). */
  room?: RoomLayout;
  /** All devices in the graph. */
  devices: Device[];
  /** All routes between device ports. */
  routes: Route[];
  /** The (single primary) processor's crosspoint matrix. */
  matrix: MatrixMixer;
  /** The (single primary) processor's automixer config. */
  automixer: AutomixerConfig;
  /** Mute/logic links. */
  muteLinks: MuteLink[];
  /** Talkers (people) placed for coverage/steering-angle planning. */
  talkers: Talker[];
  /** Document metadata. */
  metadata: { name: string; createdAt: string };
}

/** Resolve a talker by id. Returns `undefined` if not found. */
export function findTalker(config: SystemConfig, talkerId: string): Talker | undefined {
  return config.talkers.find((t) => t.id === talkerId);
}

/** Resolve a port by id across all devices. Returns `undefined` if not found. */
export function findPort(config: SystemConfig, portId: string): Port | undefined {
  for (const device of config.devices) {
    for (const port of device.ports) {
      if (port.id === portId) return port;
    }
  }
  return undefined;
}

/** Resolve a device by id. Returns `undefined` if not found. */
export function findDevice(config: SystemConfig, deviceId: string): Device | undefined {
  return config.devices.find((d) => d.id === deviceId);
}
