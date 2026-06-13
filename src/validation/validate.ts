import type { SystemConfig } from '../model/config.js';
import { findPort } from '../model/config.js';
import { isMicDevice } from '../model/devices.js';
import {
  MAX_ZONES_PER_ARRAY,
  MAX_MANUAL_LOBES,
  ZONE_GAIN_DB_MIN,
  ZONE_GAIN_DB_MAX,
  isPickupZone,
} from '../model/coverage.js';
import { findDevice } from '../model/config.js';
import { parseHhmm, WEEKDAYS } from '../model/control.js';
import { defaultElevation } from '../model/devices.js';
import { pointInPolygon, pointInSector } from '../model/geometry.js';
import { resolvedDimensions, furnitureCorners } from '../furniture/furniture.js';
import {
  GATING_SENSITIVITY_MIN,
  GATING_SENSITIVITY_MAX,
} from '../model/dsp.js';
import {
  type ValidationCode,
  type ValidationIssue,
  type ValidationResult,
  type Severity,
} from './codes.js';
import { getPrimaryProcessor, analyzeAecReference } from '../dsp/aec.js';
import { isValidGatingSensitivity, NLP_LEVELS } from '../dsp/automixer.js';
import { getDeviceProfile, deviceCapabilities } from '../profiles/profiles.js';
import { dspBlockParamIssues } from '../dsp/blocks.js';
import { isProcessor } from '../model/devices.js';

/**
 * Validate a {@link SystemConfig}. Pure and deterministic: same input → same
 * ordered output. Returns typed errors and warnings; see `codes.ts`/README for
 * the full code catalog.
 *
 * The flagship check is the AEC **self-reference** rule (§AEC in README): a mic
 * whose AEC reference contains its own signal would cancel itself, silently
 * destroying its audio. This is reported as an error (`AEC_SELF_REFERENCE`), or
 * the more specific `AEC_REINFORCED_SHARED_REFERENCE` when the reference bus is
 * the very speaker feed carrying the reinforced mic.
 */
export function validate(config: SystemConfig): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (severity: Severity, code: ValidationCode, message: string, refs: string[]): void => {
    issues.push({ severity, code, message, refs });
  };

  validateRoutes(config, add);
  validateCoverage(config, add);
  validateAec(config, add);
  validateAutomixer(config, add);
  validateProfilesAndBlocks(config, add);
  validateCommissioning(config, add);
  validateControl(config, add);
  validateRoomAndDevices(config, add);

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return { ok: errors.length === 0, errors, warnings };
}

type AddIssue = (severity: Severity, code: ValidationCode, message: string, refs: string[]) => void;

function validateRoutes(config: SystemConfig, add: AddIssue): void {
  for (const route of config.routes) {
    const from = findPort(config, route.fromPortId);
    const to = findPort(config, route.toPortId);
    if (!from || !to) {
      const missing = [!from ? route.fromPortId : null, !to ? route.toPortId : null].filter(
        (x): x is string => x !== null,
      );
      add(
        'error',
        'ORPHANED_ROUTE',
        `Route "${route.id}" references missing port(s): ${missing.join(', ')}. ` +
          `This typically happens when a coverage mode switch removed the port.`,
        [route.id, ...missing],
      );
      continue;
    }
    if (!(from.kind === 'output' && to.kind === 'input')) {
      add(
        'error',
        'ROUTE_DIRECTION_INVALID',
        `Route "${route.id}" must connect an output port to an input port ` +
          `(got ${from.kind} → ${to.kind}).`,
        [route.id, from.id, to.id],
      );
    }
    if (from.transport !== to.transport) {
      add(
        'error',
        'ROUTE_TRANSPORT_MISMATCH',
        `Route "${route.id}" connects mismatched transports ` +
          `(${from.transport} → ${to.transport}); transports must match.`,
        [route.id, from.id, to.id],
      );
    }
  }
}

