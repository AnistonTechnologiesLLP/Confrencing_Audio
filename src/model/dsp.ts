/**
 * DSP-related **configuration** types: AEC reference assignment, the automixer,
 * and mute/logic linking. These are stored and validated; no real DSP runs.
 */

/**
 * Per-microphone Acoustic Echo Cancellation reference assignment.
 *
 * AEC removes, from a mic's signal, whatever the room loudspeakers are emitting.
 * To do that it needs a **reference** equal to the speaker feed — but the
 * reference MUST NOT contain the mic's own signal, or the AEC cancels the mic
 * against itself. {@link AecConfig.referenceBusId} names the processor **output
 * bus** whose summed content is used as that reference. Validation resolves the
 * sources feeding that bus and enforces the self-reference rule
 * (see `src/dsp/aec.ts` and `src/validation/`).
 */
export interface AecConfig {
  /** Whether AEC is active for this mic. */
  enabled: boolean;
  /**
   * Processor output bus used as the AEC reference, or `null` if unassigned.
   * When enabled with no reference, validation emits `AEC_REFERENCE_MISSING`.
   */
  referenceBusId: string | null;
}

/** Non-linear processing strength applied after gating. Config label only. */
export type NlpLevel = 'off' | 'low' | 'medium' | 'high';

/** Inclusive valid range for {@link AutomixerChannel.gatingSensitivity}. */
export const GATING_SENSITIVITY_MIN = 0;
export const GATING_SENSITIVITY_MAX = 1;

/** One automixer channel, referencing a processor input bus. */
export interface AutomixerChannel {
  /** Processor input bus id this channel gates. */
  inputBusId: string;
  /**
   * When `true`, the channel always passes to the automix sum (e.g. a presenter
   * mic that must stay open even while the audience speaks).
   */
  alwaysOn: boolean;
  /**
   * Gating sensitivity, normalized `0..1` (0 = least sensitive / hardest to
   * open, 1 = most sensitive). Range-checked by validation.
   */
  gatingSensitivity: number;
}

/** Automixer configuration for a processor. */
export interface AutomixerConfig {
  /** Owning processor id. */
  processorId: string;
  /** Gated channels summed into {@link AutomixerConfig.outputBusId}. */
  channels: AutomixerChannel[];
  /** Non-linear processing strength. */
  nlp: NlpLevel;
  /** Processor output bus that carries the gated automix sum, or `null` if unset. */
  outputBusId: string | null;
}

/**
 * Mute/logic link: ties a processor output bus's mute state to indicator LEDs on
 * other devices and (optionally) an external codec. State + resolution logic
 * only; no hardware I/O is performed.
 */
export interface MuteLink {
  /** Stable unique id. */
  id: string;
  /** Processor output bus whose mute state is mirrored. */
  processorOutputBusId: string;
  /** Devices whose indicators should reflect this mute state. */
  linkedDeviceIds: string[];
  /** Whether the mute state is synchronized to an external codec. */
  syncToCodec: boolean;
  /** Current mute state. */
  muted: boolean;
}
