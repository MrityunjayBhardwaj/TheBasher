// bindSkin — bind a mesh to an armature (#1353): the agent's door to the panel's "bind to armature".
//
// Both roads call `planBindSkin` (`src/app/animate/bindSkin.ts`), so what a bind is — a Capture and
// an Armature modifier on the mesh's stack, both pointed at the armature — and every refusal are
// decided once. `addModifier` can add either operator alone but reaches neither one's `armature`
// input; this is the verb that connects them.
//
// REF: src/app/animate/bindSkin.ts (the plan); src/nodes/CaptureModifier.ts;
//      src/agent/mutators/builders/addModifier.ts (the sibling that wires only the spine); issue #1353.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { captureStatusText, planBindSkin } from '../../../app/animate/bindSkin';
import { CAPTURE_METHODS } from '../../../nodes/CaptureModifier';

const BindSkinSpec = z.object({
  /** The mesh to bind: its Object, or any modifier in its stack. */
  mesh: z.string().min(1),
  /** The armature Object whose bones bind it. */
  armature: z.string().min(1),
  /** How distance to a bone is measured (default proximity). */
  method: z.enum(CAPTURE_METHODS).optional(),
  /** The most bones one point is bound to (default 4). */
  maxInfluences: z.number().int().min(1).max(16).optional(),
  /** proximity: how sharply a bone's hold falls with distance: 1 linear, 2 quadratic (default 4). */
  dropoff: z.number().min(0.1).max(100).optional(),
  /** voxel: cubes along the mesh's longest side (default 128). */
  resolution: z.number().int().min(16).max(256).optional(),
  /** voxel: 0 smooth to 1 rigid (default 0.2). */
  falloff: z.number().min(0).max(1).optional(),
});
export type BindSkinSpec = z.infer<typeof BindSkinSpec>;

// A setting left out stays out, and `planBindSkin` gives it the Capture node's own default.
const plan = (spec: BindSkinSpec, state: DagState) => planBindSkin(state, spec);

export const bindSkinMutator: MutatorDefinition<BindSkinSpec> = {
  name: 'mutator.rig.bindSkin',
  // The first sentence is the picker payload: it ends before a capital.
  description:
    'Bind a mesh to an armature so posing its bones bends the mesh. ' +
    'Adds a Capture (skin weights: each point goes to the nearest deforming bones, `maxInfluences` ' +
    'of them) and an Armature modifier on the mesh, both pointed at `armature`. `method` says how ' +
    '"nearest" is measured: "proximity" in a straight line, falling off by `dropoff`; "voxel" ' +
    "through the mesh's own volume on a grid of `resolution`, falling off by `falloff` — use it " +
    'when one part lies beside another (an arm at the side), where proximity gives one part the ' +
    "other's bones; parts nearer than about three grid cubes still join. Bones marked " +
    'deform=false (controls, IK goals) get no weights. Refuses a mesh that is already bound, or ' +
    'one with no stored points (a box or a sphere).',
  spec: BindSkinSpec,
  specExample: { mesh: 'node_id', armature: 'node_id' },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: ['Object'],
    // The mesh's own placement and material are untouched; what it draws now follows the pose.
    preserves: ['position', 'rotation', 'scale', 'material'],
  },
  buildClosureSpec(spec): ClosureSpec {
    // The stack splices in front of the mesh's consumer, as `addModifier` does; the armature is
    // read, and the two new operators hold an edge to it.
    return { rootSelectors: [spec.mesh, spec.armature], followedEdges: ['parent'] };
  },
  preconditions(spec, _closure, state) {
    const result = plan(spec, state);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  },
  build(spec, _closure, state): Op[] {
    const result = plan(spec, state);
    return result.ok ? result.ops : [];
  },
  advisories(spec, _closure, state) {
    const result = plan(spec, state);
    return result.ok ? [captureStatusText(result.capture)] : [];
  },
};
