import type { SystemConfig } from '../model/config.js';
import { pointInShape } from '../model/geometry.js';

/** Per-array coverage finding for a talker. */
export interface TalkerCoverage {
  /** `true` iff the talker is inside at least one pickup zone and no exclusion zone. */
  captured: boolean;
  /** Array ids whose pickup zones contain the talker. */
  pickupArrays: string[];
  /** Array ids whose exclusion zones contain the talker (suppressing pickup). */
  excludedBy: string[];
}

/**
 * Determine whether a talker's floor position is **recorded**: inside any
 * array's pickup (dynamic/dedicated) zone and not inside any exclusion zone.
 * Note: an array in `automatic` mode with zero zones picks up its whole field;
 * this check is zone-based, so a talker is "captured" only where zones exist.
 */
export function talkerCoverage(config: SystemConfig, talkerId: string): TalkerCoverage {
  const talker = config.talkers.find((t) => t.id === talkerId);
  const pickupArrays: string[] = [];
  const excludedBy: string[] = [];
  if (!talker) return { captured: false, pickupArrays, excludedBy };
  for (const device of config.devices) {
    if (device.type !== 'microphoneArray') continue;
    let inPickup = false;
    let inExclusion = false;
    for (const zone of device.zones) {
      if (!pointInShape(talker.position, zone.shape)) continue;
      if (zone.type === 'exclusion') inExclusion = true;
      else inPickup = true;
    }
    if (inExclusion) excludedBy.push(device.id);
    else if (inPickup) pickupArrays.push(device.id);
  }
  return { captured: pickupArrays.length > 0 && excludedBy.length === 0, pickupArrays, excludedBy };
}
