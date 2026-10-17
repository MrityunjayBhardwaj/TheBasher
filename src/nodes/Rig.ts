// Rig — rig logic in one sub-network on the pose wire (#1357).
//
//   animation ──→ Rig.pose                       Rig.out ──→ Object.pose
//                   │                               ▲
//                   └→ BodyInputPose ─→ layers … ─→ Rig.body
//
// A character rig is many nodes (IK solves, constraints, corrective layers). The Rig owns them
// as its sub-network: the closure behind `body`, which nothing outside may read
// (`src/core/dag/subnetworks.ts`). Inside, a `BodyInputPose` leaf stands for the pose that
// arrives on the Rig's `pose` input; the Rig's output is what the sub-network makes of it.
//
// ── WHY IT NEEDS NO SEAM ────────────────────────────────────────────────────────────────────────
//
// The Solver cooks its sub-network once per frame, because its value at frame N depends on its own
// output at N−1. A pose does not: a `PosedSkeletonValue` carries `sample(seconds)`, so a layer
// evaluates once per graph change and time is asked of the value afterwards. The Rig is therefore
// an ordinary pure node, and the evaluator resolves its sub-network's input (`evaluator.ts`, "a
// stateless owner"): the leaf evaluates to exactly what the Rig's `pose` input evaluates to, by
// reference, whether it is asked through the Rig or of a node inside on its own. That is why
// wrapping layers in a Rig changes nothing they compute, and why a layer inside one can be
// inspected like any other.
//
// ── WHAT IT DECLARES ────────────────────────────────────────────────────────────────────────────
//
// One named input, `pose`. The pose carries its skeleton, and an IK layer's goal and pole are bones
// of that skeleton (#1343), so the skeleton and the controls arrive on the same wire. A further
// named input is an added socket and an added name; nothing stored changes.
//
// With no `body` wired the Rig hands its pose through, so an empty Rig can sit in a chain.
//
// REF: docs/GRAPH.md §4 rule 2; src/core/dag/evaluator.ts; src/nodes/Solver.ts (the stateful
//      owner this is the stateless sibling of); APEX: rig logic is a graph evaluated as one unit
//      (`kinefx-apexgraphbasics`); issues #1357, #1547, #1548.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { PosedSkeletonValue } from './types';
import { optionsParam } from './paramWidget';
import { bodyInputLock, bodyInputOptions } from './Solver';

const POSE = { type: 'PosedSkeleton', cardinality: 'single' } as const;

/** What the leaf reads when no Rig holds it: a pose of no bones. */
const NO_POSE: PosedSkeletonValue = {
  kind: 'PosedSkeleton',
  skeleton: { kind: 'Skeleton', bones: [] },
  sample: () => [],
};

// The pose twin of `BodyInput` / `BodyInputVec`: a node's output type is fixed per type and
// `connect` checks it, so a pose-carrying leaf is its own type. It has no `slot`: a pose input is
// one pose.
export const BodyInputPoseParams = z.object({
  input: optionsParam(
    z.string().min(1).default('pose'),
    bodyInputOptions,
    undefined,
    'name',
    bodyInputLock,
  ),
});
export type BodyInputPoseParams = z.infer<typeof BodyInputPoseParams>;

export const BodyInputPoseNode: NodeDefinition<BodyInputPoseParams, PosedSkeletonValue> = {
  type: 'BodyInputPose',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: BodyInputPoseParams,
  inputs: {},
  outputs: { out: POSE },
  bodyInputLeaf: true,
  evaluate: () => NO_POSE,
};

export const RigParams = z.object({});
export type RigParams = z.infer<typeof RigParams>;

export const RigNode: NodeDefinition<RigParams, PosedSkeletonValue> = {
  type: 'Rig',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: RigParams,
  inputs: {
    pose: { ...POSE, owns: 'stack' },
    body: { ...POSE, body: true },
  },
  outputs: { out: POSE },
  bodyInputs: { pose: POSE },
  evaluate: (_params, inputs) =>
    (inputs.body as PosedSkeletonValue | undefined) ??
    (inputs.pose as PosedSkeletonValue | undefined) ??
    NO_POSE,
};
