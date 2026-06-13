/**
 * Vendor-neutral device **capability profiles** (v1.7.0). Each profile declares
 * which device types it applies to, its AEC/automix/mute capabilities, the DSP
 * blocks it supports, coverage limits, and default port counts. Profiles are
 * generic — modeled on common conferencing behavior, not any manufacturer's
 * product. Capabilities are **derived** from the profile, never edited per device.
 */
import type { DeviceType } from '../model/devices.js';
import type { DspBlockKind } from '../model/dsp-blocks.js';

/**
 * Field-of-view / reach for a conferencing camera (v4). Lives on the device
 * profile, mirroring how a mic array's `coverageAngleDeg` lives here.
 */
export interface CameraSpec {
  fovHDeg: number;
  fovVDeg: number;
  maxRangeM: number;
  /** Tightest framing a PTZ can reach, if zoomable. */
  zoomMinFovDeg?: number;
}

/** Dispersion / reach for a loudspeaker (v4). */
export interface SpeakerSpec {
  dispersionHDeg: number;
  dispersionVDeg: number;
  maxRangeM: number;
  spl1mDb?: number;
}

/** Capabilities a profile grants a device. */
export interface DeviceCapabilities {
  aec: boolean;
  automix: boolean;
  mute: boolean;
  supportedBlocks: DspBlockKind[];
  /** Max coverage zones (microphone arrays); 0 for non-arrays. */
  maxCoverageZones: number;
  /** Full (unsteered) pickup cone for arrays, degrees; `undefined` = no coverage geometry (v4). */
  coverageAngleDeg?: number;
  /** Camera FOV/range (camera profiles only) (v4). */
  camera?: CameraSpec;
  /** Loudspeaker dispersion/range (loudspeaker profiles) (v4). */
  speaker?: SpeakerSpec;
}

/** Default port counts a profile suggests (informational; factories keep stable ids). */
export interface ProfilePortDefaults {
  danteInputs?: number;
  danteOutputs?: number;
  analogInputs?: number;
  analogOutputs?: number;
}

/** A vendor-neutral capability profile. */
export interface DeviceProfile {
  id: string;
  label: string;
  /** Device types this profile may be assigned to. */
  appliesTo: DeviceType[];
  capabilities: DeviceCapabilities;
  portDefaults: ProfilePortDefaults;
}

const FULL_BLOCKS: DspBlockKind[] = [
  'gain',
  'mute',
  'peq4',
  'agc',
  'compressor',
  'delay',
  'noiseReduction',
  'deverb',
];
const MIC_BLOCKS: DspBlockKind[] = ['gain', 'mute', 'peq4', 'agc', 'noiseReduction', 'deverb'];
const SPK_BLOCKS: DspBlockKind[] = ['gain', 'mute', 'peq4', 'delay', 'compressor'];

