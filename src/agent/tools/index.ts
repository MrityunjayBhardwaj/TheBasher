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
export { listMutatorsTool, getMutatorTool, proposePlanTool } from '../mutators/tool';
export { listStrategiesTool, getStrategyTool } from '../strategy/tool';
export { renderSummarizePassTool } from './renderSummarizePass';
export { renderDryRunWorkflowTool } from './renderDryRunWorkflow';
export { renderSummarizeStylizedTool } from './renderSummarizeStylized';

import { registerTool } from './registry';
import { characterWalkToTool } from './characterWalkTo';
import { cameraSnapshotTool } from './cameraSnapshot';
import { libraryImportTool } from './libraryImport';
import { meshAddTool } from './meshAdd';
import { dagInspectTool } from './dagInspect';
import { dagExecTool } from './dagExec';
import { identifyTool } from '../identify/identify';
import { listMutatorsTool, getMutatorTool, proposePlanTool } from '../mutators/tool';
import { listStrategiesTool, getStrategyTool } from '../strategy/tool';
import { renderSummarizePassTool } from './renderSummarizePass';
import { renderDryRunWorkflowTool } from './renderDryRunWorkflow';
import { renderSummarizeStylizedTool } from './renderSummarizeStylized';

export function registerAllTools(): void {
  registerTool(characterWalkToTool);
  registerTool(cameraSnapshotTool);
  registerTool(libraryImportTool);
  registerTool(meshAddTool);
  registerTool(dagInspectTool);
  registerTool(dagExecTool);
  registerTool(identifyTool);
  registerTool(listMutatorsTool);
  registerTool(getMutatorTool);
  registerTool(proposePlanTool);
  registerTool(listStrategiesTool);
  registerTool(getStrategyTool);
  // P4 Wave C — render graph
  registerTool(renderSummarizePassTool);
  // P5 Wave C — AI render bridge
  registerTool(renderDryRunWorkflowTool);
  registerTool(renderSummarizeStylizedTool);
  // Mutator + strategy catalogs are registered separately via
  // registerAllMutators() / registerAllStrategies() — keeps registry
  // resets independent in tests; boot wires all three.
}
