import type { SystemConfig } from '../model/config.js';
import type { Processor } from '../model/devices.js';
import { findPort, findDevice } from '../model/config.js';
import { isProcessor } from '../model/devices.js';
import { inputsForOutput, outputsForInput } from '../matrix/matrix.js';

/**
 * AEC reference **resolution** — the analytical core behind the self-reference
 * rule. These pure functions trace signal flow through routes and the matrix to
 * answer: "what sources actually feed this mic's AEC reference, and is the mic
 * itself among them?"
 *
 * Tracing model (see `src/model/matrix.ts`):
 *   source device output port --route--> processor input port (= input bus)
 *   input bus --matrix crosspoint--> output bus (= processor output port)
 *   output bus --route--> sink (loudspeaker), and/or used as an AEC reference
 */

/** A signal arriving at the processor, identified by its originating port. */
export interface SourceSignal {
  /** Device that originates the signal. */
  deviceId: string;
  /** The originating output port id. */
  portId: string;
  /** The processor input bus (port) it lands on. */
  inputBusId: string;
}

/** Resolve the primary processor (the one owning `config.matrix`). */
export function getPrimaryProcessor(config: SystemConfig): Processor | undefined {
  const byMatrix = findDevice(config, config.matrix.processorId);
  if (byMatrix && isProcessor(byMatrix)) return byMatrix;
  return config.devices.find(isProcessor);
}

/**
 * The processor input buses (input port ids) that `deviceId` feeds via routes.
 * These are the buses carrying that device's signal into the matrix.
 */
export function processorInputBusesForDevice(
  config: SystemConfig,
  processor: Processor,
  deviceId: string,
): string[] {
  const buses = new Set<string>();
  for (const route of config.routes) {
    const from = findPort(config, route.fromPortId);
    const to = findPort(config, route.toPortId);
    if (!from || !to) continue;
    if (from.deviceId === deviceId && to.deviceId === processor.id && to.kind === 'input') {
      buses.add(to.id);
    }
  }
  return [...buses];
}

/**
 * Trace the set of {@link SourceSignal}s summed into a processor **output** bus,
 * by walking enabled matrix crosspoints back to the routes feeding each input
 * bus. One hop on each side — sources are external devices.
 */
export function sourcesFeedingOutputBus(
  config: SystemConfig,
  processor: Processor,
  outputBusId: string,
): SourceSignal[] {
  const result: SourceSignal[] = [];
  const seen = new Set<string>();
  const feedingInputBuses = inputsForOutput(processor.matrix, outputBusId);
  for (const inputBusId of feedingInputBuses) {
    for (const route of config.routes) {
      const to = findPort(config, route.toPortId);
      if (!to || to.id !== inputBusId) continue;
      const from = findPort(config, route.fromPortId);
      if (!from) continue;
      const key = `${from.id}->${inputBusId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ deviceId: from.deviceId, portId: from.id, inputBusId });
    }
  }
  return result;
}

/**
 * Processor **output** buses that route to at least one loudspeaker input — i.e.
 * the "speaker feeds". A mic summed into one of these is being reinforced.
 */
export function outputBusesFeedingLoudspeakers(
  config: SystemConfig,
  processor: Processor,
): Set<string> {
  const speakerFeeds = new Set<string>();
  for (const route of config.routes) {
    const from = findPort(config, route.fromPortId);
    const to = findPort(config, route.toPortId);
    if (!from || !to) continue;
    if (from.deviceId !== processor.id || from.kind !== 'output') continue;
    const sink = findDevice(config, to.deviceId);
    if (sink?.type === 'loudspeaker') speakerFeeds.add(from.id);
  }
  return speakerFeeds;
}

/**
 * Whether `micId`'s signal is being routed to the loudspeakers (local sound
 * reinforcement): some input bus carrying the mic crosspoints into a
 * speaker-feeding output bus.
 */
export function isMicReinforced(
  config: SystemConfig,
  processor: Processor,
  micId: string,
): boolean {
  const speakerFeeds = outputBusesFeedingLoudspeakers(config, processor);
  if (speakerFeeds.size === 0) return false;
  const micInputBuses = processorInputBusesForDevice(config, processor, micId);
  for (const inputBusId of micInputBuses) {
    for (const outputBusId of outputsForInput(processor.matrix, inputBusId)) {
      if (speakerFeeds.has(outputBusId)) return true;
    }
  }
  return false;
}

/** Result of analyzing a single mic's AEC reference. */
export interface AecReferenceAnalysis {
  micId: string;
  /** The assigned reference output bus, or `null` if unassigned. */
  referenceBusId: string | null;
  /** Sources feeding the reference bus (empty if unassigned/empty). */
  referenceSources: SourceSignal[];
  /** Whether the reference contains the mic's own signal. */
  containsOwnSignal: boolean;
  /** Whether the mic is reinforced to loudspeakers. */
  reinforced: boolean;
  /** Whether the reference bus is itself a speaker feed (the classic trap). */
  referenceIsSpeakerFeed: boolean;
}

/**
 * Analyze one mic's AEC reference end-to-end. This is the function the
 * validation engine consults to raise `AEC_SELF_REFERENCE`,
 * `AEC_REINFORCED_SHARED_REFERENCE`, and `AEC_REFERENCE_*` diagnostics.
 */
export function analyzeAecReference(
  config: SystemConfig,
  processor: Processor,
  micId: string,
  referenceBusId: string | null,
): AecReferenceAnalysis {
  const micInputBuses = new Set(processorInputBusesForDevice(config, processor, micId));
  let referenceSources: SourceSignal[] = [];
  let containsOwnSignal = false;
  let referenceIsSpeakerFeed = false;

  if (referenceBusId !== null) {
    referenceSources = sourcesFeedingOutputBus(config, processor, referenceBusId);
    containsOwnSignal = referenceSources.some(
      (s) => s.deviceId === micId || micInputBuses.has(s.inputBusId),
    );
    referenceIsSpeakerFeed = outputBusesFeedingLoudspeakers(config, processor).has(
      referenceBusId,
    );
  }

  return {
    micId,
    referenceBusId,
    referenceSources,
    containsOwnSignal,
    reinforced: isMicReinforced(config, processor, micId),
    referenceIsSpeakerFeed,
  };
}
