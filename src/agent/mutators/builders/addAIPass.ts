// addAIPass Mutator — wires a Prompt + ComfyUIWorkflow chain into an
// existing RenderJob, producing stylized output from a workflow file.
//
// #1715: no presets. The node is the generic ComfyUI workflow node holding a
// workflow FILE Basher ships (`BUILTIN_WORKFLOWS`) or one the agent passes,
// and its sockets are that file's Basher markers (`workflowSocketsOf`), the
// same ones the Nodes view draws. The Mutator wires by socket name: each
// image input named after a render pass (beauty, depth, normal, id) reads
// that pass off the job, and a Prompt node feeds the text input `prompt`.
// The workflow's outputPath is authored from the RenderJob's outputPath per
// D-04. The upstream RenderJob must already have every pass the file asks
// for; the agent emits addPass calls first, then addAIPass.
//
// Closure: rootSelectors=[jobId], followedEdges=['pass-input']. The
// existing raw passes hanging off the job sit in scope alongside the
// root; H22 isolation already proven on this kind. The new ComfyUI-
// Workflow node connects back to jobId.'pass-input' so the stylized
// output participates in the same edge kind — D-01 reuse, no new
// EdgeKind.
//
// V14 non-redundancy: addAIPass's contract signature differs from
// addPass on `requiredNodeTypes` (here: ['RenderJob','Prompt'] —
// addPass omits Prompt) and `preserves` ('material' is dropped because
// the AI pass produces stylized pixels, not preserved material data).
// The mechanical guard in mutators.test.ts verifies uniqueness.
//
// REF: project_p5_context D-01 / D-03 / D-04; vyapti V13 / V14;
// hetvabhasa H22.

import { z } from 'zod';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { NodeId, Op } from '../../../core/dag/types';
import { BUILTIN_WORKFLOWS } from '../../../core/comfy/builtinWorkflows';
import { writeBasherControllerValues } from '../../../core/comfy/basherControllers';
import type { ComfyApiJson, ComfyGraphMeta } from '../../../core/comfy/comfyGraph';
import { socketsOfWorkflow, type WorkflowSockets } from '../../../core/comfy/workflowSockets';
import type { ImagePassKind } from '../../../nodes/types';
import type { MutatorDefinition } from '../types';

/** Sanitize per THREE-reserved-chars rules even though THREE isn't in
 *  this path — defense-in-depth (memory: feedback_three_reserved_chars). */
function sanitizePathSegment(s: string): string {
  return s.replace(/[[\].:/]/g, '_');
}

const workflowNames = Object.keys(BUILTIN_WORKFLOWS) as [string, ...string[]];

const AddAIPassSpec = z.object({
  jobId: z.string().min(1),
  /** A workflow file Basher ships, by name. */
  workflow: z.enum(workflowNames),
  promptText: z.string().min(1),
  /** The text input `negative`'s value, when the file has one. */
  promptNegative: z.string().optional(),
  promptTags: z.array(z.string()).optional(),
  /** Optional explicit ids. Auto-derived from jobId + workflow when omitted. */
  promptId: z.string().optional(),
  workflowId: z.string().optional(),
  /** Inclusive frame range. Defaults to RenderJob's [frameStart, frameEnd]. */
  frameStart: z.number().int().nonnegative().optional(),
  frameEnd: z.number().int().nonnegative().optional(),
});
export type AddAIPassSpec = z.infer<typeof AddAIPassSpec>;

interface RenderJobLikeParams {
  outputPath?: string;
  frameStart?: number;
  frameEnd?: number;
}