function validateCoverage(config: SystemConfig, add: AddIssue): void {
  for (const device of config.devices) {
    if (device.type !== 'microphoneArray') continue;
    if (device.zones.length > MAX_ZONES_PER_ARRAY) {
      add(
        'error',
        'COVERAGE_ZONE_LIMIT',
        `Array "${device.id}" has ${device.zones.length} zones; max is ${MAX_ZONES_PER_ARRAY}.`,
        [device.id],
      );
    }
    const lobeCount = device.zones.filter((z) => z.type !== 'exclusion').length;
    if (device.coverageMode === 'manual' && lobeCount > MAX_MANUAL_LOBES) {
      add(
        'error',
        'MANUAL_LOBE_LIMIT',
        `Array "${device.id}" in manual mode has ${lobeCount} pickup lobes; max is ${MAX_MANUAL_LOBES}.`,
        [device.id],
      );
    }
    const channelsSeen = new Map<number, string>();
    for (const zone of device.zones) {
      const expectedAlwaysOn = zone.type === 'dedicated';
      if (zone.alwaysOn !== expectedAlwaysOn) {
        add(
          'error',
          'COVERAGE_ZONE_INVALID',
          `Zone "${zone.id}" (${zone.type}) on array "${device.id}" must have alwaysOn=${expectedAlwaysOn}.`,
          [device.id, zone.id],
        );
      }
      const badGeometry =
        zone.shape.kind === 'rect'
          ? !(zone.shape.width > 0 && zone.shape.height > 0)
          : zone.shape.points.length < 3;
      if (badGeometry) {
        add(
          'error',
          'COVERAGE_ZONE_INVALID',
          `Zone "${zone.id}" on array "${device.id}" has degenerate geometry.`,
          [device.id, zone.id],
        );
      }
      // Per-area output channel + gain (v1.12.0).
      const ch = zone.outputChannel;
      if (ch !== undefined) {
        if (!isPickupZone(zone)) {
          add(
            'error',
            'COVERAGE_CHANNEL_INVALID',
            `Exclusion zone "${zone.id}" on array "${device.id}" cannot carry an output channel.`,
            [device.id, zone.id],
          );
        } else if (!(ch >= 1 && ch <= MAX_ZONES_PER_ARRAY && Number.isInteger(ch))) {
          add(
            'error',
            'COVERAGE_CHANNEL_INVALID',
            `Zone "${zone.id}" on array "${device.id}" has output channel ${ch}, out of range 1..${MAX_ZONES_PER_ARRAY}.`,
            [device.id, zone.id],
          );
        } else if (channelsSeen.has(ch)) {
          add(
            'error',
            'COVERAGE_CHANNEL_DUPLICATE',
            `Array "${device.id}" assigns output channel ${ch} to both "${channelsSeen.get(ch)!}" and "${zone.id}".`,
            [device.id, zone.id, channelsSeen.get(ch)!],
          );
        } else {
          channelsSeen.set(ch, zone.id);
        }
      }
      if (zone.gainDb !== undefined && !(zone.gainDb >= ZONE_GAIN_DB_MIN && zone.gainDb <= ZONE_GAIN_DB_MAX)) {
        add(
          'error',
          'COVERAGE_GAIN_INVALID',
          `Zone "${zone.id}" on array "${device.id}" gain ${zone.gainDb} dB is out of range [${ZONE_GAIN_DB_MIN}, ${ZONE_GAIN_DB_MAX}].`,
          [device.id, zone.id],
        );
      }
    }
  }
}

function validateAec(config: SystemConfig, add: AddIssue): void {
  const processor = getPrimaryProcessor(config);
  if (!processor) return;
  const hasFarEnd = config.devices.some((d) => d.type === 'codec');

  for (const device of config.devices) {
    if (!isMicDevice(device)) continue;
    const { aec } = device;
    if (!aec.enabled) continue;

    if (aec.referenceBusId === null) {
      // AEC on but no reference assigned. Stronger signal when a far-end exists.
      add(
        'warning',
        'AEC_REFERENCE_MISSING',
        `Mic "${device.id}" has AEC enabled but no reference bus assigned` +
          (hasFarEnd ? ' while a far-end (codec) source exists — assign a far-end reference.' : '.'),
        [device.id],
      );
      continue;
    }

    const analysis = analyzeAecReference(config, processor, device.id, aec.referenceBusId);

    if (analysis.containsOwnSignal) {
      if (analysis.reinforced && analysis.referenceIsSpeakerFeed) {
        add(
          'error',
          'AEC_REINFORCED_SHARED_REFERENCE',
          `Mic "${device.id}" is reinforced to the loudspeakers and its AEC reference is the ` +
            `same speaker-feed bus "${aec.referenceBusId}" that carries it. Build a dedicated ` +
            `far-end-only reference bus (exclude this mic) and point the mic's AEC at it.`,
          [device.id, aec.referenceBusId],
        );
      } else {
        add(
          'error',
          'AEC_SELF_REFERENCE',
          `Mic "${device.id}"'s AEC reference (bus "${aec.referenceBusId}") contains the mic's ` +
            `own signal. The AEC would cancel the mic against itself, destroying its audio. ` +
            `Use a reference built from far-end sources only.`,
          [device.id, aec.referenceBusId],
        );
      }
      continue;
    }

    if (analysis.referenceSources.length === 0) {
      add(
        'warning',
        'AEC_REFERENCE_EMPTY',
        `Mic "${device.id}"'s AEC reference bus "${aec.referenceBusId}" has no sources routed to ` +
          `it — the AEC has nothing to cancel against.`,
        [device.id, aec.referenceBusId],
      );
    }
  }
}

