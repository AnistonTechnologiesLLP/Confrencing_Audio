/**
 * Node-only entry point — features that require a Node runtime (filesystem and
 * an HTTP server). Kept out of the main barrel so the core stays browser-safe
 * (no `node:*` imports leak into a browser bundle).
 *
 * ```ts
 * import { ControlApiServer, ConfigHolder, ProjectFileManager } from 'conferencing-audio-pipeline/node';
 * ```
 *
 * No npm runtime dependency is added — these build on Node's built-in modules
 * (`node:http`, `node:fs`, `node:path`, `node:os`).
 */

export { ControlApiServer, ConfigHolder } from './control-api/server.js';
export { ProjectFileManager, OpenResult, defaultStateDir, RECENT_MAX } from './files/files.js';
export type { RecoveryInfo } from './files/files.js';