function defaultPromptId(jobId: NodeId, workflow: string, used: Set<NodeId>): NodeId {
  const base = `${jobId}_${sanitizePathSegment(workflow)}_prompt`;
  if (!used.has(base)) return base;
  let n = 1;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

function defaultWorkflowId(jobId: NodeId, workflow: string, used: Set<NodeId>): NodeId {
  const base = `${jobId}_${sanitizePathSegment(workflow)}_workflow`;
  if (!used.has(base)) return base;
  let n = 1;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

const PASS_KINDS: ReadonlySet<string> = new Set(['beauty', 'id', 'depth', 'normal']);

/** The render passes a workflow file asks for: its image inputs named after one. */
function passInputsOf(sockets: WorkflowSockets): ImagePassKind[] {
  return sockets.inputs
    .filter((i) => (i.type === 'still' || i.type === 'frames') && PASS_KINDS.has(i.socket))
    .map((i) => i.socket as ImagePassKind);
}

/** The file for `name`, with the negative written into its `negative` text input. */
function workflowFileFor(name: string, negative: string | undefined) {
  const builtin = BUILTIN_WORKFLOWS[name]!;
  let apiJson: ComfyApiJson = structuredClone(builtin.apiJson);
  const neg = socketsOfWorkflow(apiJson).inputs.find(
    (i) => i.socket === 'negative' && i.type === 'text',
  );
  if (neg && negative !== undefined) {
    apiJson = writeBasherControllerValues(apiJson, { [neg.nodeId]: [negative] });
  }
  const meta: ComfyGraphMeta = { ...builtin.meta };
  return { apiJson, meta };
}

/**
 * Walk job's pass-input list and return the set of passKinds already
 * wired. Used to verify the file's passes are present before we add
 * the workflow.
 */
function wiredPassKinds(jobId: NodeId, state: DagState): Set<ImagePassKind> {
  const job = state.nodes[jobId];
  const out = new Set<ImagePassKind>();
  if (!job) return out;
  const binding = job.inputs['pass-input'];
  const refs = binding === undefined ? [] : Array.isArray(binding) ? binding : [binding];
  for (const ref of refs) {
    const passNode = state.nodes[ref.node];
    if (!passNode) continue;
    // Map node type → passKind (mirrors NODE_TYPE_BY_KIND in addPass)
    const kindByType: Record<string, ImagePassKind> = {
      BeautyPass: 'beauty',
      IDPass: 'id',
      DepthPass: 'depth',
      NormalPass: 'normal',
    };
    const kind = kindByType[passNode.type];
    if (kind) out.add(kind);
  }
  return out;
}

export const addAIPassMutator: MutatorDefinition<AddAIPassSpec> = {
  name: 'mutator.render.addAIPass',
  description:
    'Wire a stylized AI render pass (Prompt + ComfyUIWorkflow) into an ' +
    'existing RenderJob, producing stylized frames from a workflow file Basher ' +
    'ships. The node is the generic ComfyUI workflow node: its sockets are the ' +
    "file's Basher markers (inspect it to see them). Each image input named after " +
    'a render pass (beauty, depth, normal, id) reads that pass off the job, so the ' +
    'job must have those passes wired first (mutator.render.addPass). Shipped: ' +
    'stylizedRealism (beauty + depth + normal → SDXL ControlNet, img2img on the ' +
    'previous frame). The first output flows back over pass-input with passKind ' +
    '"stylized".',
  spec: AddAIPassSpec,
  specExample: {
    jobId: 'job',
    workflow: 'stylizedRealism',
    promptText: 'cinematic cube, golden hour, 35mm',
    promptNegative: 'lowres, blurry',
  },
  contract: {
    requiredEdges: ['pass-input'],
    // Only RenderJob must pre-exist — Prompt is created by this
    // Mutator, not consumed from the closure.
    requiredNodeTypes: ['RenderJob'],
    preserves: ['position', 'rotation', 'scale', 'children'],
  },
  buildClosureSpec(spec): ClosureSpec {
    return {
      rootSelectors: [spec.jobId],
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
    const builtin = BUILTIN_WORKFLOWS[spec.workflow];
    if (!builtin) {
      return {
        ok: false,
        reason: `workflow "${spec.workflow}" is not one Basher ships. Shipped: ${workflowNames.join(', ')}.`,
      };
    }
    const required = passInputsOf(socketsOfWorkflow(builtin.apiJson));
    const wired = wiredPassKinds(spec.jobId, state);
    const missing = required.filter((k) => !wired.has(k));
    if (missing.length > 0) {
      return {
        ok: false,
        reason:
          `workflow "${spec.workflow}" reads passes [${required.join(', ')}] ` +
          `wired to RenderJob "${spec.jobId}". Missing: [${missing.join(', ')}]. ` +
          'Call mutator.render.addPass for each before retrying.',
      };
    }
    // TimeSource availability — same check addPass enforces. RenderJob
    // requires a Time input; absence means addPass would have rejected
    // earlier. Re-checking here keeps the error surface near the user.
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
        reason:
          'No TimeSource node in DAG. ComfyUIWorkflow needs Time wired (V3). ' +
          'Default projects seed `n_time`; add one via dag.exec if missing.',
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const usedIds = new Set<NodeId>(Object.keys(state.nodes));
    const promptId = spec.promptId ?? defaultPromptId(spec.jobId, spec.workflow, usedIds);
    usedIds.add(promptId);
    const workflowId = spec.workflowId ?? defaultWorkflowId(spec.jobId, spec.workflow, usedIds);
    const graph = workflowFileFor(spec.workflow, spec.promptNegative);
    const sockets = socketsOfWorkflow(graph.apiJson);

    // Derive workflow outputPath from the RenderJob's outputPath. RenderJob's
    // outputPath default is 'renders/job'; the workflow's path becomes
    // 'renders/job/stylized_${sanitize(workflow)}'. Both share the
    // ${jobId} prefix so D-04 holds.
    const job = state.nodes[spec.jobId];
    const jobParams = (job?.params as RenderJobLikeParams | undefined) ?? {};
    const jobOutputPath = (jobParams.outputPath ?? 'renders/job').replace(/\/+$/, '');
    const workflowOutputPath = `${jobOutputPath}/stylized_${sanitizePathSegment(spec.workflow)}`;

    // Default frame range to the RenderJob's range when not explicitly
    // overridden — keeps stylized output aligned with raw passes.
    const frameStart = spec.frameStart ?? jobParams.frameStart ?? 0;
    const frameEnd = spec.frameEnd ?? jobParams.frameEnd ?? 60;

    // Resolve TimeSource (just-passed precondition).
    let timeId: NodeId | null = null;
    for (const node of Object.values(state.nodes)) {
      if (node.type === 'TimeSource') {
        timeId = node.id;
        break;
      }
    }
    if (!timeId) {
      throw new Error('addAIPass.build: missing TimeSource — preconditions should have rejected.');
    }

    const ops: Op[] = [];
    // 1. Prompt node.
    ops.push({
      type: 'addNode',
      nodeId: promptId,
      nodeType: 'Prompt',
      params: {
        text: spec.promptText,
        negative: spec.promptNegative ?? '',
        tags: spec.promptTags ?? [],
      },
    });
    // 2. ComfyUIWorkflow node.
    ops.push({
      type: 'addNode',
      nodeId: workflowId,
      nodeType: 'ComfyUIWorkflow',
      params: {
        graph,
        frameStart,
        frameEnd,
        lastGoodFrame: -1,
        outputPath: workflowOutputPath,
      },
    });
    // 3. Wire prompt → the file's text input `prompt`, when it has one.
    if (sockets.inputs.some((i) => i.socket === 'prompt' && i.type === 'text')) {
      ops.push({
        type: 'connect',
        from: { node: promptId, socket: 'out' },
        to: { node: workflowId, socket: 'prompt' },
      });
    }
    // 4. Wire each pass the file reads into its same-named input. Pass
    //    nodes already exist on the job (precondition verified).
    const jobBinding = job?.inputs['pass-input'];
    const jobPassRefs =
      jobBinding === undefined ? [] : Array.isArray(jobBinding) ? jobBinding : [jobBinding];
    const kindByType: Record<string, ImagePassKind> = {
      BeautyPass: 'beauty',
      IDPass: 'id',
      DepthPass: 'depth',
      NormalPass: 'normal',
    };
    for (const kind of passInputsOf(sockets)) {
      const ref = jobPassRefs.find((r) => {
        const passNode = state.nodes[r.node];
        return passNode && kindByType[passNode.type] === kind;
      });
      if (!ref) {
        throw new Error(
          `addAIPass.build: pass "${kind}" not found on RenderJob "${spec.jobId}" — preconditions should have rejected.`,
        );
      }
      ops.push({
        type: 'connect',
        from: { node: ref.node, socket: 'out' },
        to: { node: workflowId, socket: kind },
      });
    }
    // 5. Wire time → workflow.time.
    ops.push({
      type: 'connect',
      from: { node: timeId, socket: 'out' },
      to: { node: workflowId, socket: 'time' },
    });
    return ops;
  },
};
