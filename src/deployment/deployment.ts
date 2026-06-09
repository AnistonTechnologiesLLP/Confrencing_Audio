/**
 * Deployment workflow — a **configuration-only** model of Designer's
 * online/offline/deploy lifecycle. There is NO network I/O, device discovery, or
 * firmware control here; this stores a status and computes a pure diff between
 * two configs so a planner can see "what would change on deploy".
 */
import type { SystemConfig, DeploymentStatus } from '../model/config.js';
import type { Device } from '../model/devices.js';

/** Set the deployment status (and optional timestamp). Returns a new config. */
export function setDeploymentStatus(
  config: SystemConfig,
  status: DeploymentStatus,
  lastDeployedAt?: string,
): SystemConfig {
  const deployment =
    lastDeployedAt !== undefined ? { status, lastDeployedAt } : { status };
  return { ...config, deployment };
}

/** Mark a config as deployed at `timestamp` (ISO). Returns a new config. */
export function markDeployed(config: SystemConfig, timestamp: string): SystemConfig {
  return setDeploymentStatus(config, 'deployed', timestamp);
}

/** A structured, human-readable diff between a designed and a deployed config. */
export interface DeploymentDiff {
  devicesAdded: string[];
  devicesRemoved: string[];
  /** Device ids whose label/profile/ports/dspBlocks differ. */
  devicesChanged: string[];
  routesAdded: string[];
  routesRemoved: string[];
  /** True iff nothing differs. */
  identical: boolean;
}

function deviceFingerprint(d: Device): string {
  // Stable structural fingerprint (order-independent for ports).
  const ports = [...d.ports].map((p) => p.id).sort().join(',');
  const blocks = (d.dspBlocks ?? []).map((b) => `${b.id}:${b.kind}:${b.enabled}`).sort().join(',');
  return `${d.label}|${d.profileId ?? ''}|${ports}|${blocks}`;
}

/**
 * Diff a `target` config against a `base` (e.g. designed vs currently-deployed):
 * which devices/routes were added, removed, or changed. Pure and deterministic.
 */
export function deploymentDiff(base: SystemConfig, target: SystemConfig): DeploymentDiff {
  const baseDevs = new Map(base.devices.map((d) => [d.id, d]));
  const targetDevs = new Map(target.devices.map((d) => [d.id, d]));

  const devicesAdded = [...targetDevs.keys()].filter((id) => !baseDevs.has(id)).sort();
  const devicesRemoved = [...baseDevs.keys()].filter((id) => !targetDevs.has(id)).sort();
  const devicesChanged = [...targetDevs.keys()]
    .filter((id) => baseDevs.has(id) && deviceFingerprint(baseDevs.get(id)!) !== deviceFingerprint(targetDevs.get(id)!))
    .sort();

  const baseRoutes = new Set(base.routes.map((r) => r.id));
  const targetRoutes = new Set(target.routes.map((r) => r.id));
  const routesAdded = [...targetRoutes].filter((r) => !baseRoutes.has(r)).sort();
  const routesRemoved = [...baseRoutes].filter((r) => !targetRoutes.has(r)).sort();

  const identical =
    devicesAdded.length === 0 &&
    devicesRemoved.length === 0 &&
    devicesChanged.length === 0 &&
    routesAdded.length === 0 &&
    routesRemoved.length === 0;

  return { devicesAdded, devicesRemoved, devicesChanged, routesAdded, routesRemoved, identical };
}
