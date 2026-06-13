/**
 * Device transport — the device-facing seam of the commissioning workflow.
 *
 * A {@link DeviceTransport} represents the link to one *site/room* of physical
 * devices: discover what is reachable, connect to individual devices, read back
 * the configuration a device reports, push a designed configuration to it, and
 * poll its status. The abstract base owns the connection bookkeeping; backends
 * implement only the raw primitives.
 *
 * **No real protocol is implemented** (we cannot talk to real Shure/Dante
 * hardware): {@link SimulatedTransport} stands in for a room full of devices so
 * the whole workflow — discover → connect → push → read back → reconcile — is
 * exercisable offline and under test, and a real transport can slot in behind
 * the same interface later. Pure stdlib, like the rest of the engine.
 */
import type { Device } from '../model/devices.js';
import type { SystemConfig } from '../model/config.js';
import { deploymentDiff } from '../deployment/deployment.js';

/** A device could not be reached, or an operation needs a connection. */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

/** One reachable device, as discovery reports it. */
export interface DiscoveredDevice {
  /** The device's own id (matches the design id when commissioned). */
  id: string;
  label: string;
  /** DeviceType value ("processor", "microphoneArray", …). */
  deviceType: string;
  /** Transport address (simulated: "sim://<id>"). */
  address: string;
  firmware: string;
}

/** A status poll for one device (works without a connection). */
export interface DeviceStatus {
  deviceId: string;
  /** Reachable on the transport right now. */
  online: boolean;
  /** This transport currently holds a connection to it. */
  connected: boolean;
  firmware: string;
  /** Backend-specific free text. */
  detail: string;
}

/**
 * Site-level transport. Subclass and implement the protected `_…` primitives.
 *
 * The base class owns the connection registry: {@link connect} / {@link disconnect}
 * are idempotent, config I/O requires a connection, and {@link readStatus} is
 * deliberately allowed without one (status polling must work for offline
 * detection).
 */
export abstract class DeviceTransport {
  static readonly backend: string = 'base';

  protected readonly connected: Set<string> = new Set();

  // ---- discovery ----
  /** Devices currently reachable on this transport (deterministic order). */
  discover(): DiscoveredDevice[] {
    return this.doDiscover();
  }

  // ---- connection lifecycle ----
  /**
   * Open a connection to one device. Raises {@link TransportError} if the device
   * is unknown or offline. Idempotent.
   */
  connect(deviceId: string): void {
    if (this.connected.has(deviceId)) {
      return;
    }
    this.doOpen(deviceId);
    this.connected.add(deviceId);
  }

  disconnect(deviceId: string): void {
    if (!this.connected.has(deviceId)) {
      return;
    }
    try {
      this.doClose(deviceId);
    } finally {
      this.connected.delete(deviceId);
    }
  }

  disconnectAll(): void {
    for (const deviceId of [...this.connected]) {
      this.disconnect(deviceId);
    }
  }

  isConnected(deviceId: string): boolean {
    return this.connected.has(deviceId);
  }

  get connectedIds(): readonly string[] {
    return [...this.connected].sort();
  }

  // ---- config I/O (requires a connection) ----
  /** The configuration the device itself reports (for the reconcile diff). */
  readConfig(deviceId: string): Device {
    this.requireConnected(deviceId);
    return this.doReadConfig(deviceId);
  }

  /** Push a designed device configuration to the physical device. */
  pushConfig(device: Device): void {
    this.requireConnected(device.id);
    this.doPushConfig(device);
  }

  // ---- status ----
  readStatus(deviceId: string): DeviceStatus {
    return this.doReadStatus(deviceId);
  }

  protected requireConnected(deviceId: string): void {
    if (!this.connected.has(deviceId)) {
      throw new TransportError(`device '${deviceId}' is not connected (connect() first)`);
    }
  }

  // ---- backend hooks ----
  protected abstract doDiscover(): DiscoveredDevice[];
  /** Reach the device or throw {@link TransportError}. */
  protected abstract doOpen(deviceId: string): void;
  protected abstract doClose(deviceId: string): void;
  protected abstract doReadConfig(deviceId: string): Device;
  protected abstract doPushConfig(device: Device): void;
  protected abstract doReadStatus(deviceId: string): DeviceStatus;
}

/** Options for {@link SimulatedTransport}. */
export interface SimulatedTransportOptions {
  firmware?: string;
}

/**
 * A hardware-free room of devices.
 *
 * Seed it with the *device-side* configurations (deep-copied — typically the
 * designed devices, or deliberately drifted copies to exercise the reconcile
 * diff). {@link setOffline} simulates unplugging a device: it disappears from
 * discovery, drops its connection, and refuses new ones. Deterministic — no
 * randomness, no I/O.
 */
export class SimulatedTransport extends DeviceTransport {
  static override readonly backend: string = 'simulated';

  private readonly firmware: string;
  private readonly store = new Map<string, Device>();
  private readonly offline = new Set<string>();
  /** Plain counter for tests / the GUI status line. */
  pushCount = 0;

