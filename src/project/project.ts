/**
 * Projects (Designer's multi-room "design files"). A project holds several named
 * rooms (each a {@link SystemConfig}) plus an active-room pointer, and
 * round-trips to versioned JSON. Per-room configs reuse the standard
 * serialize/deserialize (so v1→v2 migration applies on load).
 */
import type { SystemConfig } from '../model/config.js';
import { createConfig } from '../config/create.js';
import { serialize, deserialize, DeserializeError } from '../persistence/serialize.js';

/** Schema version for the project document. */
export const PROJECT_VERSION = 1;

/** A named room inside a project. */
export interface ProjectRoom {
  id: string;
  config: SystemConfig;
}

/** A multi-room project. */
export interface Project {
  version: number;
  metadata: { name: string; createdAt: string };
  rooms: ProjectRoom[];
  activeRoomId: string | null;
}

/** Create a project with one empty default room. */
export function createProject(meta: { name: string; createdAt: string }): Project {
  const room: ProjectRoom = { id: 'room-1', config: createConfig({ name: 'Room 1', createdAt: meta.createdAt }) };
  return { version: PROJECT_VERSION, metadata: { ...meta }, rooms: [room], activeRoomId: room.id };
}

function nextRoomId(project: Project): string {
  let n = project.rooms.length + 1;
  while (project.rooms.some((r) => r.id === `room-${n}`)) n++;
  return `room-${n}`;
}

/** Add a new room (becomes active). Returns a new project. */
export function addRoom(project: Project, name?: string): Project {
  const id = nextRoomId(project);
  const createdAt = project.metadata.createdAt;
  const roomName = name ?? `Room ${project.rooms.length + 1}`;
  const room: ProjectRoom = { id, config: createConfig({ name: roomName, createdAt }) };
  return { ...project, rooms: [...project.rooms, room], activeRoomId: id };
}

/** Remove a room. Active pointer falls back to the first remaining room. Returns a new project. */
export function removeRoom(project: Project, roomId: string): Project {
  const rooms = project.rooms.filter((r) => r.id !== roomId);
  const activeRoomId = project.activeRoomId === roomId ? (rooms[0]?.id ?? null) : project.activeRoomId;
  return { ...project, rooms, activeRoomId };
}

/** Rename a room (sets its config's metadata.name). Returns a new project. */
export function renameRoom(project: Project, roomId: string, name: string): Project {
  return {
    ...project,
    rooms: project.rooms.map((r) =>
      r.id === roomId ? { ...r, config: { ...r.config, metadata: { ...r.config.metadata, name } } } : r,
    ),
  };
}

/** Set the active room. Returns a new project. */
export function setActiveRoom(project: Project, roomId: string): Project {
  if (!project.rooms.some((r) => r.id === roomId)) throw new Error(`Unknown room: ${roomId}`);
  return { ...project, activeRoomId: roomId };
}

/** Replace a room's config. Returns a new project. */
export function updateRoom(project: Project, roomId: string, config: SystemConfig): Project {
  return { ...project, rooms: project.rooms.map((r) => (r.id === roomId ? { ...r, config } : r)) };
}

/** Get a room by id. */
export function getRoom(project: Project, roomId: string): ProjectRoom | undefined {
  return project.rooms.find((r) => r.id === roomId);
}

/** Get the active room (or undefined). */
export function getActiveRoom(project: Project): ProjectRoom | undefined {
  return project.activeRoomId === null ? undefined : getRoom(project, project.activeRoomId);
}

/** Serialize a project to JSON (each room config via the standard serializer). */
export function serializeProject(project: Project, pretty = false): string {
  const doc = {
    version: project.version,
    metadata: project.metadata,
    activeRoomId: project.activeRoomId,
    rooms: project.rooms.map((r) => ({ id: r.id, config: JSON.parse(serialize(r.config)) })),
  };
  return JSON.stringify(doc, null, pretty ? 2 : undefined);
}

/** Parse a project from JSON, migrating each room config as needed. */
export function deserializeProject(json: string): Project {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new DeserializeError(`Invalid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new DeserializeError('Project must be a JSON object.');
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== PROJECT_VERSION) {
    throw new DeserializeError(`Unsupported project version ${obj.version}; expected ${PROJECT_VERSION}.`);
  }
  if (!Array.isArray(obj.rooms)) throw new DeserializeError('Project "rooms" must be an array.');
  const rooms: ProjectRoom[] = (obj.rooms as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    config: deserialize(JSON.stringify(r.config)),
  }));
  return {
    version: PROJECT_VERSION,
    metadata: obj.metadata as { name: string; createdAt: string },
    rooms,
    activeRoomId: (obj.activeRoomId as string | null) ?? (rooms[0]?.id ?? null),
  };
}
