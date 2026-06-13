import { describe, it, expect } from 'vitest';
import {
  CONFIG_VERSION,
  createConfig,
  addDevice,
  route,
  createProcessor,
  createWirelessMic,
  createLoudspeaker,
  createMicrophoneArray,
  createDspBlock,
  addDspBlock,
  renameDevice,
  // 1.8.0
  setDeploymentStatus,
  markDeployed,
  deploymentDiff,
  applyNamingScheme,
  suggestedLabel,
  danteSubscriptions,
  routingSummary,
  signalFlowReport,
  deviceTemplate,
  instantiateTemplate,
  createProject,
  addRoom,
  removeRoom,
  renameRoom,
  setActiveRoom,
  updateRoom,
  getActiveRoom,
  serializeProject,
  deserializeProject,
  validate,
  serialize,
  deserialize,
} from '../src/index.js';

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('deployment', () => {
  it('sets status and marks deployed', () => {
    let cfg = createConfig({ name: 'd', createdAt: 'x' });
    cfg = setDeploymentStatus(cfg, 'online');
    expect(cfg.deployment?.status).toBe('online');
    cfg = markDeployed(cfg, '2026-06-09T00:00:00Z');
    expect(cfg.deployment).toEqual({ status: 'deployed', lastDeployedAt: '2026-06-09T00:00:00Z' });
    expect(deserialize(serialize(cfg))).toEqual(cfg); // round-trips
  });

  it('diffs designed vs deployed', () => {
    let base = createConfig({ name: 'd', createdAt: 'x' });
    base = addDevice(base, createProcessor('P', 'DSP'));
    base = addDevice(base, createWirelessMic('M', 'Mic'));
    let target = renameDevice(base, 'M', 'Mic Renamed');
    target = addDevice(target, createLoudspeaker('L', 'Spk'));
    target = route(target, 'P-out-analog-1', 'L-in-analog-1');
    const diff = deploymentDiff(base, target);
    expect(diff.devicesAdded).toEqual(['L']);
    expect(diff.devicesChanged).toEqual(['M']);
    expect(diff.routesAdded.length).toBe(1);
    expect(diff.identical).toBe(false);
    expect(deploymentDiff(base, base).identical).toBe(true);
  });
});

describe('naming', () => {
  it('applies a per-type naming scheme', () => {
    let cfg = createConfig({ name: 'n', createdAt: 'x' });
    cfg = addDevice(cfg, createWirelessMic('M1', 'foo'));
    cfg = addDevice(cfg, createWirelessMic('M2', 'bar'));
    cfg = addDevice(cfg, createLoudspeaker('L1', 'baz'));
    cfg = applyNamingScheme(cfg);
    expect(cfg.devices.map((d) => d.label)).toEqual(['Wireless Mic 1', 'Wireless Mic 2', 'Loudspeaker 1']);
    expect(suggestedLabel(cfg, 'wirelessMic')).toBe('Wireless Mic 3');
  });

  it('warns on duplicate and empty labels', () => {
    let cfg = createConfig({ name: 'n', createdAt: 'x' });
    cfg = addDevice(cfg, createWirelessMic('M1', 'Dup'));
    cfg = addDevice(cfg, createWirelessMic('M2', 'Dup'));
    cfg = addDevice(cfg, createWirelessMic('M3', '  '));
    const w = codes(validate(cfg).warnings);
    expect(w).toContain('NAMING_DUPLICATE_LABEL');
    expect(w).toContain('NAMING_EMPTY_LABEL');
  });
});

describe('routing summary', () => {
  function scene() {
    let cfg = createConfig({ name: 'r', createdAt: 'x' });
    cfg = addDevice(cfg, createProcessor('P', 'DSP'));
    cfg = addDevice(cfg, createWirelessMic('M', 'Mic'));
    cfg = addDevice(cfg, createLoudspeaker('L', 'Spk'));
    cfg = route(cfg, 'M-out-dante-1', 'P-in-dante-1');
    cfg = route(cfg, 'P-out-analog-1', 'L-in-analog-1');
    return cfg;
  }
  it('reports dante subscriptions and counts', () => {
    const cfg = scene();
    const dante = danteSubscriptions(cfg);
    expect(dante.length).toBe(1);
    expect(dante[0]!.fromDeviceLabel).toBe('Mic');
    expect(routingSummary(cfg)).toEqual({ dante: 1, analog: 1, total: 2 });
    expect(signalFlowReport(cfg).split('\n').length).toBe(2);
  });
});

describe('device templates', () => {
  it('captures and instantiates a configured device', () => {
    let cfg = createConfig({ name: 't', createdAt: 'x' });
    cfg = addDevice(cfg, createProcessor('P', 'DSP'));
    cfg = addDspBlock(cfg, 'P', createDspBlock('gain', 'g1'));
    cfg = addDspBlock(cfg, 'P', createDspBlock('peq4', 'q1'));
    const proc = cfg.devices.find((d) => d.id === 'P')!;
    const tpl = deviceTemplate('My DSP', proc);
    expect(tpl.deviceType).toBe('processor');
    expect(tpl.dspBlocks.length).toBe(2);
    const dev = instantiateTemplate(tpl, 'P2', 'DSP 2');
    expect(dev.id).toBe('P2');
    expect(dev.profileId).toBe('generic-hardware-dsp');
    expect(dev.dspBlocks!.map((b) => b.id)).toEqual(['P2-gain-1', 'P2-peq4-2']);
    // instantiated device is valid when added
    let cfg2 = createConfig({ name: 't2', createdAt: 'x' });
    cfg2 = addDevice(cfg2, dev);
    expect(validate(cfg2).ok).toBe(true);
  });
});

describe('projects (multi-room)', () => {
  it('creates, adds, renames, switches and removes rooms', () => {
    let proj = createProject({ name: 'Campus', createdAt: 'x' });
    expect(proj.rooms.length).toBe(1);
    expect(getActiveRoom(proj)!.id).toBe('room-1');
    proj = addRoom(proj, 'Boardroom');
    expect(proj.rooms.length).toBe(2);
    expect(proj.activeRoomId).toBe('room-2');
    proj = renameRoom(proj, 'room-2', 'Big Boardroom');
    expect(getActiveRoom(proj)!.config.metadata.name).toBe('Big Boardroom');
    proj = setActiveRoom(proj, 'room-1');
    expect(proj.activeRoomId).toBe('room-1');
    proj = removeRoom(proj, 'room-1');
    expect(proj.rooms.map((r) => r.id)).toEqual(['room-2']);
    expect(proj.activeRoomId).toBe('room-2');
  });

  it('updates a room config and round-trips the project', () => {
    let proj = createProject({ name: 'Campus', createdAt: 'x' });
    let room = getActiveRoom(proj)!.config;
    room = addDevice(room, createMicrophoneArray('A', 'Array'));
    proj = updateRoom(proj, 'room-1', room);
    const restored = deserializeProject(serializeProject(proj));
    expect(restored.rooms[0]!.config.devices.length).toBe(1);
    expect(restored.activeRoomId).toBe('room-1');
    // each room migrates through the standard config deserializer
    expect(restored.rooms[0]!.config.version).toBe(CONFIG_VERSION);
  });

  it('migrates a v1 room config inside a project', () => {
    const proj = createProject({ name: 'C', createdAt: 'x' });
    const doc = JSON.parse(serializeProject(proj));
    doc.rooms[0].config.version = 1;
    for (const d of doc.rooms[0].config.devices) delete d.profileId;
    const restored = deserializeProject(JSON.stringify(doc));
    expect(restored.rooms[0]!.config.version).toBe(CONFIG_VERSION);
  });
});
