/**
 * Routing views (Designer's "enhanced audio routing view" / Dante hub). Pure
 * derived summaries of the signal graph — no audio, no live Dante control.
 */
import type { SystemConfig } from '../model/config.js';
import { findPort, findDevice } from '../model/config.js';
import type { Transport } from '../model/ports.js';

/** One resolved subscription (a route with device/port labels). */
export interface Subscription {
  routeId: string;
  transport: Transport;
  fromDeviceId: string;
  fromDeviceLabel: string;
  fromPortId: string;
  fromPortLabel: string;
  toDeviceId: string;
  toDeviceLabel: string;
  toPortId: string;
  toPortLabel: string;
}

/** Resolve all routes to labeled subscriptions, optionally filtered by transport. */
export function subscriptions(config: SystemConfig, transport?: Transport): Subscription[] {
  const out: Subscription[] = [];
  for (const r of config.routes) {
    const from = findPort(config, r.fromPortId);
    const to = findPort(config, r.toPortId);
    if (!from || !to) continue;
    if (transport && from.transport !== transport) continue;
    const fromDev = findDevice(config, from.deviceId);
    const toDev = findDevice(config, to.deviceId);
    out.push({
      routeId: r.id,
      transport: from.transport,
      fromDeviceId: from.deviceId,
      fromDeviceLabel: fromDev?.label ?? from.deviceId,
      fromPortId: from.id,
      fromPortLabel: from.label,
      toDeviceId: to.deviceId,
      toDeviceLabel: toDev?.label ?? to.deviceId,
      toPortId: to.id,
      toPortLabel: to.label,
    });
  }
  return out;
}

/** Dante-only subscriptions (the "Dante hub" view). */
export function danteSubscriptions(config: SystemConfig): Subscription[] {
  return subscriptions(config, 'dante');
}

/** Route counts by transport. */
export function routingSummary(config: SystemConfig): { dante: number; analog: number; total: number } {
  const subs = subscriptions(config);
  const dante = subs.filter((s) => s.transport === 'dante').length;
  return { dante, analog: subs.length - dante, total: subs.length };
}

/** A plain-text signal-flow report (one line per subscription). */
export function signalFlowReport(config: SystemConfig): string {
  const lines = subscriptions(config).map(
    (s) => `[${s.transport}] ${s.fromDeviceLabel} (${s.fromPortLabel}) → ${s.toDeviceLabel} (${s.toPortLabel})`,
  );
  return lines.length ? lines.join('\n') : '(no routes)';
}
