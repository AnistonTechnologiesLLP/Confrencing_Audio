import type { Port } from './ports.js';
import type { Point2D } from './geometry.js';
import type { CoverageMode, CoverageZone } from './coverage.js';
import type { AecConfig } from './dsp.js';
import type { DspBlockConfig } from './dsp-blocks.js';
import type { MatrixMixer, Bus } from './matrix.js';

/** Discriminator for the {@link Device} union. */
export type DeviceType =
  | 'microphoneArray'
  | 'processor'
  | 'wirelessMic'
  | 'wiredMic'
  | 'loudspeaker'
  | 'codec'
  | 'camera';

/** Fields common to every device. */
export interface BaseDevice {
  /** Stable unique id. */
  id: string;
  /** Discriminator. */
  type: DeviceType;
  /** Human-readable label. */
  label: string;
  /** Typed ports exposed by this device. */
  ports: Port[];
  /** Optional floor placement (x, y), metres, in room/coverage coordinates. */
  position?: Point2D;
  /**
   * Optional elevation above the floor, metres (the z/height for 3D layout).
   * When unset, a sensible per-type default is used for display only. Like all
   * geometry here this is a planning abstraction, not an acoustic model.
   */
  elevation?: number;
  /**
   * Vendor-neutral capability profile id (see `src/profiles/`). Factories assign
   * a sensible default. Drives supported DSP blocks and AEC/automix/mute caps.
   */
  profileId?: string;
  /** Ordered DSP processing chain (settings only — no audio is processed). */
  dspBlocks?: DspBlockConfig[];
}

/**
 * Ceiling/array microphone with coverage zones. Its Dante output port count is
 * derived from {@link MicrophoneArray.coverageMode} (see `src/coverage/`).
 */
export interface MicrophoneArray extends BaseDevice {
  type: 'microphoneArray';
  /** Coverage/output mode. Drives port regeneration. */
  coverageMode: CoverageMode;
  /** Coverage zones (max 8). */
  zones: CoverageZone[];
  /** AEC reference assignment for this array's signal. */
  aec: AecConfig;
  /**
   * v5 — optional mounting bearing (compass heading of the array's 0° reference,
   * 0° = +Y). Lets a detected array-relative azimuth be mapped into room
   * coordinates (room-aware steering). `undefined` ⇒ orientation unspecified.
   */
  bearingDeg?: number;
}

/** A single-channel wireless source (e.g. presenter lavalier/handheld). */
export interface WirelessMic extends BaseDevice {
  type: 'wirelessMic';
  /** AEC reference assignment for this mic's signal. */
  aec: AecConfig;
}

/** A single-channel wired source (e.g. gooseneck/lavalier on a wired input). */
export interface WiredMic extends BaseDevice {
  type: 'wiredMic';
  /** AEC reference assignment for this mic's signal. */
  aec: AecConfig;
}

/** Output sink for local sound reinforcement. */
export interface Loudspeaker extends BaseDevice {
  type: 'loudspeaker';
  /**
   * v4 — optional aim, so a directional dispersion cone can be drawn/simulated.
   * `undefined` ⇒ treated as omnidirectional. Compass bearing the speaker faces
   * (0° = +Y).
   */
  bearingDeg?: number;
  /** v4 — downward tilt from horizontal, degrees (0 = level). */
  tiltDeg?: number;
}

/**
 * A conferencing camera (PTZ / wide / soundbar-integrated), v4. Coverage-only:
 * it carries a pose (`bearingDeg`/`tiltDeg`) and a nominal (usually empty) port
 * set, while its field-of-view / range live on the device **profile**
 * ({@link DeviceProfile} → `CameraSpec`). Routing / scene presets are deferred.
 */
export interface ConferencingCamera extends BaseDevice {
  type: 'camera';
  /** Compass bearing the camera faces (0° = +Y, clockwise). */
  bearingDeg: number;
  /** Downward tilt from horizontal, degrees (0 = level, 90 = straight down). */
  tiltDeg: number;
}

/**
 * Conferencing codec / far-end interface. From the system's perspective its
 * **output** port carries far-end (remote) audio INTO the system, and its
 * **input** port carries the near-end mix OUT to the far end.
 */
export interface Codec extends BaseDevice {
  type: 'codec';
}

/**
 * The DSP hub: matrix mixer + AEC + automixer. Holds its matrix and internal
 * buses; the automixer config lives on {@link SystemConfig} keyed by processor.
 */
export interface Processor extends BaseDevice {
  type: 'processor';
  /** Crosspoint matrix over this processor's buses. */
  matrix: MatrixMixer;
  /** Internal mixer buses (mirror the input/output ports 1:1). */
  buses: Bus[];
}

/** Any node in the signal graph. */
export type Device =
  | MicrophoneArray
  | WirelessMic
  | WiredMic
  | Loudspeaker
  | Codec
  | Processor
  | ConferencingCamera;

/** Devices that own an {@link AecConfig} (i.e. microphone-type sources). */
export type MicDevice = MicrophoneArray | WirelessMic | WiredMic;

/** Type guard: device is a microphone source carrying an AEC config. */
export function isMicDevice(device: Device): device is MicDevice {
  return (
    device.type === 'microphoneArray' ||
    device.type === 'wirelessMic' ||
    device.type === 'wiredMic'
  );
}

/** Type guard: device is the DSP processor. */
export function isProcessor(device: Device): device is Processor {
  return device.type === 'processor';
}

/** Type guard: device is a conferencing camera (v4). */
export function isCamera(device: Device): device is ConferencingCamera {
  return device.type === 'camera';
}

/**
 * Default elevation (metres above floor) used for 3D display and geometry when a
 * device has no explicit {@link BaseDevice.elevation}. Ceiling devices sit near
 * the room top; table/handheld sources sit low. Planning conveniences, not
 * measurements.
 */
export function defaultElevation(device: Device, roomHeight = 3): number {
  switch (device.type) {
    case 'microphoneArray':
      return roomHeight; // ceiling-mounted array
    case 'loudspeaker':
      return Math.max(0, roomHeight - 0.3); // near-ceiling
    case 'camera':
      return Math.max(0, roomHeight - 1.2); // eye-line (typical wall/display mount)
    case 'codec':
      return 0.7;
    case 'processor':
      return 0.4; // rack height
    case 'wirelessMic':
    case 'wiredMic':
      return 1.1; // handheld / lectern height
    default:
      return 1;
  }
}
