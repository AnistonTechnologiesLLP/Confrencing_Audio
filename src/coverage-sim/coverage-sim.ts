/**
 * Geometric room/device coverage simulation (v4).
 *
 * Answers "what does each device cover, to its spec?" for the UI's simulation
 * view: a microphone's pickup angles, a camera's field-of-view (and who is in
 * frame after furniture occlusion), and a loudspeaker's dispersion. It is
 * **geometric / spec-based** — fast, dependency-free, honest about its caveats —
 * and returns a single view-independent {@link RoomCoverage} the 2D and 3D
 * canvases both render.
 *
 * Pure `Math` only. Reuses {@link arrayCoverageRadius} / {@link steeringAngles}
 * / the furniture catalog rather than reimplementing them.
 */

import type { SystemConfig } from '../model/config.js';
import type {
  Device,
  ConferencingCamera,
  Loudspeaker,
  MicrophoneArray,
} from '../model/devices.js';
import { defaultElevation } from '../model/devices.js';
import { type CoverageZone, isPickupZone } from '../model/coverage.js';
import {
  type Point2D,
  angularSeparationDeg,
  bearingToDeg,
  pointInPolygon,
  pointInSector,
} from '../model/geometry.js';
import { DEFAULT_TALKER_ELEVATION_M } from '../model/talker.js';
import { type Point3D, steeringAngles } from '../geometry/angles.js';
import { arrayCoverageRadius } from '../coverage/check.js';
import { deviceCapabilities } from '../profiles/profiles.js';
import { resolvedDimensions, furnitureCorners, blocksCamera, blocksAudio } from '../furniture/furniture.js';

/**
 * Per-zone steered-beam half-angle for the geometric mic tier (degrees). The
 * profile's `coverageAngleDeg` is the full *unsteered* cone; a steered pickup
 * beam toward a zone is much tighter.
 */
export const DEFAULT_PICKUP_BEAM_HALF_DEG = 35.0;
const SEATED_HEAD_M = DEFAULT_TALKER_ELEVATION_M; // 1.2 m

// ---------------------------------------------------------------------------
// Result structures (view-independent — 2D and 3D render the same data)
// ---------------------------------------------------------------------------

/**
 * A circular sector / cone anchored at `apex` (floor x,y) at height `apexElevM`,
 * centred on compass `azimuthDeg` (0° = +Y, CW) and tilted `tiltDeg` below
 * horizontal (0 = level, 90 = straight down), with horizontal/vertical
 * half-angles and a reach `rangeM`.
 */
export interface CoverageWedge {
  apex: Point2D;
  apexElevM: number;
  azimuthDeg: number;
  tiltDeg: number;
  hHalfDeg: number;
  vHalfDeg: number;
  rangeM: number;
}

/** One target's relationship to a device's coverage. */
export interface TargetHit {
  id: string;
  label: string;
  position: Point2D;
  elevM: number;
  inCoverage: boolean;
  /** Occluded by furniture (cameras). */
  blocked: boolean;
  /** Relative on/off-axis gain (mics), 0 = on-axis; absent for non-mics. */
  gainDb?: number;
  distanceM: number;
}

export interface MicCoverage {
  deviceId: string;
  label: string;
  wedges: CoverageWedge[];
  center?: Point2D;
  /** Floor coverage circle (downward cone), metres. */
  radiusM: number;
  targets: TargetHit[];
  coveredPct: number;
}

export interface CameraCoverage {
  deviceId: string;
  label: string;
  wedge: CoverageWedge;
  targets: TargetHit[];
  framedPct: number;
}

export interface SpeakerCoverage {
  deviceId: string;
  label: string;
  wedge: CoverageWedge;
  targets: TargetHit[];
  coveredPct: number;
}

export interface Occluder {
  objectId: string;
  kind: string;
  corners: Point2D[];
  heightM: number;
  blocksCamera: boolean;
  blocksAudio: boolean;
}

export interface Target {
  id: string;
  label: string;
  position: Point2D;
  elevM: number;
}

export interface RoomCoverage {
  mics: MicCoverage[];
  cameras: CameraCoverage[];
  speakers: SpeakerCoverage[];
  occluders: Occluder[];
  targets: Target[];
  fidelity: string;
  caveats: string[];
  summary: {
    targetCount: number;
    micCovered: number;
    micCoveragePct: number;
    micGaps: string[];
    cameraFramedPct: number;
    hasCamera: boolean;
    hasSpeaker: boolean;
  };
}