  constructor(devices: Iterable<Device> = [], options: SimulatedTransportOptions = {}) {
    super();
    this.firmware = options.firmware ?? '1.0.0-sim';
    for (const d of devices) {
      if (this.store.has(d.id)) {
        throw new Error(`duplicate simulated device id: ${d.id}`);
      }
      this.store.set(d.id, structuredClone(d));
    }
  }

  // ---- simulation controls ----
  /** Simulate unplugging (or re-plugging) a device. */
  setOffline(deviceId: string, offline = true): void {
    if (!this.store.has(deviceId)) {
      throw new Error(`unknown simulated device: ${deviceId}`);
    }
    if (offline) {
      this.offline.add(deviceId);
      this.connected.delete(deviceId); // a dead link drops its connection
    } else {
      this.offline.delete(deviceId);
    }
  }

  /** Plug in a new device (e.g. found by a later discovery pass). */
  addDevice(device: Device): void {
    if (this.store.has(device.id)) {
      throw new Error(`duplicate simulated device id: ${device.id}`);
    }
    this.store.set(device.id, structuredClone(device));
  }

  /** True if the device exists in the simulated room (online or not). */
  hasDevice(deviceId: string): boolean {
    return this.store.has(deviceId);
  }

  // ---- backend hooks ----
  protected doDiscover(): DiscoveredDevice[] {
    return [...this.store.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .filter((d) => !this.offline.has(d.id))
      .map((d) => ({
        id: d.id,
        label: d.label,
        deviceType: d.type,
        address: `sim://${d.id}`,
        firmware: this.firmware,
      }));
  }

  protected doOpen(deviceId: string): void {
    if (!this.store.has(deviceId)) {
      throw new TransportError(`device '${deviceId}' not found on the transport`);
    }
    if (this.offline.has(deviceId)) {
      throw new TransportError(`device '${deviceId}' is offline`);
    }
  }

  protected doClose(_deviceId: string): void {
    // no-op for the simulated backend
  }

  protected doReadConfig(deviceId: string): Device {
    return structuredClone(this.store.get(deviceId)!);
  }

  protected doPushConfig(device: Device): void {
    this.store.set(device.id, structuredClone(device));
    this.pushCount += 1;
  }

  protected doReadStatus(deviceId: string): DeviceStatus {
    const known = this.store.has(deviceId);
    const online = known && !this.offline.has(deviceId);
    return {
      deviceId,
      online,
      connected: this.connected.has(deviceId),
      firmware: known ? this.firmware : '',
      detail: known ? 'simulated' : 'unknown device',
    };
  }
}

// --------------------------------------------------------------------------- //
// Online-room status — per-device state for the DEPLOY workflow (A2)
// --------------------------------------------------------------------------- //
/**
 * One designed device's live state while the room is online.
 *
 * `changedSinceDeploy` / `newSinceDeploy` compare the *design* against the last
 * deployed snapshot (via {@link deploymentDiff}); `online` / `connected` come
 * from the transport. Device-*reported* drift (room vs design) is the reconcile
 * diff's job, not this one's.
 */
export interface OnlineDeviceState {
  deviceId: string;
  label: string;
  /** Reachable on the transport right now. */
  online: boolean;
  /** The transport holds a connection to it. */
  connected: boolean;
  /** Designed config drifted from the last deploy. */
  changedSinceDeploy: boolean;
  /** Designed after the last deploy (or never deployed). */
  newSinceDeploy: boolean;
}

/** True when the device is online and has neither changed nor is new since deploy. */
export function inSync(state: OnlineDeviceState): boolean {
  return state.online && !(state.changedSinceDeploy || state.newSinceDeploy);
}

// --------------------------------------------------------------------------- //
// Push + reconcile — "Deploy to online devices" (A3)
// --------------------------------------------------------------------------- //
/**
 * Which config components differ between the design and what the device reports.
 * Mirrors the deployment fingerprint's granularity (label | profile | ports |
 * DSP blocks), so the reconcile diff and `changedSinceDeploy` agree on what
 * counts as a change.
 */
function deviceDifferences(designed: Device, reported: Device): string[] {
  const blocks = (d: Device): string[] =>
    (d.dspBlocks ?? []).map((b) => `${b.id}:${b.kind}:${b.enabled}`).sort();
  const sortedStrings = (xs: string[]): string[] => [...xs].sort();

  const diffs: string[] = [];
  if (designed.label !== reported.label) {
    diffs.push('label');
  }
  if ((designed.profileId ?? '') !== (reported.profileId ?? '')) {
    diffs.push('profile');
  }
  const designedPorts = sortedStrings(designed.ports.map((p) => p.id));
  const reportedPorts = sortedStrings(reported.ports.map((p) => p.id));
  if (!arraysEqual(designedPorts, reportedPorts)) {
    diffs.push('ports');
  }
  if (!arraysEqual(blocks(designed), blocks(reported))) {
    diffs.push('processing blocks');
  }
  return diffs;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** One device's device-reported vs designed comparison. */
export interface ReconcileEntry {
  deviceId: string;
  label: string;
  matches: boolean;
  /** Component names that differ (empty when matches). */
  differences: readonly string[];
}

/** Outcome of pushing the design to the online room. */
export interface PushReport {
  /** Device ids pushed + read back. */
  pushed: readonly string[];
  /** Designed devices not reachable. */
  skippedOffline: readonly string[];
  /** `[deviceId, error]` pairs. */
  failed: readonly (readonly [string, string])[];
  /** Read-back comparison per pushed device. */
  reconcile: readonly ReconcileEntry[];
}

/** Every designed device made it (nothing skipped, nothing failed). */
export function pushReportComplete(report: PushReport): boolean {
  return report.skippedOffline.length === 0 && report.failed.length === 0;
}

/** Every read-back matches the design. */
export function pushReportClean(report: PushReport): boolean {
  return report.reconcile.every((e) => e.matches);
}

/** Human-readable summary of a {@link PushReport}. */
export function pushReportSummary(report: PushReport): string {
  const lines: string[] = [`Pushed ${report.pushed.length} device(s).`];
  if (report.skippedOffline.length > 0) {
    lines.push(`Skipped (offline): ${report.skippedOffline.join(', ')}`);
  }
  for (const [deviceId, err] of report.failed) {
    lines.push(`Failed: ${deviceId} — ${err}`);
  }
  for (const e of report.reconcile) {
    if (e.matches) {
      lines.push(`✓ ${e.deviceId} — device matches the design`);
    } else {
      lines.push(`✗ ${e.deviceId} — differs: ${e.differences.join(', ')}`);
    }
  }
  if (pushReportComplete(report) && pushReportClean(report)) {
    lines.push('Room is in sync with the design.');
  }
  return lines.join('\n');
}

function sortedDevices(config: SystemConfig): Device[] {
  return [...config.devices].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Read-only check: what does each *online* designed device report, and does it
 * match the design? Connects (idempotently) as needed; offline devices are
 * simply absent from the result.
 */
export function reconcileOnline(config: SystemConfig, transport: DeviceTransport): ReconcileEntry[] {
  const out: ReconcileEntry[] = [];
  for (const d of sortedDevices(config)) {
    if (!transport.readStatus(d.id).online) {
      continue;
    }
    transport.connect(d.id);
    const reported = transport.readConfig(d.id);
    const diffs = deviceDifferences(d, reported);
    out.push({ deviceId: d.id, label: d.label, matches: diffs.length === 0, differences: diffs });
  }
  return out;
}

/**
 * Push every online designed device's config through the transport, read each
 * back, and reconcile (device-reported vs designed). Offline devices are
 * skipped and reported; per-device transport errors are collected, never
 * raised — one dead link must not abort the room.
 */
export function pushToOnline(config: SystemConfig, transport: DeviceTransport): PushReport {
  const pushed: string[] = [];
  const skipped: string[] = [];
  const failed: (readonly [string, string])[] = [];
  const entries: ReconcileEntry[] = [];
  for (const d of sortedDevices(config)) {
    if (!transport.readStatus(d.id).online) {
      skipped.push(d.id);
      continue;
    }
    let reported: Device;
    try {
      transport.connect(d.id);
      transport.pushConfig(d);
      reported = transport.readConfig(d.id);
    } catch (exc) {
      if (exc instanceof TransportError) {
        failed.push([d.id, exc.message]);
        continue;
      }
      throw exc;
    }
    const diffs = deviceDifferences(d, reported);
    entries.push({ deviceId: d.id, label: d.label, matches: diffs.length === 0, differences: diffs });
    pushed.push(d.id);
  }
  return {
    pushed,
    skippedOffline: skipped,
    failed,
    reconcile: entries,
  };
}

/**
 * Per-designed-device online state, sorted by device id.
 *
 * Reuses {@link deploymentDiff} for the changed/new-since-deploy axis; a
 * never-deployed design marks every device new. Status polling never needs a
 * connection, so this is safe to call on every refresh.
 */
export function onlineRoomStatus(
  config: SystemConfig,
  lastDeployed: SystemConfig | null,
  transport: DeviceTransport,
): OnlineDeviceState[] {
  let changed: Set<string>;
  let added: Set<string>;
  if (lastDeployed !== null) {
    const diff = deploymentDiff(lastDeployed, config);
    changed = new Set(diff.devicesChanged);
    added = new Set(diff.devicesAdded);
  } else {
    changed = new Set();
    added = new Set(config.devices.map((d) => d.id));
  }
  const out: OnlineDeviceState[] = [];
  for (const d of sortedDevices(config)) {
    const st = transport.readStatus(d.id);
    out.push({
      deviceId: d.id,
      label: d.label,
      online: st.online,
      connected: st.connected,
      changedSinceDeploy: changed.has(d.id),
      newSinceDeploy: added.has(d.id),
    });
  }
  return out;
}
