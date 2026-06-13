/**
 * Naming conventions (Designer's "simplified naming"). Pure helpers to apply a
 * consistent, role-based labeling scheme and to suggest the next label. Labels
 * are display strings only; device ids are never changed.
 */
import type { SystemConfig } from '../model/config.js';
import type { Device, DeviceType } from '../model/devices.js';

/** Human label stem per device type. */
export const TYPE_LABEL: Record<DeviceType, string> = {
  microphoneArray: 'Array',
  processor: 'Processor',
  wirelessMic: 'Wireless Mic',
  wiredMic: 'Wired Mic',
  loudspeaker: 'Loudspeaker',
  codec: 'Codec',
  camera: 'Camera',
};

/**
 * Apply a per-type, 1-based naming scheme to every device, in declaration order
 * (e.g. "Array 1", "Array 2", "Loudspeaker 1"). Returns a new config.
 */
export function applyNamingScheme(config: SystemConfig): SystemConfig {
  const counters = new Map<DeviceType, number>();
  const devices = config.devices.map((d) => {
    const n = (counters.get(d.type) ?? 0) + 1;
    counters.set(d.type, n);
    return { ...d, label: `${TYPE_LABEL[d.type]} ${n}` } as Device;
  });
  return { ...config, devices };
}

/** Suggest the next label for a new device of `type` (continues the scheme). */
export function suggestedLabel(config: SystemConfig, type: DeviceType): string {
  const used = config.devices.filter((d) => d.type === type).length;
  return `${TYPE_LABEL[type]} ${used + 1}`;
}

/** Group device ids by label (to find duplicates). */
export function labelCollisions(config: SystemConfig): Map<string, string[]> {
  const byLabel = new Map<string, string[]>();
  for (const d of config.devices) {
    const list = byLabel.get(d.label) ?? [];
    list.push(d.id);
    byLabel.set(d.label, list);
  }
  return new Map([...byLabel].filter(([, ids]) => ids.length > 1));
}