/** The built-in profile catalog, keyed by id. */
export const DEVICE_PROFILES: Record<string, DeviceProfile> = {
  'generic-ceiling-array': {
    id: 'generic-ceiling-array',
    label: 'Generic ceiling array',
    appliesTo: ['microphoneArray'],
    capabilities: { aec: true, automix: true, mute: true, supportedBlocks: MIC_BLOCKS, maxCoverageZones: 8, coverageAngleDeg: 120 },
    portDefaults: { danteOutputs: 1 },
  },
  'generic-table-array': {
    id: 'generic-table-array',
    label: 'Generic table array',
    appliesTo: ['microphoneArray'],
    capabilities: { aec: true, automix: true, mute: true, supportedBlocks: MIC_BLOCKS, maxCoverageZones: 8, coverageAngleDeg: 130 },
    portDefaults: { danteOutputs: 1 },
  },
  'generic-wireless-mic': {
    id: 'generic-wireless-mic',
    label: 'Generic wireless mic',
    appliesTo: ['wirelessMic'],
    capabilities: { aec: true, automix: true, mute: true, supportedBlocks: ['gain', 'mute', 'peq4'], maxCoverageZones: 0 },
    portDefaults: { danteOutputs: 1 },
  },
  'generic-wired-mic': {
    id: 'generic-wired-mic',
    label: 'Generic wired mic',
    appliesTo: ['wiredMic'],
    capabilities: { aec: true, automix: true, mute: true, supportedBlocks: ['gain', 'mute', 'peq4'], maxCoverageZones: 0 },
    portDefaults: { analogOutputs: 1 },
  },
  'generic-hardware-dsp': {
    id: 'generic-hardware-dsp',
    label: 'Generic hardware DSP',
    appliesTo: ['processor'],
    capabilities: { aec: true, automix: true, mute: true, supportedBlocks: FULL_BLOCKS, maxCoverageZones: 0 },
    portDefaults: { danteInputs: 8, danteOutputs: 8, analogInputs: 2, analogOutputs: 2 },
  },
  'generic-software-dsp': {
    id: 'generic-software-dsp',
    label: 'Generic software DSP',
    appliesTo: ['processor'],
    capabilities: { aec: true, automix: true, mute: true, supportedBlocks: FULL_BLOCKS, maxCoverageZones: 0 },
    portDefaults: { danteInputs: 16, danteOutputs: 16 },
  },
  'generic-loudspeaker': {
    id: 'generic-loudspeaker',
    label: 'Generic loudspeaker',
    appliesTo: ['loudspeaker'],
    capabilities: {
      aec: false,
      automix: false,
      mute: true,
      supportedBlocks: SPK_BLOCKS,
      maxCoverageZones: 0,
      speaker: { dispersionHDeg: 90, dispersionVDeg: 60, maxRangeM: 8, spl1mDb: 90 },
    },
    portDefaults: { analogInputs: 1 },
  },
  'generic-codec': {
    id: 'generic-codec',
    label: 'Generic codec (far-end)',
    appliesTo: ['codec'],
    capabilities: { aec: false, automix: false, mute: true, supportedBlocks: ['gain', 'mute'], maxCoverageZones: 0 },
    portDefaults: { danteInputs: 1, danteOutputs: 1 },
  },
  'generic-mute-control': {
    id: 'generic-mute-control',
    label: 'Generic mute/logic control',
    appliesTo: ['codec', 'processor'],
    capabilities: { aec: false, automix: false, mute: true, supportedBlocks: ['mute'], maxCoverageZones: 0 },
    portDefaults: {},
  },
  // v4 — conferencing cameras (coverage-only; no DSP, no audio routing required).
  'generic-ptz-camera': {
    id: 'generic-ptz-camera',
    label: 'Generic PTZ camera',
    appliesTo: ['camera'],
    capabilities: {
      aec: false,
      automix: false,
      mute: false,
      supportedBlocks: [],
      maxCoverageZones: 0,
      camera: { fovHDeg: 70, fovVDeg: 40, maxRangeM: 10, zoomMinFovDeg: 6 },
    },
    portDefaults: {},
  },
  'generic-wide-camera': {
    id: 'generic-wide-camera',
    label: 'Generic wide-angle camera',
    appliesTo: ['camera'],
    capabilities: {
      aec: false,
      automix: false,
      mute: false,
      supportedBlocks: [],
      maxCoverageZones: 0,
      camera: { fovHDeg: 120, fovVDeg: 70, maxRangeM: 6 },
    },
    portDefaults: {},
  },
  'generic-soundbar-camera': {
    id: 'generic-soundbar-camera',
    label: 'Generic soundbar camera',
    appliesTo: ['camera'],
    capabilities: {
      aec: false,
      automix: false,
      mute: false,
      supportedBlocks: [],
      maxCoverageZones: 0,
      camera: { fovHDeg: 110, fovVDeg: 60, maxRangeM: 5 },
    },
    portDefaults: {},
  },
};

/** Default profile id for a device type. */
export function defaultProfileId(type: DeviceType): string {
  switch (type) {
    case 'microphoneArray':
      return 'generic-ceiling-array';
    case 'wirelessMic':
      return 'generic-wireless-mic';
    case 'wiredMic':
      return 'generic-wired-mic';
    case 'processor':
      return 'generic-hardware-dsp';
    case 'loudspeaker':
      return 'generic-loudspeaker';
    case 'codec':
      return 'generic-codec';
    case 'camera':
      return 'generic-ptz-camera';
    default:
      return 'generic-hardware-dsp';
  }
}

/** Resolve a profile by id (undefined if unknown). */
export function getDeviceProfile(profileId: string | undefined): DeviceProfile | undefined {
  return profileId === undefined ? undefined : DEVICE_PROFILES[profileId];
}

/** A permissive fallback when a device has no/unknown profile. */
export const FALLBACK_CAPABILITIES: DeviceCapabilities = {
  aec: true,
  automix: true,
  mute: true,
  supportedBlocks: FULL_BLOCKS,
  maxCoverageZones: 8,
};

/** Capabilities for a device, derived from its profile (or a fallback). */
export function deviceCapabilities(device: { profileId?: string }): DeviceCapabilities {
  return getDeviceProfile(device.profileId)?.capabilities ?? FALLBACK_CAPABILITIES;
}
