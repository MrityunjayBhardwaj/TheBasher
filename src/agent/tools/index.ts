// Agent tool barrel — register all first-party tools.
//
// Call `registerAllTools()` from boot alongside `registerAllNodes()`.
// Returns the list so callers can inspect what's available.

export { registerTool, getTool, listTools, __resetToolRegistryForTests } from './registry';
export type { ToolDefinition, ToolContext } from './types';
export { characterWalkToTool } from './characterWalkTo';
export { cameraSnapshotTool } from './cameraSnapshot';
export { libraryImportTool } from './libraryImport';
export { meshAddTool } from './meshAdd';

import { registerTool } from './registry';
import { characterWalkToTool } from './characterWalkTo';
import { cameraSnapshotTool } from './cameraSnapshot';
import { libraryImportTool } from './libraryImport';
import { meshAddTool } from './meshAdd';

export function registerAllTools(): void {
  registerTool(characterWalkToTool);
  registerTool(cameraSnapshotTool);
  registerTool(libraryImportTool);
  registerTool(meshAddTool);
}
