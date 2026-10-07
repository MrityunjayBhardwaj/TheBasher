// wrapInRig — put a character's solves and the layers over them inside a Rig (#1357).
//
// The agent's door to the one wrap (`src/app/animate/wrapInRig.ts`): a run of pose layers on an
// armature Object's wire moves behind a Rig node's `body`, reading the Rig's pose through a leaf.
// The drawn pose does not change. Houdini APEX: rig logic is a graph of its own, evaluated as a
// unit (`kinefx-apexgraphbasics`).
//
// Scope: the Object, its pose chain (`pose`) and the two fresh ids.
//
// REF: src/app/animate/wrapInRig.ts; src/nodes/Rig.ts; issue #1357.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import {
  rigCandidateLayers,
  rigIdFor,
  rigInputIdFor,
  wrapInRig,
  type WrapInRigArgs,
} from '../../../app/animate/wrapInRig';

const WrapInRigSpec = z.object({
  /** The armature Object whose pose chain holds the layers. */
  object: z.string().min(1),
  /** The pose layers to wrap, next to each other on its wire. Absent: its ik layers and every layer over them. */
  layers: z.array(z.string().min(1)).min(1).optional(),
  /** The Rig's id; defaults to `<object>_rig`. */
  rigId: z.string().min(1).optional(),
  /** The id of the Rig's input leaf; defaults to `<object>_rig_in`. */
  inputId: z.string().min(1).optional(),
});
export type WrapInRigSpec = z.infer<typeof WrapInRigSpec>;

function argsOf(spec: WrapInRigSpec, state: DagState): WrapInRigArgs {
  return {
    object: spec.object,
    layers: spec.layers ?? rigCandidateLayers(state, spec.object),
    rigId: spec.rigId ?? rigIdFor(spec.object),
    inputId: spec.inputId ?? rigInputIdFor(spec.object),
  };
}

export const wrapInRigMutator: MutatorDefinition<WrapInRigSpec> = {
  name: 'mutator.animate.wrapInRig',
  // The first sentence is the picker payload, so it ends before a CAPITAL (see `poseBone`).
  description:
    'Move pose layers of an armature Object inside one Rig node, pose unchanged. ' +
    "The layers become the Rig's sub-network. Name `layers` next to each other on its wire, or " +
    'leave them out for its ik layers and every layer over them. ' +
    "Never the base layer (the character's own motion).",
  spec: WrapInRigSpec,
  specExample: { object: 'node_id' },
  contract: {
    requiredEdges: [],
    // A wrap regroups pose layers that exist; with none on the wire there is nothing to wrap.
    requiredNodeTypes: ['PoseLayer'],
    preserves: ['position', 'rotation', 'scale', 'material', 'children', 'animation'],
  },
  buildClosureSpec(spec): ClosureSpec {
    return {
      rootSelectors: [
        spec.object,
        spec.rigId ?? rigIdFor(spec.object),
        spec.inputId ?? rigInputIdFor(spec.object),
      ],
      followedEdges: ['pose'],
    };
  },
  preconditions(spec, _closure, state) {
    const result = wrapInRig(state, argsOf(spec, state));
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  },
  build(spec, _closure, state): Op[] {
    const result = wrapInRig(state, argsOf(spec, state));
    return result.ok ? [...result.ops] : [];
  },
  advisories(spec, _closure, state) {
    const result = wrapInRig(state, argsOf(spec, state));
    return result.ok ? [`inside the Rig: ${result.wrapped.join(', ')}`] : [];
  },
};
