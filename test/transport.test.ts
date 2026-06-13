import { describe, it, expect } from 'vitest';
import {
  createConfig,
  createProcessor,
  createMicrophoneArray,
  createLoudspeaker,
  createCodec,
  createDspBlock,
  addDevice,
  addDspBlock,
  renameDevice,
} from '../src/index.js';
import type { Device } from '../src/model/index.js';
import {
  SimulatedTransport,
  TransportError,
  onlineRoomStatus,
  reconcileOnline,
  pushToOnline,
  inSync,
  pushReportComplete,
  pushReportClean,
  pushReportSummary,
} from '../src/transport/transport.js';

function roomDevices(): Device[] {
  return [
    createProcessor('P1', 'DSP'),
    createMicrophoneArray('A1', 'Ceiling Array'),
    createLoudspeaker('L1', 'Speaker', 'analog'),
  ];
}

function transport(options?: { firmware?: string }): SimulatedTransport {
  return new SimulatedTransport(roomDevices(), options ?? {});
}

// --- discovery ---
describe('discovery', () => {
  it('lists online devices deterministically', () => {
    const t = transport();
    const found = t.discover();
    expect(found.map((d) => d.id)).toEqual(['A1', 'L1', 'P1']); // sorted by id
    const byId = new Map(found.map((d) => [d.id, d]));
    expect(byId.get('A1')!.deviceType).toBe('microphoneArray');
    expect(byId.get('A1')!.label).toBe('Ceiling Array');
    expect(byId.get('P1')!.address).toBe('sim://P1');
    expect(byId.get('P1')!.firmware).toBe('1.0.0-sim');
  });

  it('offline device disappears from discovery', () => {
    const t = transport();
    t.setOffline('A1');
    expect(t.discover().map((d) => d.id)).toEqual(['L1', 'P1']);
    t.setOffline('A1', false);
    expect(t.discover().map((d) => d.id)).toEqual(['A1', 'L1', 'P1']);
  });
});

// --- connection lifecycle ---
describe('connection lifecycle', () => {
  it('connect/disconnect bookkeeping', () => {
    const t = transport();
    t.connect('P1');
    t.connect('A1');
    t.connect('P1'); // idempotent
    expect(t.connectedIds).toEqual(['A1', 'P1']);
    expect(t.isConnected('P1')).toBe(true);
    expect(t.isConnected('L1')).toBe(false);
    t.disconnect('P1');
    expect(t.connectedIds).toEqual(['A1']);
    t.disconnect('P1'); // idempotent
    t.disconnectAll();
    expect(t.connectedIds).toEqual([]);
  });

  it('connect unknown or offline raises', () => {
    const t = transport();
    expect(() => t.connect('nope')).toThrow(TransportError);
    t.setOffline('A1');
    expect(() => t.connect('A1')).toThrow(TransportError);
  });

  it('going offline drops an open connection', () => {
    const t = transport();
    t.connect('A1');
    t.setOffline('A1'); // unplugged mid-session
    expect(t.isConnected('A1')).toBe(false);
    expect(() => t.readConfig('A1')).toThrow(TransportError);
  });

  it('disconnectAll disconnects everything', () => {
    const t = transport();
    t.connect('P1');
    t.connect('L1');
    expect(t.connectedIds).toEqual(['L1', 'P1']);
    t.disconnectAll();
    expect(t.connectedIds).toEqual([]);
  });
});

// --- config I/O ---
describe('config I/O', () => {
  it('read_config requires connection and isolates copies', () => {
    const t = transport();
    expect(() => t.readConfig('A1')).toThrow(TransportError);
    t.connect('A1');
    const dev = t.readConfig('A1');
    expect(dev.id).toBe('A1');
    expect(dev.label).toBe('Ceiling Array');
    dev.label = 'Mutated'; // caller-side mutation…
    expect(t.readConfig('A1').label).toBe('Ceiling Array'); // …never reaches the device
  });

  it('push_config round trips', () => {
    const t = transport();
    t.connect('A1');
    const dev = t.readConfig('A1');
    dev.label = 'Boardroom North';
    t.pushConfig(dev);
    expect(t.readConfig('A1').label).toBe('Boardroom North');
    expect(t.pushCount).toBe(1);
  });

  it('push requires connection', () => {
    const t = transport();
    expect(() => t.pushConfig(createMicrophoneArray('A1', 'Ceiling Array'))).toThrow(TransportError);
  });

  it('seeded drift then push reconciles', () => {
    const designed = createMicrophoneArray('A1', 'Ceiling Array (rev B)');
    const drifted = createMicrophoneArray('A1', 'Ceiling Array (rev A)');
    const t = new SimulatedTransport([drifted]);
    t.connect('A1');
    expect(t.readConfig('A1').label).not.toBe(designed.label); // drift visible
    t.pushConfig(designed);
    expect(t.readConfig('A1').label).toBe(designed.label); // reconciled
  });
});