function validateAutomixer(config: SystemConfig, add: AddIssue): void {
  const am = config.automixer;
  if (!NLP_LEVELS.includes(am.nlp)) {
    add('error', 'AUTOMIXER_INVALID', `Automixer NLP level "${String(am.nlp)}" is invalid.`, [
      am.processorId,
    ]);
  }
  for (const ch of am.channels) {
    if (!isValidGatingSensitivity(ch.gatingSensitivity)) {
      add(
        'error',
        'AUTOMIXER_INVALID',
        `Automixer channel "${ch.inputBusId}" gatingSensitivity ${ch.gatingSensitivity} is out of ` +
          `range [${GATING_SENSITIVITY_MIN}, ${GATING_SENSITIVITY_MAX}].`,
        [am.processorId, ch.inputBusId],
      );
    }
  }
}

function validateProfilesAndBlocks(config: SystemConfig, add: AddIssue): void {
  for (const device of config.devices) {
    if (device.profileId !== undefined) {
      const profile = getDeviceProfile(device.profileId);
      if (!profile) {
        add('error', 'DEVICE_PROFILE_UNKNOWN', `Device "${device.id}" references unknown profile "${device.profileId}".`, [device.id]);
      } else if (!profile.appliesTo.includes(device.type)) {
        add(
          'error',
          'DEVICE_CAPABILITY_MISMATCH',
          `Profile "${device.profileId}" (for ${profile.appliesTo.join('/')}) cannot be assigned to ${device.type} "${device.id}".`,
          [device.id],
        );
      }
    }
    const caps = deviceCapabilities(device);
    const blocks = device.dspBlocks ?? [];
    for (const block of blocks) {
      if (!caps.supportedBlocks.includes(block.kind)) {
        add(
          'error',
          'DSP_BLOCK_UNSUPPORTED',
          `DSP block "${block.kind}" is not supported by device "${device.id}" (profile ${device.profileId ?? 'none'}).`,
          [device.id, block.id],
        );
      }
      const paramIssues = dspBlockParamIssues(block);
      if (paramIssues.length > 0) {
        add('error', 'DSP_BLOCK_INVALID', `DSP block "${block.id}" on "${device.id}": ${paramIssues.join('; ')}.`, [device.id, block.id]);
      }
      if (block.targetBusId !== undefined) {
        const resolved = isProcessor(device) && device.buses.some((b) => b.id === block.targetBusId);
        if (!resolved) {
          add('error', 'DSP_TARGET_UNRESOLVED', `DSP block "${block.id}" on "${device.id}" targets unknown bus "${block.targetBusId}".`, [device.id, block.id]);
        }
      }
    }
  }
}

/** Soft commissioning checks (warnings) — see README. */
function validateCommissioning(config: SystemConfig, add: AddIssue): void {
  const hasFarEnd = config.devices.some((d) => d.type === 'codec');
  const mics = config.devices.filter(isMicDevice);
  const processor = getPrimaryProcessor(config);

  if (!hasFarEnd && mics.some((m) => m.aec.enabled)) {
    add('warning', 'AEC_NO_FAR_END', 'One or more mics have AEC enabled but there is no far-end (codec) source in the configuration.', mics.filter((m) => m.aec.enabled).map((m) => m.id));
  }
  if (processor && mics.length > 0 && config.automixer.outputBusId === null) {
    add('warning', 'AUTOMIX_OUTPUT_UNSET', 'Microphones exist but the automixer output bus is not set.', [processor.id]);
  }
  for (const link of config.muteLinks) {
    for (const deviceId of link.linkedDeviceIds) {
      const device = config.devices.find((d) => d.id === deviceId);
      if (device && !deviceCapabilities(device).mute) {
        add('warning', 'MUTE_LINK_UNSUPPORTED', `Mute link "${link.id}" targets device "${deviceId}" which has no mute capability.`, [link.id, deviceId]);
      }
    }
  }
  for (const device of config.devices) {
    const blocks = device.dspBlocks ?? [];
    if (blocks.length > 0 && !blocks.some((b) => b.kind === 'gain' || b.kind === 'mute')) {
      add('warning', 'DSP_CHAIN_NO_LEVEL', `Device "${device.id}" has a DSP chain with no gain or mute stage.`, [device.id]);
    }
  }
  validateNaming(config, add);
}

