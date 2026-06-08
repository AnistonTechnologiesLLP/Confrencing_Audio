import type { MuteLink } from '../model/dsp.js';
import type { SystemConfig } from '../model/config.js';

/**
 * Mute/logic-link resolution. Tracks mute state and resolves which devices'
 * indicators should reflect it. State + logic only — no hardware I/O.
 */

/** Create a mute link for a processor output bus. */
export function createMuteLink(
  id: string,
  processorOutputBusId: string,
  linkedDeviceIds: string[],
  opts: { syncToCodec?: boolean; muted?: boolean } = {},
): MuteLink {
  return {
    id,
    processorOutputBusId,
    linkedDeviceIds: [...linkedDeviceIds],
    syncToCodec: opts.syncToCodec ?? false,
    muted: opts.muted ?? false,
  };
}

/** Return a new link with `muted` set. */
export function setMuted(link: MuteLink, muted: boolean): MuteLink {
  return { ...link, muted };
}

/**
 * Resolve the set of device ids whose indicators should currently show "muted",
 * across all mute links in the config. A device appears if any link it is part
 * of is muted.
 */
export function mutedIndicatorDevices(config: SystemConfig): Set<string> {
  const muted = new Set<string>();
  for (const link of config.muteLinks) {
    if (!link.muted) continue;
    for (const deviceId of link.linkedDeviceIds) muted.add(deviceId);
  }
  return muted;
}

/** Whether any muted link requests codec synchronization. */
export function anyCodecSyncMuted(config: SystemConfig): boolean {
  return config.muteLinks.some((l) => l.muted && l.syncToCodec);
}
