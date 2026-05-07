// Agent tool barrel — register all first-party tools.
//
// Call `registerAllTools()` from boot alongside `registerAllNodes()`.
// Returns the list so callers can inspect what's available.

export { registerTool, getTool, listTools, __resetToolRegistryForTests } from './registry';
export type { ToolDefinition, ToolContext, ToolResult } from './types';
export { characterWalkToTool } from './characterWalkTo';
export { cameraSnapshotTool } from './cameraSnapshot';
export { libraryImportTool } from './libraryImport';
export { meshAddTool } from './meshAdd';
export { dagInspectTool } from './dagInspect';
export { dagExecTool } from './dagExec';
export { identifyTool } from '../identify/identify';

import { registerTool } from './registry';
import { characterWalkToTool } from './characterWalkTo';
import { cameraSnapshotTool } from './cameraSnapshot';
import { libraryImportTool } from './libraryImport';
import { meshAddTool } from './meshAdd';
import { dagInspectTool } from './dagInspect';
import { dagExecTool } from './dagExec';
import { identifyTool } from '../identify/identify';

export function registerAllTools(): void {
  registerTool(characterWalkToTool);
  registerTool(cameraSnapshotTool);
  registerTool(libraryImportTool);
  registerTool(meshAddTool);
  registerTool(dagInspectTool);
  registerTool(dagExecTool);
  registerTool(identifyTool);
}