/** Mute groups, scenes, and scene schedules (v1.12.0 + v3). */
function validateControl(config: SystemConfig, add: AddIssue): void {
  const control = config.control;
  if (!control) return;

  for (const group of control.muteGroups) {
    if (group.deviceIds.length === 0 && group.zoneRefs.length === 0) {
      add(
        'error',
        'CONTROL_MUTE_GROUP_INVALID',
        `Mute group "${group.id}" is empty (no devices or coverage areas).`,
        [group.id],
      );
    }
    for (const did of group.deviceIds) {
      const dev = findDevice(config, did);
      if (!dev) {
        add('error', 'CONTROL_MUTE_GROUP_INVALID', `Mute group "${group.id}" references missing device "${did}".`, [group.id, did]);
      } else if (!deviceCapabilities(dev).mute) {
        add('warning', 'MUTE_LINK_UNSUPPORTED', `Mute group "${group.id}" includes device "${did}" which has no mute capability.`, [group.id, did]);
      }
    }
    for (const ref of group.zoneRefs) {
      const arr = findDevice(config, ref.arrayId);
      if (!arr || arr.type !== 'microphoneArray') {
        add('error', 'CONTROL_MUTE_GROUP_INVALID', `Mute group "${group.id}" references missing array "${ref.arrayId}".`, [group.id, ref.arrayId]);
      } else if (!arr.zones.some((z) => z.id === ref.zoneId)) {
        add('error', 'CONTROL_MUTE_GROUP_INVALID', `Mute group "${group.id}" references missing zone "${ref.zoneId}" on array "${ref.arrayId}".`, [group.id, ref.arrayId, ref.zoneId]);
      }
    }
  }

  const groupIds = new Set(control.muteGroups.map((g) => g.id));
  const seenSceneIds = new Set<string>();
  for (const scene of control.scenes) {
    if (seenSceneIds.has(scene.id)) {
      add('error', 'SCENE_INVALID', `Duplicate scene id "${scene.id}".`, [scene.id]);
    }
    seenSceneIds.add(scene.id);
    if (
      Object.keys(scene.muteStates).length === 0 &&
      scene.zoneStates.length === 0 &&
      scene.steer.length === 0
    ) {
      add('error', 'SCENE_INVALID', `Scene "${scene.id}" is empty (no mute states, zone states, or steer).`, [scene.id]);
    }
    for (const gid of Object.keys(scene.muteStates)) {
      if (!groupIds.has(gid)) {
        add('error', 'SCENE_INVALID', `Scene "${scene.id}" references missing mute group "${gid}".`, [scene.id, gid]);
      }
    }
    for (const zs of scene.zoneStates) {
      const arr = findDevice(config, zs.arrayId);
      if (!arr || arr.type !== 'microphoneArray') {
        add('error', 'SCENE_INVALID', `Scene "${scene.id}" references missing array "${zs.arrayId}".`, [scene.id, zs.arrayId]);
      } else if (!arr.zones.some((z) => z.id === zs.zoneId)) {
        add('error', 'SCENE_INVALID', `Scene "${scene.id}" references missing zone "${zs.zoneId}" on array "${zs.arrayId}".`, [scene.id, zs.arrayId, zs.zoneId]);
      }
    }
    for (const st of scene.steer) {
      const arr = findDevice(config, st.arrayId);
      if (!arr || arr.type !== 'microphoneArray') {
        add('error', 'SCENE_INVALID', `Scene "${scene.id}" steers a missing array "${st.arrayId}".`, [scene.id, st.arrayId]);
      }
    }
  }

  const sceneIds = new Set(control.scenes.map((s) => s.id));
  const seenScheduleIds = new Set<string>();
  for (const sched of control.schedules) {
    if (seenScheduleIds.has(sched.id)) {
      add('error', 'SCHEDULE_INVALID', `Duplicate schedule id "${sched.id}".`, [sched.id]);
    }
    seenScheduleIds.add(sched.id);
    if (!sceneIds.has(sched.sceneId)) {
      add('error', 'SCHEDULE_INVALID', `Schedule "${sched.id}" recalls missing scene "${sched.sceneId}".`, [sched.id, sched.sceneId]);
    }
    if (parseHhmm(sched.time) === null) {
      add('error', 'SCHEDULE_INVALID', `Schedule "${sched.id}" has invalid time "${sched.time}" (expected "HH:MM").`, [sched.id]);
    }
    if (sched.days.length === 0) {
      add('error', 'SCHEDULE_INVALID', `Schedule "${sched.id}" has no days.`, [sched.id]);
    }
    for (const day of sched.days) {
      if (!(WEEKDAYS as readonly string[]).includes(day)) {
        add('error', 'SCHEDULE_INVALID', `Schedule "${sched.id}" has unknown day "${day}" (expected one of ${WEEKDAYS.join(', ')}).`, [sched.id]);
      }
    }
  }
}

