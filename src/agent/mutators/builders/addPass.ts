// addPass Mutator — wires a new pass node into an existing RenderJob's
// 'pass-input' list socket.
//
// Single Mutator covers all pass kinds (P4 D-02 locked). passKind picks
// the concrete node type at build time. Symmetric with
// `mutator.timeline.addChannel` (which discriminates KeyframeChannel<T>).
//
// Closure: rootSelectors = [jobId]; followedEdges = ['pass-input'] so the
// existing passes hanging off the job sit in scope alongside the root.
// This honors V13 (the new connect targets jobId.'pass-input' which is
// the root) and respects H22 — per-kind BFS keeps sibling jobs out.
//
// Auto-wires Scene + Camera + Time: the build step finds the unique
// (Scene, Camera, TimeSource) trio in the dag and connects them into the
// pass node. If multiple Scenes / Cameras exist, the user must pre-pick
// via spec.sceneId / spec.cameraId. TimeSource is the project singleton
// (PR #40 lock-in), so it's always discoverable.
//
// V14 non-redundancy: addPass's signature
// (requiredEdges:['pass-input'], requiredNodeTypes:['RenderJob'],
// preserves:['position', 'rotation', 'scale', 'material', 'children'])
// is unique vs the existing 11 starter Mutators.
//
// REF: THESIS §43, project_p4_prompt locked decisions, vyapti V13 / V14.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { NodeId, Op } from '../../../core/dag/types';

const PassKind = z.enum(['beauty', 'id', 'depth', 'normal']);
type PassKind = z.infer<typeof PassKind>;

const AddPassSpec = z.object({
  jobId: z.string().min(1),
  passKind: PassKind,
  /** Optional explicit ids — when omitted, the resolver picks the unique node of each type. */
  sceneId: z.string().optional(),
  cameraId: z.string().optional(),
  /** Caller-supplied pass id; auto-derived from jobId + passKind when omitted. */
  passId: z.string().optional(),
  /** Optional descriptor override; defaults to 1280x720 inherited from the pass node schema. */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type AddPassSpec = z.infer<typeof AddPassSpec>;

const NODE_TYPE_BY_KIND: Record<PassKind, string> = {
  beauty: 'BeautyPass',
  id: 'IDPass',
  depth: 'DepthPass',
  normal: 'NormalPass',
};

function findUnique(state: DagState, type: string): NodeId | null {
  let found: NodeId | null = null;
  for (const node of Object.values(state.nodes)) {
    if (node.type !== type) continue;
    if (found !== null) return null; // ambiguous — caller must pre-pick.
    found = node.id;
  }
  return found;
}

function defaultPassId(jobId: NodeId, passKind: PassKind, used: Set<NodeId>): NodeId {
  const base = `${jobId}_${passKind}`;
  if (!used.has(base)) return base;
  let n = 1;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

export const addPassMutator: MutatorDefinition<AddPassSpec> = {
  name: 'mutator.render.addPass',
  description:
    'Add a render pass node (BeautyPass / IDPass / DepthPass / NormalPass) ' +
    "and wire it into the named RenderJob's pass-input list. The Mutator " +
    "auto-resolves the project's Scene + Camera + TimeSource and connects " +
    'all three into the new pass; pass sourceHash flips per frame as Time ' +
    'advances. Depth + Normal land in P5 to feed ControlNet inputs for ' +
    'stylized AI rendering. If multiple Scenes or Cameras exist, pass ' +
    'sceneId / cameraId explicitly. Returns deterministic passId so the ' +
    'agent can describe the pass with agent.render.summarizePass.',
  spec: AddPassSpec,
  specExample: {
    jobId: 'job',
    passKind: 'beauty',
    passId: 'job_beauty',
  },
  contract: {
    requiredEdges: ['pass-input'],
    requiredNodeTypes: ['RenderJob'],
    preserves: ['position', 'rotation', 'scale', 'material', 'children'],
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
    if (spec.sceneId !== undefined && state.nodes[spec.sceneId] === undefined) {
      return { ok: false, reason: `sceneId "${spec.sceneId}" not in DAG.` };
    }
    if (spec.cameraId !== undefined && state.nodes[spec.cameraId] === undefined) {
      return { ok: false, reason: `cameraId "${spec.cameraId}" not in DAG.` };
    }
    const sceneId = spec.sceneId ?? findUnique(state, 'Scene');
    if (!sceneId) {
      return {
        ok: false,
        reason:
          'Could not resolve a unique Scene node. Pass sceneId explicitly when the project has multiple Scenes (or none).',
      };
    }
    const cameraId =
      spec.cameraId ??
      findUnique(state, 'PerspectiveCamera') ??
      findUnique(state, 'OrthographicCamera');
    if (!cameraId) {
      return {
        ok: false,
        reason:
          'Could not resolve a unique Camera node. Pass cameraId explicitly when the project has multiple Cameras (or none).',
      };
    }
    if (!findUnique(state, 'TimeSource')) {
      return {
        ok: false,
        reason:
          'No TimeSource node in DAG. Default projects seed `n_time`; this project has been mutated to remove it. ' +
          'Add one via `dag.exec` (`addNode` with nodeType "TimeSource") before re-trying.',
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const usedIds = new Set<NodeId>(Object.keys(state.nodes));
    const passId = spec.passId ?? defaultPassId(spec.jobId, spec.passKind, usedIds);
    const sceneId = spec.sceneId ?? findUnique(state, 'Scene');
    const cameraId =
      spec.cameraId ??
      findUnique(state, 'PerspectiveCamera') ??
      findUnique(state, 'OrthographicCamera');
    const timeId = findUnique(state, 'TimeSource');
    if (!sceneId || !cameraId || !timeId) {
      throw new Error(
        'addPass.build: missing Scene / Camera / TimeSource — preconditions should have rejected.',
      );
    }

    const params: Record<string, number> = {};
    if (spec.width !== undefined) params.width = spec.width;
    if (spec.height !== undefined) params.height = spec.height;

    const ops: Op[] = [];
    ops.push({
      type: 'addNode',
      nodeId: passId,
      nodeType: NODE_TYPE_BY_KIND[spec.passKind],
      params,
    });
    ops.push({
      type: 'connect',
      from: { node: sceneId, socket: 'out' },
      to: { node: passId, socket: 'scene' },
    });
    ops.push({
      type: 'connect',
      from: { node: cameraId, socket: 'out' },
      to: { node: passId, socket: 'camera' },
    });
    ops.push({
      type: 'connect',
      from: { node: timeId, socket: 'out' },
      to: { node: passId, socket: 'time' },
    });
    ops.push({
      type: 'connect',
      from: { node: passId, socket: 'out' },
      to: { node: spec.jobId, socket: 'pass-input' },
    });
    return ops;
  },
};
