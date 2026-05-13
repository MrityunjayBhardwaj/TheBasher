// addStitch Mutator — wires a VideoStitch node onto an existing
// ComfyUIWorkflow's stylized output, producing a final encoded video
// at runtime.
//
// Single Mutator, no preset discriminator (v0.5 ships one codec —
// h264 — and one container — mp4). Future codec additions extend the
// VideoStitch enum + this Mutator's spec; the mechanical V14 guard
// catches collisions if the contract signature stays static.
//
// Closure: { rootSelectors: [jobId, workflowId], followedEdges:
// ['pass-input'] }. The workflow's output flows over the same
// pass-input kind into the stitch — D-01 reuse, no new EdgeKind.
//
// V14 non-redundancy: contract signature is unique vs the 13 existing
// Mutators. requiredNodeTypes=['RenderJob','ComfyUIWorkflow'] is the
// distinguishing feature (no other Mutator declares both).
//
// REF: project_p5_context D-01 / D-05; vyapti V13 / V14;
// dcc-reference §21 (mp4 container + frame numbering conventions).

import { z } from 'zod';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { NodeId, Op } from '../../../core/dag/types';
import type { ComfyUIWorkflowParams } from '../../../nodes/ComfyUIWorkflow';
import type { MutatorDefinition } from '../types';

const AddStitchSpec = z.object({
  jobId: z.string().min(1),
  workflowId: z.string().min(1),
  /** Optional codec override (v0.5 ships h264 only). */
  codec: z.enum(['h264']).optional(),
  /** Optional fps override (defaults to workflow / RenderJob fps). */
  fps: z.number().int().positive().optional(),
  /** Optional explicit ids — auto-derived from jobId when omitted. */
  stitchId: z.string().optional(),
  /** Optional explicit outputPath. Defaults to ${jobOutputPath}/final.mp4. */
  outputPath: z.string().optional(),
});
export type AddStitchSpec = z.infer<typeof AddStitchSpec>;

interface RenderJobLikeParams {
  outputPath?: string;
  fps?: number;
}

function defaultStitchId(jobId: NodeId, used: Set<NodeId>): NodeId {
  const base = `${jobId}_stitch`;
  if (!used.has(base)) return base;
  let n = 1;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

export const addStitchMutator: MutatorDefinition<AddStitchSpec> = {
  name: 'mutator.render.addStitch',
  description:
    'Stitch a ComfyUIWorkflow\'s stylized frames into a final video file. ' +
    'Adds a VideoStitch node consuming the workflow\'s frames over the ' +
    'pass-input edge kind (D-01 reuse) + a Time wire. Produces an MP4 ' +
    'at `${jobOutputPath}/final.mp4` by default. v0.5 codec: h264 only.',
  spec: AddStitchSpec,
  specExample: {
    jobId: 'job',
    workflowId: 'job_stylizedRealism_workflow',
  },
  contract: {
    requiredEdges: ['pass-input'],
    requiredNodeTypes: ['RenderJob', 'ComfyUIWorkflow'],
    preserves: ['position', 'rotation', 'scale', 'children', 'material'],
  },
  buildClosureSpec(spec): ClosureSpec {
    return {
      rootSelectors: [spec.jobId, spec.workflowId],
      followedEdges: ['pass-input'],
    };
  },
  preconditions(spec, _closure, state) {
    const job = state.nodes[spec.jobId];
    if (!job) return { ok: false, reason: `jobId "${spec.jobId}" not in DAG.` };
    if (job.type !== 'RenderJob') {
      return {
        ok: false,
        reason: `jobId "${spec.jobId}" is ${job.type}; expected a RenderJob.`,
      };
    }
    const workflow = state.nodes[spec.workflowId];
    if (!workflow) {
      return { ok: false, reason: `workflowId "${spec.workflowId}" not in DAG.` };
    }
    if (workflow.type !== 'ComfyUIWorkflow') {
      return {
        ok: false,
        reason: `workflowId "${spec.workflowId}" is ${workflow.type}; expected a ComfyUIWorkflow.`,
      };
    }
    let foundTime = false;
    for (const node of Object.values(state.nodes)) {
      if (node.type === 'TimeSource') {
        foundTime = true;
        break;
      }
    }
    if (!foundTime) {
      return {
        ok: false,
        reason: 'No TimeSource node in DAG. VideoStitch requires Time wired (V3).',
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const usedIds = new Set<NodeId>(Object.keys(state.nodes));
    const stitchId = spec.stitchId ?? defaultStitchId(spec.jobId, usedIds);

    const job = state.nodes[spec.jobId];
    const jobParams = (job?.params as RenderJobLikeParams | undefined) ?? {};
    const jobOutputPath = (jobParams.outputPath ?? 'renders/job').replace(/\/+$/, '');
    const outputPath = spec.outputPath ?? `${jobOutputPath}/final.mp4`;

    const workflow = state.nodes[spec.workflowId];
    const workflowParams = (workflow?.params as Partial<ComfyUIWorkflowParams> | undefined) ?? {};
    void workflowParams;

    const fps = spec.fps ?? jobParams.fps ?? 30;
    const codec = spec.codec ?? 'h264';

    let timeId: NodeId | null = null;
    for (const node of Object.values(state.nodes)) {
      if (node.type === 'TimeSource') {
        timeId = node.id;
        break;
      }
    }
    if (!timeId) {
      throw new Error('addStitch.build: missing TimeSource — preconditions should have rejected.');
    }

    const ops: Op[] = [];
    ops.push({
      type: 'addNode',
      nodeId: stitchId,
      nodeType: 'VideoStitch',
      params: {
        codec,
        fps,
        outputPath,
      },
    });
    ops.push({
      type: 'connect',
      from: { node: spec.workflowId, socket: 'out' },
      to: { node: stitchId, socket: 'pass-input' },
    });
    ops.push({
      type: 'connect',
      from: { node: timeId, socket: 'out' },
      to: { node: stitchId, socket: 'time' },
    });
    return ops;
  },
};