/**
 * v4 coverage-design checks: furniture geometry/placement, devices embedded in
 * furniture, and cameras that frame nobody. All advisory (warnings) except a
 * degenerate furniture footprint, which is an error.
 */
function validateRoomAndDevices(config: SystemConfig, add: AddIssue): void {
  const room = config.room;

  if (room) {
    const verts = room.vertices;
    const hasOutline = verts.length >= 3;
    for (const o of room.objects) {
      const [w, d] = resolvedDimensions(o);
      if (w <= 0 || d <= 0) {
        add('error', 'FURNITURE_GEOMETRY_INVALID', `Furniture "${o.id}" (${o.kind}) has non-positive dimensions (${w}×${d} m).`, [o.id]);
      }
      if (hasOutline && !pointInPolygon(o.position, verts)) {
        add('warning', 'FURNITURE_OUTSIDE_ROOM', `Furniture "${o.id}" (${o.kind}) is outside the room outline.`, [o.id]);
      }
    }
    // devices physically embedded in furniture (below its top, inside its footprint)
    for (const dev of config.devices) {
      const pos = dev.position;
      if (!pos) continue;
      const elev = dev.elevation ?? defaultElevation(dev, room.height);
      for (const o of room.objects) {
        const [, , oh] = resolvedDimensions(o);
        if (elev < oh && pointInPolygon(pos, furnitureCorners(o))) {
          add('warning', 'DEVICE_INSIDE_FURNITURE', `Device "${dev.id}" sits inside furniture "${o.id}" (${o.kind}).`, [dev.id, o.id]);
          break;
        }
      }
    }
  }

  // cameras: unplaced, or framing no subject
  const subjects = config.talkers.map((t) => t.position);
  if (room) {
    for (const o of room.objects) {
      for (const s of o.seats ?? []) subjects.push(s.position);
    }
  }
  for (const dev of config.devices) {
    if (dev.type !== 'camera') continue;
    if (!dev.position) {
      add('warning', 'CAMERA_UNPLACED', `Camera "${dev.id}" is not placed in the room.`, [dev.id]);
      continue;
    }
    const spec = deviceCapabilities(dev).camera;
    if (!spec || subjects.length === 0) continue;
    const half = spec.fovHDeg / 2;
    const bearing = ((dev.bearingDeg % 360) + 360) % 360;
    const framesAny = subjects.some((s) => pointInSector(dev.position!, s, bearing, half, spec.maxRangeM));
    if (!framesAny) {
      add('warning', 'CAMERA_NO_SUBJECT', `Camera "${dev.id}" frames no talker or seat — aim it or move it.`, [dev.id]);
    }
  }
}

function validateNaming(config: SystemConfig, add: AddIssue): void {
  const byLabel = new Map<string, string[]>();
  for (const device of config.devices) {
    if (device.label.trim() === '') {
      add('warning', 'NAMING_EMPTY_LABEL', `Device "${device.id}" has an empty label.`, [device.id]);
    }
    const list = byLabel.get(device.label) ?? [];
    list.push(device.id);
    byLabel.set(device.label, list);
  }
  for (const [label, ids] of byLabel) {
    if (ids.length > 1 && label.trim() !== '') {
      add('warning', 'NAMING_DUPLICATE_LABEL', `${ids.length} devices share the label "${label}".`, ids);
    }
  }
}