// --- status ---
describe('status', () => {
  it('read_status works without connection', () => {
    const t = transport();
    let s = t.readStatus('A1');
    expect(s.online).toBe(true);
    expect(s.connected).toBe(false);
    expect(s.firmware).toBe('1.0.0-sim');
    expect(s.detail).toBe('simulated');
    t.connect('A1');
    expect(t.readStatus('A1').connected).toBe(true);
    t.setOffline('A1');
    s = t.readStatus('A1');
    expect(s.online).toBe(false);
    expect(s.connected).toBe(false);
    const unknown = t.readStatus('ghost');
    expect(unknown.online).toBe(false);
    expect(unknown.detail).toBe('unknown device');
  });
});

// --- simulation controls ---
describe('simulation controls', () => {
  it('duplicate or unknown simulated ids are rejected', () => {
    expect(
      () => new SimulatedTransport([createProcessor('P1', 'a'), createProcessor('P1', 'b')]),
    ).toThrow();
    const t = transport();
    expect(() => t.setOffline('ghost')).toThrow();
    expect(() => t.addDevice(createProcessor('P1', 'again'))).toThrow();
  });

  it('add_device appears in next discovery', () => {
    const t = transport();
    t.addDevice(createCodec('C1', 'Codec'));
    expect(t.discover().map((d) => d.id)).toContain('C1');
    expect(t.hasDevice('C1')).toBe(true);
    expect(t.hasDevice('ghost')).toBe(false);
    t.connect('C1');
    expect(t.readConfig('C1').label).toBe('Codec');
  });
});

// --- online-room status (A2): design vs last-deploy vs transport ---
function design() {
  let c = createConfig({ name: 'Room', createdAt: '2026-06-12T00:00:00Z' });
  c = addDevice(c, createProcessor('P1', 'DSP'));
  c = addDevice(c, createMicrophoneArray('A1', 'Ceiling Array'));
  return c;
}

describe('online-room status (A2)', () => {
  it('never deployed marks all new', () => {
    const c = design();
    const t = new SimulatedTransport(c.devices);
    const rows = onlineRoomStatus(c, null, t);
    expect(rows.map((r) => r.deviceId)).toEqual(['A1', 'P1']); // sorted
    expect(rows.every((r) => r.newSinceDeploy && !r.changedSinceDeploy)).toBe(true);
    expect(rows.every((r) => r.online && !r.connected)).toBe(true);
    expect(rows.some((r) => inSync(r))).toBe(false); // new ⇒ not in sync
  });

  it('changed and new since deploy', () => {
    const deployed = design();
    const t = new SimulatedTransport(deployed.devices);
    let c = renameDevice(deployed, 'A1', 'Ceiling Array (moved)'); // changed
    c = addDevice(c, createLoudspeaker('L1', 'Speaker', 'analog')); // new
    const rows = new Map(onlineRoomStatus(c, deployed, t).map((r) => [r.deviceId, r]));
    expect(rows.get('A1')!.changedSinceDeploy).toBe(true);
    expect(rows.get('A1')!.newSinceDeploy).toBe(false);
    expect(rows.get('L1')!.newSinceDeploy).toBe(true);
    expect(rows.get('L1')!.online).toBe(false); // not installed
    expect(inSync(rows.get('P1')!)).toBe(true); // untouched + online
  });

  it('reflects connection and offline', () => {
    const c = design();
    const t = new SimulatedTransport(c.devices);
    t.connect('P1');
    t.setOffline('A1');
    const rows = new Map(onlineRoomStatus(c, c, t).map((r) => [r.deviceId, r]));
    expect(rows.get('P1')!.connected).toBe(true);
    expect(rows.get('P1')!.online).toBe(true);
    expect(rows.get('A1')!.online).toBe(false);
    expect(rows.get('A1')!.connected).toBe(false);
    expect(inSync(rows.get('A1')!)).toBe(false); // offline ⇒ not in sync
  });
});

