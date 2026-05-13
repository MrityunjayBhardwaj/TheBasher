// agent.render.summarizeStylized — describe a stylized output by
// (workflowNodeId, frame).
//
// Sister to agent.render.summarizePass (P4): same handle-without-pixels
// shape, but reads from a ComfyUIWorkflow node instead of a raw pass.
// Returns the workflow's metadata + the D-04 path the stylized frame
// is (or will be) at + whether the bytes exist on disk yet.
//
// The agent uses this to talk about a stylized render without loading
// pixels. When the user asks "is the cube done stylizing?", the agent
// calls this with a few frames and reads `bytesPresent` to know which
// frames have been produced.
//
// REF: project_p5_plan C4; vyapti V7 (tools never dispatch).

import { z } from 'zod';
import { evaluate } from '../../core/dag/evaluator';
import { framePath } from '../../render/dryRun';
import type { ComfyUIWorkflowParams } from '../../nodes/ComfyUIWorkflow';
import type { ImageDescriptor, ImageValue } from '../../nodes/types';
import type { ToolContext, ToolDefinition, ToolResult } from './types';

const SummarizeStylizedSchema = z.object({
  workflowNodeId: z
    .string()
    .min(1)
    .describe('ComfyUIWorkflow node id whose stylized output to summarize'),
  frame: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('Frame number to summarize; default 0'),
});
export type SummarizeStylizedArgs = z.infer<typeof SummarizeStylizedSchema>;

interface StylizedSummary {
  workflowId: string;
  presetId: string;
  frame: number;
  seconds: number;
  fps: number;
  sourceHash: string;
  descriptor: ImageDescriptor;
  outputPath: string;
  /** True iff the storage capability reports bytes exist at outputPath. */
  bytesPresent: boolean;
  /** Resume sentinel: -1 means no frames produced yet. */
  lastGoodFrame: number;
}

export const renderSummarizeStylizedTool: ToolDefinition<SummarizeStylizedArgs> = {
  name: 'agent.render.summarizeStylized',
  description:
    'Describe a stylized AI render frame by workflowNodeId + frame. Returns ' +
    'the stylized output sourceHash, descriptor, D-04 storage path, ' +
    'whether the bytes exist on disk yet, and lastGoodFrame (so the agent ' +
    'can answer "how far has stylization progressed?"). Read-only.',
  paramSchema: SummarizeStylizedSchema,
  async handler(args: SummarizeStylizedArgs, ctx: ToolContext): Promise<ToolResult> {
    const { dagState } = ctx;
    const node = dagState.nodes[args.workflowNodeId];
    if (!node) {
      return { ops: [], text: `Error: workflowNodeId "${args.workflowNodeId}" not found` };
    }
    if (node.type !== 'ComfyUIWorkflow') {
      return {
        ops: [],
        text:
          `Error: workflowNodeId "${args.workflowNodeId}" is ${node.type}; ` +
          'expected a ComfyUIWorkflow.',
      };
    }
    const params = node.params as Partial<ComfyUIWorkflowParams>;
    const presetId = params.presetId ?? 'stylizedRealism';
    const outputPath = params.outputPath ?? '';
    const lastGoodFrame = params.lastGoodFrame ?? -1;
    if (!outputPath) {
      return {
        ops: [],
        text:
          `Error: workflow "${args.workflowNodeId}" has empty outputPath. ` +
          'Run mutator.render.addAIPass to author the path before summarizing.',
      };
    }

    // Evaluate the workflow at the requested frame. fps is fixed at 30
    // (matches runComfyUIWorkflow's ctxForFrame).
    const fps = 30;
    const seconds = args.frame / fps;
    const evalCtx = { time: { frame: args.frame, seconds, normalized: 0 } };
    const result = evaluate(dagState, args.workflowNodeId, { ctx: evalCtx });
    const stylized = result.value as ImageValue;
    if (stylized.kind !== 'Image' || stylized.passKind !== 'stylized') {
      return {
        ops: [],
        text:
          `Error: evaluator for "${args.workflowNodeId}" did not return a stylized Image — ` +
          `got ${JSON.stringify({ kind: stylized.kind, passKind: stylized.passKind })}`,
      };
    }

    const path = framePath(outputPath, args.frame);
    let bytesPresent = false;
    if (ctx.storage) {
      try {
        bytesPresent = await ctx.storage.exists(path);
      } catch {
        bytesPresent = false;
      }
    }

    const summary: StylizedSummary = {
      workflowId: args.workflowNodeId,
      presetId,
      frame: args.frame,
      seconds,
      fps,
      sourceHash: stylized.sourceHash,
      descriptor: { ...stylized.descriptor },
      outputPath: path,
      bytesPresent,
      lastGoodFrame,
    };
    return { ops: [], text: JSON.stringify(summary, null, 2) };
  },
};
