// Tool type spine for the agent system.
//
// Every tool defines:
//   - name + description (LLM surface)
//   - paramSchema (zod — validated at the boundary per V7 + H5 lesson)
//   - handler(args, ctx) → Op[] | Promise<Op[]>
//
// The handler NEVER dispatches to the real DAG store (V7). It returns an
// Op[] the Diff system applies to the forked DAG. The user accepts/rejects
// before any real state mutation.
//
// REF: THESIS.md §18-20, vyapti V7.

import type { z } from 'zod';
import type { ComfyUICapability } from '../../core/comfy';
import type { Op } from '../../core/dag/types';
import type { DagState } from '../../core/dag/state';
import type { StorageCapability } from '../../core/storage';

export interface ToolContext {
  /** Snapshot of the DAG at the time the tool is invoked. */
  dagState: DagState;
  /**
   * Node ids currently selected by the user. Undefined when no selection
   * channel is wired (tests, headless calls).
   */
  selectedNodeIds?: ReadonlySet<string>;
  /**
   * P5: ComfyUI capability for tools that submit AI render workflows
   * (agent.render.dryRunWorkflow). Boot resolves Http vs Stub via
   * pickComfyUI(). Undefined when no capability is wired (tests +
   * tools that don't need ComfyUI).
   */
  comfyCapability?: ComfyUICapability;
  /**
   * P5: storage capability for tools that read/write OPFS-rooted bytes
   * (agent.render.dryRunWorkflow probe write, agent.render.summarize-
   * Stylized read). Boot wires the same StorageCapability the project
   * loader uses.
   */
  storage?: StorageCapability;
}

/**
 * Result of a tool handler.
 * - `ops`: Ops to propose as a diff (empty for read-only tools like dag.inspect).
 * - `text`: Optional text shown to the LLM after tool execution.
 */
export interface ToolResult {
  ops: Op[];
  text?: string;
}

export interface ToolDefinition<T = unknown> {
  name: string;
  description: string;
  paramSchema: z.ZodType<T, z.ZodTypeDef, unknown>;
  handler: (args: T, ctx: ToolContext) => ToolResult | Promise<ToolResult>;
}
