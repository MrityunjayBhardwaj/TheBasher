// agent.render.summarizePass — describe a pass result by (jobId, frame, kind).
//
// Read-only. Evaluates the dag at the requested time and returns the pass's
// metadata: descriptor (size + format), sourceHash, and the storage path
// the bytes would write to. The agent uses this handle to talk about
// renders without needing the actual pixels — vision-on-trigger reads the
// stored bytes when describing visual content.
//
// Locating the pass: the tool walks the RenderJob's 'pass-input' bindings
// looking for an attached pass node whose evaluator returns the requested
// passKind. If multiple matches exist, the FIRST is returned (with a
// note); the caller can disambiguate by passing a passId.
//
// REF: THESIS §43 ("Pass results stored such that agent can describe them"),
// project_p4_prompt locked decisions, vyapti V7 (tools never dispatch).

import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from './types';
import { evaluate } from '../../core/dag/evaluator';
import type { ImagePassKind, ImageValue, JobResultValue } from '../../nodes/types';

const SummarizePassSchema = z.object({
  jobId: z.string().min(1).describe('RenderJob node id whose pass tree to inspect'),
  passKind: z
    .enum(['beauty', 'id', 'depth', 'normal'])
    .describe(
      'Which raw pass kind to summarize. For stylized output use agent.render.summarizeStylized.',
    ),
  frame: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe('Frame number to evaluate the pass at; default 0'),
  passId: z
    .string()
    .optional()
    .describe(
      'Optional explicit pass node id when multiple passes of the same kind hang off the job',
    ),
});
export type SummarizePassArgs = z.infer<typeof SummarizePassSchema>;

interface PassSummary {
  jobId: string;
  passId: string;
  passKind: ImagePassKind;
  frame: number;
  seconds: number;
  fps: number;
  sourceHash: string;
  descriptor: { width: number; height: number; format: string };
  outputPath: string;
  /** True when multiple passes of the requested kind exist on the job; FIRST returned. */
  ambiguous: boolean;
}

export const renderSummarizePassTool: ToolDefinition<SummarizePassArgs> = {
  name: 'agent.render.summarizePass',
  description:
    'Describe a render pass result by jobId + passKind + frame. Returns the ' +
    "pass's sourceHash, descriptor (width/height/format), and the storage path " +
    'the bytes write to (when the job runs). Read-only; evaluates the DAG at ' +
    'the requested time to derive the deterministic pass handle. Pass passId ' +
    'when multiple passes of the same kind hang off the job.',
  paramSchema: SummarizePassSchema,
  handler(args: SummarizePassArgs, ctx: ToolContext): ToolResult {
    const { dagState } = ctx;
    const job = dagState.nodes[args.jobId];
    if (!job) {
      return { ops: [], text: `Error: jobId "${args.jobId}" not found` };
    }
    if (job.type !== 'RenderJob') {
      return {
        ops: [],
        text: `Error: jobId "${args.jobId}" is ${job.type}; expected a RenderJob`,
      };
    }
    const binding = job.inputs['pass-input'];
    const refs = binding === undefined ? [] : Array.isArray(binding) ? binding : [binding];
    if (refs.length === 0) {
      return {
        ops: [],
        text:
          `Error: RenderJob "${args.jobId}" has no passes connected to its pass-input socket. ` +
          `Use mutator.render.addPass to add one.`,
      };
    }

    // Resolve the job's metadata (frame range, fps, outputPath) at frame 0.
    const meta = evaluate(dagState, args.jobId, {
      ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
    }).value as JobResultValue;
    const fps = meta.frames.fps;
    const seconds = args.frame / fps;
    const evalCtx = { time: { frame: args.frame, seconds, normalized: 0 } };

    const candidates: Array<{ passId: string; pass: ImageValue }> = [];
    for (const ref of refs) {
      const result = evaluate(dagState, ref.node, { ctx: evalCtx, socket: ref.socket });
      const pass = result.value as ImageValue;
      if (pass.kind !== 'Image') continue;
      if (pass.passKind !== args.passKind) continue;
      if (args.passId !== undefined && ref.node !== args.passId) continue;
      candidates.push({ passId: ref.node, pass });
    }

    if (candidates.length === 0) {
      const detail = args.passId
        ? `passId "${args.passId}" not in job's pass-input list`
        : `no ${args.passKind} pass connected to job "${args.jobId}"`;
      return { ops: [], text: `Error: ${detail}` };
    }

    const winner = candidates[0];
    const padded = args.frame.toString().padStart(4, '0');
    const trimmedPath = meta.outputPath.replace(/\/+$/, '');
    const summary: PassSummary = {
      jobId: meta.jobId,
      passId: winner.passId,
      passKind: winner.pass.passKind,
      frame: args.frame,
      seconds,
      fps,
      sourceHash: winner.pass.sourceHash,
      descriptor: { ...winner.pass.descriptor },
      outputPath: `${trimmedPath}/${winner.pass.passKind}_${padded}.png`,
      ambiguous: candidates.length > 1,
    };
    return { ops: [], text: JSON.stringify(summary, null, 2) };
  },
};
