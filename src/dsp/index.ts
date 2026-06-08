/** Barrel for the DSP configuration subsystem (AEC, automixer, mute). */
export {
  getPrimaryProcessor,
  processorInputBusesForDevice,
  sourcesFeedingOutputBus,
  outputBusesFeedingLoudspeakers,
  isMicReinforced,
  analyzeAecReference,
} from './aec.js';
export type { SourceSignal, AecReferenceAnalysis } from './aec.js';
export {
  NLP_LEVELS,
  createAutomixer,
  isValidGatingSensitivity,
  automixerChannel,
  upsertChannel,
  setAutomixOutput,
  setNlp,
} from './automixer.js';
export { createMuteLink, setMuted, mutedIndicatorDevices, anyCodecSyncMuted } from './mute.js';