// --- push + reconcile (A3): device-reported vs designed ---
describe('push + reconcile (A3)', () => {
  it('reconcile detects device-side drift', () => {
    const c = design();
    const drifted = renameDevice(c, 'A1', 'Old label on the device');
    const t = new SimulatedTransport(drifted.devices); // room reports old config
    const entries = new Map(reconcileOnline(c, t).map((e) => [e.deviceId, e]));
    expect(entries.get('A1')!.matches).toBe(false);
    expect(entries.get('A1')!.differences).toEqual(['label']);
    expect(entries.get('P1')!.matches).toBe(true);
    expect(entries.get('P1')!.differences).toEqual([]);
  });

  it('reconcile skips offline devices', () => {
    const c = design();
    const t = new SimulatedTransport(c.devices);
    t.setOffline('A1');
    expect(reconcileOnline(c, t).map((e) => e.deviceId)).toEqual(['P1']);
  });

  it('reconcile reports ports and blocks granularity', () => {
    const c = design();
    const room = addDspBlock(c, 'P1', createDspBlock('gain', 'P1-gain-1')); // device-side extra block
    const t = new SimulatedTransport(room.devices);
    let entries = new Map(reconcileOnline(c, t).map((e) => [e.deviceId, e]));
    expect(entries.get('P1')!.differences).toEqual(['processing blocks']);
    const small = createProcessor('P1', 'DSP', { danteInputs: 2 }); // device-side fewer ports
    const t2 = new SimulatedTransport([small, ...c.devices.filter((d) => d.id !== 'P1')]);
    entries = new Map(reconcileOnline(c, t2).map((e) => [e.deviceId, e]));
    expect(entries.get('P1')!.differences).toContain('ports');
  });

  it('push_to_online reconciles a drifted room', () => {
    const c = design();
    const drifted = renameDevice(c, 'A1', 'Old label');
    const t = new SimulatedTransport(drifted.devices);
    const before = reconcileOnline(c, t);
    expect(before.some((e) => !e.matches)).toBe(true); // drift visible first
    const report = pushToOnline(c, t);
    expect(report.pushed).toEqual(['A1', 'P1']);
    expect(pushReportComplete(report)).toBe(true);
    expect(pushReportClean(report)).toBe(true);
    expect(report.reconcile.every((e) => e.matches)).toBe(true);
    expect(pushReportSummary(report)).toContain('in sync');
    expect(reconcileOnline(c, t).every((e) => e.matches)).toBe(true); // room really updated
  });

  it('push skips offline and uninstalled devices', () => {
    const c = design();
    const c2 = addDevice(c, createLoudspeaker('L1', 'Speaker', 'analog')); // designed, never installed
    const t = new SimulatedTransport(c.devices);
    t.setOffline('A1');
    const report = pushToOnline(c2, t);
    expect(report.pushed).toEqual(['P1']);
    expect(report.skippedOffline).toEqual(['A1', 'L1']);
    expect(pushReportComplete(report)).toBe(false);
    expect(pushReportClean(report)).toBe(true);
    expect(pushReportSummary(report)).toContain('Skipped (offline): A1, L1');
  });

  it('push collects per-device failures', () => {
    const c = design();

    class FlakyTransport extends SimulatedTransport {
      protected override doPushConfig(device: Device): void {
        if (device.id === 'A1') {
          throw new TransportError('link failure');
        }
        super.doPushConfig(device);
      }
    }

    const t = new FlakyTransport(c.devices);
    const report = pushToOnline(c, t);
    expect(report.pushed).toEqual(['P1']);
    expect(report.failed).toEqual([['A1', 'link failure']]);
    expect(pushReportComplete(report)).toBe(false);
    expect(pushReportSummary(report)).toContain('Failed: A1 — link failure');
  });
});