// ---------------------------------------------------------------------------
// Scene gathering
// ---------------------------------------------------------------------------

function roomHeight(config: SystemConfig): number {
  return config.room?.height ?? 3.0;
}

function deviceElev(config: SystemConfig, device: Device): number {
  return device.elevation ?? defaultElevation(device, roomHeight(config));
}

function zoneCentroid(zone: CoverageZone): Point2D {
  if (zone.shape.kind === 'rect') {
    const s = zone.shape;
    return { x: s.origin.x + s.width / 2, y: s.origin.y + s.height / 2 };
  }
  const pts = zone.shape.points;
  return {
    x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
    y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
  };
}

/** The points the room must cover: every talker, plus every furniture seat. */
export function roomTargets(config: SystemConfig): Target[] {
  const out: Target[] = [];
  for (const t of config.talkers) {
    out.push({ id: t.id, label: t.label, position: t.position, elevM: t.elevation ?? SEATED_HEAD_M });
  }
  if (config.room) {
    for (const obj of config.room.objects) {
      (obj.seats ?? []).forEach((seat, i) => {
        out.push({ id: `${obj.id}-seat${i + 1}`, label: `${obj.kind} seat ${i + 1}`, position: seat.position, elevM: SEATED_HEAD_M });
      });
    }
  }
  return out;
}

