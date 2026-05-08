// shotCreate Mutator — adds a Shot node wired to a camera + scene.
//
// Spec: { name, startTime, endTime, cameraId, sceneId, shotId? } —
// caller-supplied shotId keeps subsequent keyframe/connect operations
// referenceable without an intervening dag.inspect round. Defaults to
// `shot_<n>` where n is the next free index.
//
// Closure: cameraId + sceneId roots + 'parent' walk so the connect-into
// any consumer (e.g. a future Sequence node) passes the gate. Today the
// Shot is a leaf — no consumer required.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { NodeId, Op } from '../../../core/dag/types';

const ShotCreateSpec = z.object({
  cameraId: z.string().min(1),
  sceneId: z.string().min(1),
  name: z.string().default('Shot'),
  startTime: z.number().nonnegative().default(0),
  endTime: z.number().nonnegative().default(2),
  shotId: z.string().optional(),
});
export type ShotCreateSpec = z.infer<typeof ShotCreateSpec>;

export const shotCreateMutator: MutatorDefinition<ShotCreateSpec> = {
  name: 'mutator.shot.create',
  description:
    'Create a Shot node tying a time range to a camera + scene. The Shot ' +
    'is the editorial unit P3 ships; sequence multiple Shots with Cuts. ' +
    'Caller may supply shotId to make the new node id deterministic.',
  spec: ShotCreateSpec,
  specExample: {
    cameraId: 'n_camera',
    sceneId: 'n_scene',
    name: 'Opening',
    startTime: 0,
    endTime: 4,
    shotId: 'shot_opening',
  },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: ['PerspectiveCamera', 'Scene'],
    preserves: ['position', 'rotation', 'scale', 'material', 'children', 'animation'],
  },
  buildClosureSpec(spec): ClosureSpec {
    return {
      rootSelectors: [spec.cameraId, spec.sceneId],
      followedEdges: [],
    };
  },
  preconditions(spec, _closure, state) {
    const camera = state.nodes[spec.cameraId];
    if (!camera) return { ok: false, reason: `Camera "${spec.cameraId}" not in DAG.` };
    if (
      camera.type !== 'PerspectiveCamera' &&
      camera.type !== 'OrthographicCamera'
    ) {
      return {
        ok: false,
        reason: `cameraId "${spec.cameraId}" is ${camera.type}; expected a Camera node.`,
      };
    }
    const scene = state.nodes[spec.sceneId];
    if (!scene) return { ok: false, reason: `Scene "${spec.sceneId}" not in DAG.` };
    if (scene.type !== 'Scene') {
      return { ok: false, reason: `sceneId "${spec.sceneId}" is ${scene.type}; expected a Scene node.` };
    }
    if (spec.endTime < spec.startTime) {
      return { ok: false, reason: `endTime (${spec.endTime}) must be >= startTime (${spec.startTime}).` };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const usedIds = new Set<NodeId>(Object.keys(state.nodes));
    const shotId = spec.shotId ?? nextFreshId('shot', usedIds);
    return [
      {
        type: 'addNode',
        nodeId: shotId,
        nodeType: 'Shot',
        params: {
          name: spec.name,
          startTime: spec.startTime,
          endTime: spec.endTime,
        },
      },
      {
        type: 'connect',
        from: { node: spec.cameraId, socket: 'out' },
        to: { node: shotId, socket: 'camera' },
      },
      {
        type: 'connect',
        from: { node: spec.sceneId, socket: 'out' },
        to: { node: shotId, socket: 'scene' },
      },
    ];
  },
};

function nextFreshId(base: string, used: Set<NodeId>): NodeId {
  let n = 1;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}
