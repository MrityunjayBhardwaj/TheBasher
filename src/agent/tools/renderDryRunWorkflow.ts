// agent.render.dryRunWorkflow — cost preview for a ComfyUIWorkflow node.
//
// Read-only from the DAG's perspective: emits no Ops. Submits frame
// `frameStart` of the workflow through the configured ComfyUI capability,
// times it, writes the probe bytes to the canonical D-04 path (so the
// eventual full run cache-hits frame 0), and returns the extrapolation.
//
// The tool ships behind ToolContext deps — capability + storage +
// compileWorkflow are wired by the orchestrator's setup at boot. When
// any are missing (e.g. ComfyUI unreachable, no storage capability),
// the tool returns a structured error instead of throwing.
//
// REF: project_p5_context D-06; vyapti V7 (tools never dispatch).

import { z } from 'zod';
import { dryRun, type DryRunReport } from '../../render/dryRun';
import { stylizedRealismPreset } from '../strategy/presets/stylizedRealism';
import type { ToolContext, ToolDefinition, ToolResult } from './types';

const DryRunWorkflowSchema = z.object({
  workflowNodeId: z
    .string()
    .min(1)
    .describe(
      'ComfyUIWorkflow node id to probe — addAIPass returns the workflowId you can pass here.',
    ),
});
export type DryRunWorkflowArgs = z.infer<typeof DryRunWorkflowSchema>;

export const renderDryRunWorkflowTool: ToolDefinition<DryRunWorkflowArgs> = {
  name: 'agent.render.dryRunWorkflow',
  description:
    'Cost preview for an AI render workflow. Submits ONE frame through ' +
    'the configured ComfyUI capability, times it, and extrapolates to the ' +
    "workflow's full frame range. Returns { frames, estimatedSeconds, " +
    'samplePath, probeJobId }. Read-only — emits no Ops. Surface the ' +
    'estimate AND the sample path to the user before recommending the ' +
    'full render. The probe writes to the canonical D-04 path so the ' +
    'subsequent full run cache-hits frame 0.',
  paramSchema: DryRunWorkflowSchema,
  async handler(args: DryRunWorkflowArgs, ctx: ToolContext): Promise<ToolResult> {
    const { dagState } = ctx;
    const node = dagState.nodes[args.workflowNodeId];
    if (!node) {
      return {
        ops: [],
        text: `Error: workflowNodeId "${args.workflowNodeId}" not found`,
      };
    }
    if (node.type !== 'ComfyUIWorkflow') {
      return {
        ops: [],
        text:
          `Error: workflowNodeId "${args.workflowNodeId}" is ${node.type}; ` +
          'expected a ComfyUIWorkflow.',
      };
    }
    if (!ctx.comfyCapability) {
      return {
        ops: [],
        text:
          'Error: no ComfyUI capability configured. Start ComfyUI locally on ' +
          'http://127.0.0.1:8188 (default) or set settings comfyui.serverUrl.',
      };
    }
    if (!ctx.storage) {
      return {
        ops: [],
        text: 'Error: no storage capability configured for cost preview.',
      };
    }
    // v0.5: only the stylizedRealism preset is registered, so we bind
    // its compile factory directly. v0.6 dispatches over presetId via
    // the preset registry.
    const compileWorkflow = stylizedRealismPreset.compile({ storage: ctx.storage });
    let report: DryRunReport;
    try {
      report = await dryRun(args.workflowNodeId, dagState, {
        capability: ctx.comfyCapability,
        storage: ctx.storage,
        compileWorkflow,
      });
    } catch (err) {
      return {
        ops: [],
        text: `Error: dryRun failed — ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { ops: [], text: JSON.stringify(report, null, 2) };
  },
};