export function roomOccluders(config: SystemConfig): Occluder[] {
  const out: Occluder[] = [];
  if (!config.room) return out;
  for (const obj of config.room.objects) {
    const [, , h] = resolvedDimensions(obj);
    out.push({
      objectId: obj.id,
      kind: obj.kind,
      corners: furnitureCorners(obj),
      heightM: h,
      blocksCamera: blocksCamera(obj),
      blocksAudio: blocksAudio(obj),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Line of sight / occlusion (height-aware)
// ---------------------------------------------------------------------------

/** Parameter `t` along `a→b` where it crosses segment `c→d`, else `null`. */
function segIntersectionT(a: Point2D, b: Point2D, c: Point2D, d: Point2D): number | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const qx = c.x - a.x;
  const qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;
  if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) return t;
  return null;
}

/**
 * Smallest `t` in `(0,1)` where segment `a→b` enters the polygon, or `null`.
 * Endpoints strictly inside count as a crossing at the midpoint.
 */
export function segmentObbEntry(a: Point2D, b: Point2D, corners: Point2D[]): number | null {
  const ts: number[] = [];
  const n = corners.length;
  for (let i = 0; i < n; i++) {
    const t = segIntersectionT(a, b, corners[i]!, corners[(i + 1) % n]!);
    if (t !== null && t > 1e-6 && t < 1 - 1e-6) ts.push(t);
  }
  if (ts.length > 0) return Math.min(...ts);
  if (pointInPolygon(a, corners) || pointInPolygon(b, corners)) return 0.5;
  return null;
}

export function segmentIntersectsObb(a: Point2D, b: Point2D, corners: Point2D[]): boolean {
  return segmentObbEntry(a, b, corners) !== null;
}

/**
 * Height-aware line of sight from a camera at `a` (height `aElev`) to a target at
 * `b` (height `bElev`). A camera-blocking occluder breaks LOS only when its top
 * rises above the sight line where the ray crosses its footprint.
 */
export function cameraSees(
  a: Point2D,
  aElev: number,
  b: Point2D,
  bElev: number,
  occluders: Occluder[],
): boolean {
  for (const oc of occluders) {
    if (!oc.blocksCamera) continue;
    const t = segmentObbEntry(a, b, oc.corners);
    if (t === null) continue;
    const sightH = aElev + t * (bElev - aElev);
    if (oc.heightM >= sightH) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-device coverage
// ---------------------------------------------------------------------------

export function cameraWedge(config: SystemConfig, cam: ConferencingCamera): CoverageWedge | undefined {
  if (!cam.position) return undefined;
  const spec = deviceCapabilities(cam).camera;
  if (!spec) return undefined;
  return {
    apex: cam.position,
    apexElevM: deviceElev(config, cam),
    azimuthDeg: ((cam.bearingDeg % 360) + 360) % 360,
    tiltDeg: cam.tiltDeg,
    hHalfDeg: spec.fovHDeg / 2,
    vHalfDeg: spec.fovVDeg / 2,
    rangeM: spec.maxRangeM,
  };
}

export function cameraCoverage(
  config: SystemConfig,
  cam: ConferencingCamera,
  targets: Target[],
  occluders: Occluder[],
): CameraCoverage | undefined {
  const wedge = cameraWedge(config, cam);
  if (!wedge) return undefined;
  const hits: TargetHit[] = [];
  let framed = 0;
  for (const tg of targets) {
    const dist = Math.hypot(tg.position.x - wedge.apex.x, tg.position.y - wedge.apex.y);
    const inFov = pointInSector(wedge.apex, tg.position, wedge.azimuthDeg, wedge.hHalfDeg, wedge.rangeM);
    const blocked = inFov && !cameraSees(wedge.apex, wedge.apexElevM, tg.position, tg.elevM, occluders);
    const isFramed = inFov && !blocked;
    if (isFramed) framed += 1;
    hits.push({ id: tg.id, label: tg.label, position: tg.position, elevM: tg.elevM, inCoverage: inFov, blocked, distanceM: dist });
  }
  const pct = targets.length ? (framed / targets.length) * 100 : 0;
  return { deviceId: cam.id, label: cam.label, wedge, targets: hits, framedPct: pct };
}

export function speakerWedge(config: SystemConfig, spk: Loudspeaker): CoverageWedge | undefined {
  if (!spk.position) return undefined;
  const spec = deviceCapabilities(spk).speaker;
  if (!spec) return undefined;
  const omni = spk.bearingDeg === undefined; // unaimed ⇒ omnidirectional
  return {
    apex: spk.position,
    apexElevM: deviceElev(config, spk),
    azimuthDeg: (((spk.bearingDeg ?? 0) % 360) + 360) % 360,
    tiltDeg: spk.tiltDeg ?? 0,
    hHalfDeg: omni ? 180 : spec.dispersionHDeg / 2,
    vHalfDeg: spec.dispersionVDeg / 2,
    rangeM: spec.maxRangeM,
  };
}

export function speakerCoverage(
  config: SystemConfig,
  spk: Loudspeaker,
  targets: Target[],
): SpeakerCoverage | undefined {
  const wedge = speakerWedge(config, spk);
  if (!wedge) return undefined;
  const hits: TargetHit[] = [];
  let covered = 0;
  for (const tg of targets) {
    const dist = Math.hypot(tg.position.x - wedge.apex.x, tg.position.y - wedge.apex.y);
    const inside = pointInSector(wedge.apex, tg.position, wedge.azimuthDeg, wedge.hHalfDeg, wedge.rangeM);
    if (inside) covered += 1;
    hits.push({ id: tg.id, label: tg.label, position: tg.position, elevM: tg.elevM, inCoverage: inside, blocked: false, distanceM: dist });
  }
  const pct = targets.length ? (covered / targets.length) * 100 : 0;
  return { deviceId: spk.id, label: spk.label, wedge, targets: hits, coveredPct: pct };
}

/**
 * Geometric mic pickup: one steered beam toward each pickup zone (or a single
 * downward cone when unzoned). Targets inside a beam sector and the floor
 * coverage circle are "picked up", with a coarse off-axis gain rolloff.
 */
export function micCoverage(
  config: SystemConfig,
  array: MicrophoneArray,
  targets: Target[],
): MicCoverage | undefined {
  if (!array.position) return undefined;
  const cap = deviceCapabilities(array);
  const angle = cap.coverageAngleDeg;
  const center = array.position;
  const elev = deviceElev(config, array);
  const circRadius = arrayCoverageRadius(elev, SEATED_HEAD_M, angle);

  const pickupZones = array.zones.filter(isPickupZone);
  const wedges: CoverageWedge[] = [];
  if (pickupZones.length > 0) {
    const src: Point3D = { x: center.x, y: center.y, z: elev };
    for (const z of pickupZones) {
      const cen = zoneCentroid(z);
      const sa = steeringAngles(src, { x: cen.x, y: cen.y, z: SEATED_HEAD_M });
      const reach = circRadius > 0 ? circRadius : Math.max(sa.horizontalDistance, 1.0);
      wedges.push({
        apex: center,
        apexElevM: elev,
        azimuthDeg: sa.azimuthDeg,
        tiltDeg: sa.downtiltDeg,
        hHalfDeg: DEFAULT_PICKUP_BEAM_HALF_DEG,
        vHalfDeg: DEFAULT_PICKUP_BEAM_HALF_DEG,
        rangeM: reach,
      });
    }
  } else {
    const half = angle ? angle / 2 : 60;
    wedges.push({
      apex: center,
      apexElevM: elev,
      azimuthDeg: 0,
      tiltDeg: 90,
      hHalfDeg: half,
      vHalfDeg: half,
      rangeM: circRadius > 0 ? circRadius : 3,
    });
  }

  const hits: TargetHit[] = [];
  let covered = 0;
  for (const tg of targets) {
    const dist = Math.hypot(tg.position.x - center.x, tg.position.y - center.y);
    let isCov = false;
    let gain: number | undefined;
    if (pickupZones.length > 0) {
      const bearing = bearingToDeg(center, tg.position);
      for (const wd of wedges) {
        const reach = circRadius > 0 ? circRadius : wd.rangeM;
        const sep = angularSeparationDeg(bearing, wd.azimuthDeg);
        if (dist <= reach && sep <= wd.hHalfDeg) {
          isCov = true;
          gain = -6.0 * (sep / wd.hHalfDeg) ** 2;
          break;
        }
      }
    } else if (circRadius > 0 && dist <= circRadius) {
      isCov = true;
      gain = 0.0;
    }
    if (isCov) covered += 1;
    hits.push(
      gain !== undefined
        ? { id: tg.id, label: tg.label, position: tg.position, elevM: tg.elevM, inCoverage: isCov, blocked: false, gainDb: gain, distanceM: dist }
        : { id: tg.id, label: tg.label, position: tg.position, elevM: tg.elevM, inCoverage: isCov, blocked: false, distanceM: dist },
    );
  }
  const pct = targets.length ? (covered / targets.length) * 100 : 0;
  return { deviceId: array.id, label: array.label, wedges, center, radiusM: circRadius, targets: hits, coveredPct: pct };
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

/** Override the geometric mic tier (e.g. a beamformer-based physics tier). */
export type MicCoverageFn = (
  config: SystemConfig,
  array: MicrophoneArray,
  targets: Target[],
) => MicCoverage | undefined;

const GEOMETRIC_CAVEATS = [
  'Geometric, spec-based estimate (azimuth coverage from datasheet angles).',
  'Free-field: no acoustic reflections, reverberation, or directivity-vs-frequency.',
  'Camera occlusion is height-aware line-of-sight only (no transparency/partial framing).',
];

/**
 * Aggregate coverage for every placed mic/camera/speaker into one
 * {@link RoomCoverage}. `micCoverageFn` overrides the geometric mic tier behind
 * the same contract.
 */
export function simulateRoomCoverage(
  config: SystemConfig,
  opts: { micCoverageFn?: MicCoverageFn } = {},
): RoomCoverage {
  const targets = roomTargets(config);
  const occluders = roomOccluders(config);
  const micFn = opts.micCoverageFn ?? micCoverage;

  const mics: MicCoverage[] = [];
  const cameras: CameraCoverage[] = [];
  const speakers: SpeakerCoverage[] = [];
  for (const d of config.devices) {
    if (d.type === 'microphoneArray') {
      const mc = micFn(config, d, targets);
      if (mc) mics.push(mc);
    } else if (d.type === 'camera') {
      const cc = cameraCoverage(config, d, targets, occluders);
      if (cc) cameras.push(cc);
    } else if (d.type === 'loudspeaker') {
      const sc = speakerCoverage(config, d, targets);
      if (sc) speakers.push(sc);
    }
  }

  const micIds = new Set<string>();
  for (const mc of mics) for (const h of mc.targets) if (h.inCoverage) micIds.add(h.id);
  const n = targets.length;
  const uncovered = targets.filter((t) => !micIds.has(t.id)).map((t) => t.id);
  const micPct = n ? (micIds.size / n) * 100 : 0;
  const framedIds = new Set<string>();
  for (const cc of cameras) for (const h of cc.targets) if (h.inCoverage && !h.blocked) framedIds.add(h.id);
  const camPct = n ? (framedIds.size / n) * 100 : 0;

  return {
    mics,
    cameras,
    speakers,
    occluders,
    targets,
    fidelity: 'geometric',
    caveats: [...GEOMETRIC_CAVEATS],
    summary: {
      targetCount: n,
      micCovered: micIds.size,
      micCoveragePct: micPct,
      micGaps: uncovered,
      cameraFramedPct: camPct,
      hasCamera: cameras.length > 0,
      hasSpeaker: speakers.length > 0,
    },
  };
}
