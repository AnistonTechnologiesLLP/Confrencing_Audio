/**
 * Device **templates** (Designer-style presets). Capture a device's reusable
 * configuration (type, profile, DSP chain, transport/coverage) and stamp out new
 * devices from it. Pure; ids are re-namespaced to the new device.
 */
import type { Device, DeviceType } from '../model/devices.js';
import type { DspBlockConfig } from '../model/dsp-blocks.js';
import type { Transport } from '../model/ports.js';
import type { CoverageMode } from '../model/coverage.js';
import {
  createProcessor,
  createWirelessMic,
  createWiredMic,
  createLoudspeaker,
  createCodec,
} from './factories.js';
import { createMicrophoneArray } from '../coverage/coverage.js';

/** A reusable device preset. */
export interface DeviceTemplate {
  name: string;
  deviceType: DeviceType;
  profileId?: string;
  dspBlocks: DspBlockConfig[];
  transport?: Transport;
  coverageMode?: CoverageMode;
}

/** Capture a template from an existing device. */
export function deviceTemplate(name: string, device: Device): DeviceTemplate {
  const t: DeviceTemplate = {
    name,
    deviceType: device.type,
    dspBlocks: (device.dspBlocks ?? []).map((b) => ({ ...b, params: { ...b.params } })) as DspBlockConfig[],
  };
  if (device.profileId !== undefined) t.profileId = device.profileId;
  const firstPort = device.ports[0];
  if (firstPort) t.transport = firstPort.transport;
  if (device.type === 'microphoneArray') t.coverageMode = device.coverageMode;
  return t;
}

/** Instantiate a new device from a template with the given id/label. */
export function instantiateTemplate(template: DeviceTemplate, id: string, label: string): Device {
  const transport: Transport = template.transport ?? 'dante';
  let device: Device;
  switch (template.deviceType) {
    case 'processor':
      device = createProcessor(id, label);
      break;
    case 'microphoneArray':
      device = createMicrophoneArray(id, label, template.coverageMode ?? 'automatic');
      break;
    case 'wirelessMic':
      device = createWirelessMic(id, label, transport);
      break;
    case 'wiredMic':
      device = createWiredMic(id, label, transport);
      break;
    case 'loudspeaker':
      device = createLoudspeaker(id, label, transport);
      break;
    case 'codec':
      device = createCodec(id, label, transport);
      break;
  }
  const dspBlocks = template.dspBlocks.map((b, i) => ({
    ...b,
    id: `${id}-${b.kind}-${i + 1}`,
    params: { ...b.params },
  })) as DspBlockConfig[];
  return {
    ...device,
    profileId: template.profileId ?? device.profileId,
    dspBlocks,
  } as Device;
}
