// agent.render.summarizePass — describe a pass result by (jobId, frame, kind).
//
// Read-only. Evaluates the dag at the requested time and returns the pass's
// metadata: descriptor (size + format), sourceHash, and the storage path
// the bytes would write to. The agent uses this handle to talk about
// renders without needing the actual pixels — vision-on-trigger reads the
// stored bytes when describing visual content.
//
// Locating the pass (#608): the tool walks the RenderJob's 'pass-input'
// bindings and matches on the ROLE THE PRODUCER DECLARES — a graph fact,
// resolved without evaluating anything. Only a matching pass is then
// evaluated, for its descriptor and hash. Previously the match came from
// `passKind` on the EVALUATED value, which meant every attached pass was
// evaluated to answer a read-only question, and any node emitting that tag
// (an imported MediaClip) passed for a beauty pass.
//
// There is no "multiple matches" case any more, and that is a fact about the
// MODEL rather than a decision by this reader: a role can be bound once per
// list socket, enforced at connect and re-asserted when a project is loaded.
// The tool used to return `ambiguous` and take a `passId` to break ties; both
// are gone, because the state they described is no longer constructible.
//
// REF: THESIS §43 ("Pass results stored such that agent can describe them"),
// project_p4_prompt locked decisions, vyapti V7 (tools never dispatch).

import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from './types';
import { evaluate } from '../../core/dag/evaluator';
import { passRoleOf } from '../../core/dag/passRole';
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
}

export const renderSummarizePassTool: ToolDefinition<SummarizePassArgs> = {
  name: 'agent.render.summarizePass',
  description:
    'Describe a render pass result by jobId + passKind + frame. Returns the ' +
    "pass's sourceHash, descriptor (width/height/format), and the storage path " +
    'the bytes write to (when the job runs). Read-only; evaluates the DAG at ' +
    'the requested time to derive the deterministic pass handle. A job holds at ' +
    'most one pass of each kind, so jobId + passKind identifies it exactly.',
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

    // #608 — the ROLE is read from the producer's DECLARATION, so which binding is
    // the depth pass is settled before anything is evaluated. Evaluation is then
    // only for the pass's own metadata (descriptor, hash), which genuinely does
    // need the value. A node that declares no role — an imported clip, a workflow
    // result — is not a pass and never matches, however its value tags itself.
    // #608 — ONE binding can carry a given role, so this is a find rather than a
    // collect-and-pick. The singular shape is the point: there is no runner-up to
    // report, no first-wins rule to document and no `ambiguous` flag to return,
    // because the graph can no longer hold the state those existed to describe.
    const match = refs.find((ref) => passRoleOf(dagState, ref) === args.passKind);
    if (!match) {
      return {
        ops: [],
        text: `Error: no ${args.passKind} pass connected to job "${args.jobId}"`,
      };
    }

    const pass = evaluate(dagState, match.node, { ctx: evalCtx, socket: match.socket })
      .value as ImageValue;
    if (pass.kind !== 'Image') {
      return {
        ops: [],
        text: `Error: "${match.node}" declares a ${args.passKind} pass but did not evaluate to an Image`,
      };
    }

    const padded = args.frame.toString().padStart(4, '0');
    const trimmedPath = meta.outputPath.replace(/\/+$/, '');
    const summary: PassSummary = {
      jobId: meta.jobId,
      passId: match.node,
      passKind: pass.passKind,
      frame: args.frame,
      seconds,
      fps,
      sourceHash: pass.sourceHash,
      descriptor: { ...pass.descriptor },
      outputPath: `${trimmedPath}/${pass.passKind}_${padded}.png`,
    };
    return { ops: [], text: JSON.stringify(summary, null, 2) };
  },
};
