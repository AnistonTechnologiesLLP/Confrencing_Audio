import type { SystemConfig } from '../model/config.js';
import { findPort } from '../model/config.js';
import { isMicDevice } from '../model/devices.js';
import {
  MAX_ZONES_PER_ARRAY,
  MAX_MANUAL_LOBES,
} from '../model/coverage.js';
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
