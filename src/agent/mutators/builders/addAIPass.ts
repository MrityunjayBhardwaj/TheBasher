// addAIPass Mutator — wires a Prompt + ComfyUIWorkflow chain into an
// existing RenderJob, producing stylized output via the named preset.
//
// Single Mutator covers all presets (D-03 locked). presetId discriminates
// at build time; the workflow's outputPath is authored from the
// RenderJob's outputPath + the sanitized presetId per D-04. The Mutator
// REQUIRES that the upstream RenderJob already has every required pass
// of the chosen preset wired (Beauty + Depth + Normal for stylized-
// realism). The agent emits addPass calls first, then addAIPass.
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
import { listPresetIds, getPreset } from '../../strategy/presets/stylizedRealism';
import type { ImagePassKind } from '../../../nodes/types';
import type { MutatorDefinition } from '../types';

/** Sanitize per THREE-reserved-chars rules even though THREE isn't in
 *  this path — defense-in-depth (memory: feedback_three_reserved_chars). */
function sanitizePathSegment(s: string): string {
  return s.replace(/[[\].:/]/g, '_');
}

const presetIds = listPresetIds();
if (presetIds.length === 0) {
  throw new Error(
    'addAIPass: preset registry is empty — at least one preset must register before this Mutator loads.',
  );
}

const PresetIdEnum = z.enum(presetIds as [string, ...string[]]);

const AddAIPassSpec = z.object({
  jobId: z.string().min(1),
  presetId: PresetIdEnum,
  promptText: z.string().min(1),
  promptNegative: z.string().optional(),
  promptTags: z.array(z.string()).optional(),
  /** Optional explicit ids. Auto-derived from jobId + presetId when omitted. */
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

function defaultPromptId(jobId: NodeId, presetId: string, used: Set<NodeId>): NodeId {
  const base = `${jobId}_${sanitizePathSegment(presetId)}_prompt`;
  if (!used.has(base)) return base;
  let n = 1;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

function defaultWorkflowId(jobId: NodeId, presetId: string, used: Set<NodeId>): NodeId {
  const base = `${jobId}_${sanitizePathSegment(presetId)}_workflow`;
  if (!used.has(base)) return base;
  let n = 1;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/**
 * Walk job's pass-input list and return the set of passKinds already
 * wired. Used to verify the preset's required passes are present
 * before we add the workflow.
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
    'existing RenderJob, producing stylized frames via the named preset. ' +
    "The upstream RenderJob must already have the preset's required " +
    'passes wired (call mutator.render.addPass first for each). v0.5 ' +
    'ships one preset (stylizedRealism — Beauty + Depth + Normal → SDXL ' +
    'ControlNet). Output flows over the existing pass-input edge kind ' +
    'with passKind "stylized" — agent disambiguates by source node, not ' +
    'socket type.',
  spec: AddAIPassSpec,
  specExample: {
    jobId: 'job',
    presetId: 'stylizedRealism',
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
    const preset = getPreset(spec.presetId);
    if (!preset) {
      return {
        ok: false,
        reason: `presetId "${spec.presetId}" not registered. Known presets: ${listPresetIds().join(', ')}.`,
      };
    }
    const wired = wiredPassKinds(spec.jobId, state);
    const missing = preset.requiredPasses.filter((k) => !wired.has(k));
    if (missing.length > 0) {
      return {
        ok: false,
        reason:
          `presetId "${spec.presetId}" requires passes [${preset.requiredPasses.join(', ')}] ` +
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
    const promptId = spec.promptId ?? defaultPromptId(spec.jobId, spec.presetId, usedIds);
    usedIds.add(promptId);
    const workflowId = spec.workflowId ?? defaultWorkflowId(spec.jobId, spec.presetId, usedIds);

    // Derive workflow outputPath from the RenderJob's outputPath. RenderJob's
    // outputPath default is 'renders/job'; the workflow's path becomes
    // 'renders/job/stylized_${sanitize(presetId)}'. Both share the
    // ${jobId} prefix so D-04 holds.
    const job = state.nodes[spec.jobId];
    const jobParams = (job?.params as RenderJobLikeParams | undefined) ?? {};
    const jobOutputPath = (jobParams.outputPath ?? 'renders/job').replace(/\/+$/, '');
    const sanitizedPresetId = sanitizePathSegment(spec.presetId);
    const workflowOutputPath = `${jobOutputPath}/stylized_${sanitizedPresetId}`;

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
        presetId: spec.presetId,
        frameStart,
        frameEnd,
        lastGoodFrame: -1,
        outputPath: workflowOutputPath,
      },
    });
    // 3. Wire prompt → workflow.prompt.
    ops.push({
      type: 'connect',
      from: { node: promptId, socket: 'out' },
      to: { node: workflowId, socket: 'prompt' },
    });
    // 4. Wire each required raw pass into workflow.pass-input. Pass
    //    nodes already exist on the job (precondition verified).
    const preset = getPreset(spec.presetId);
    if (!preset) {
      throw new Error(
        `addAIPass.build: preset "${spec.presetId}" disappeared after preconditions — registry mutation race?`,
      );
    }
    const jobBinding = job?.inputs['pass-input'];
    const jobPassRefs =
      jobBinding === undefined ? [] : Array.isArray(jobBinding) ? jobBinding : [jobBinding];
    const kindByType: Record<string, ImagePassKind> = {
      BeautyPass: 'beauty',
      IDPass: 'id',
      DepthPass: 'depth',
      NormalPass: 'normal',
    };
    for (const requiredKind of preset.requiredPasses) {
      const ref = jobPassRefs.find((r) => {
        const passNode = state.nodes[r.node];
        return passNode && kindByType[passNode.type] === requiredKind;
      });
      if (!ref) {
        throw new Error(
          `addAIPass.build: required pass "${requiredKind}" not found on RenderJob "${spec.jobId}" — preconditions should have rejected.`,
        );
      }
      ops.push({
        type: 'connect',
        from: { node: ref.node, socket: 'out' },
        to: { node: workflowId, socket: 'pass-input' },
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
