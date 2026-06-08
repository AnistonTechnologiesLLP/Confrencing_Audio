import {
  type AutomixerChannel,
  type AutomixerConfig,
  type NlpLevel,
  GATING_SENSITIVITY_MIN,
  GATING_SENSITIVITY_MAX,
} from '../model/dsp.js';

/**
 * Automixer **configuration** helpers. The automixer gates per-channel and sums
 * passing channels into one output bus. This module stores and range-checks
 * those settings; it performs no real-time gating.
 */

/** Valid {@link NlpLevel} values, for range checks. */
export const NLP_LEVELS: readonly NlpLevel[] = ['off', 'low', 'medium', 'high'];

/** Create an empty automixer config for a processor. */
export function createAutomixer(processorId: string): AutomixerConfig {
  return { processorId, channels: [], nlp: 'medium', outputBusId: null };
}

/** Whether a gating sensitivity is within the inclusive valid range. */
export function isValidGatingSensitivity(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value >= GATING_SENSITIVITY_MIN &&
    value <= GATING_SENSITIVITY_MAX
  );
}

/** Build an automixer channel, validating the gating sensitivity range. */
export function automixerChannel(
  inputBusId: string,
  opts: { alwaysOn?: boolean; gatingSensitivity?: number } = {},
): AutomixerChannel {
  const gatingSensitivity = opts.gatingSensitivity ?? 0.5;
  if (!isValidGatingSensitivity(gatingSensitivity)) {
    throw new RangeError(
      `gatingSensitivity must be within [${GATING_SENSITIVITY_MIN}, ${GATING_SENSITIVITY_MAX}], got ${gatingSensitivity}.`,
    );
  }
  return {
    inputBusId,
    alwaysOn: opts.alwaysOn ?? false,
    gatingSensitivity,
  };
}

/**
 * Add or replace (by `inputBusId`) a channel in an automixer config.
 * Returns a new config.
 */
export function upsertChannel(
  config: AutomixerConfig,
  channel: AutomixerChannel,
): AutomixerConfig {
  const channels = config.channels.filter((c) => c.inputBusId !== channel.inputBusId);
  channels.push(channel);
  return { ...config, channels };
}

/** Set the automix sum output bus. Returns a new config. */
export function setAutomixOutput(
  config: AutomixerConfig,
  outputBusId: string,
): AutomixerConfig {
  return { ...config, outputBusId };
}

/** Set the NLP level, validating it. Returns a new config. */
export function setNlp(config: AutomixerConfig, nlp: NlpLevel): AutomixerConfig {
  if (!NLP_LEVELS.includes(nlp)) {
    throw new RangeError(`Invalid NLP level: ${String(nlp)}`);
  }
  return { ...config, nlp };
}
