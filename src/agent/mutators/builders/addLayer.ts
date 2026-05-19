// addLayer Mutator — wraps a target SceneChild in a new AnimationLayer.
//
// Sequence per target: addNode AnimationLayer, then for every consumer C
// of the target (e.g. scene.children), disconnect (target → C.socket) and
// reconnect (layer → C.socket); finally connect (target → layer.target).
// The layer becomes the new parent of the target in the scene chain.
//
// Closure: rootSelectors = targets; followedEdges = ['parent'] so every
// consumer's id lands in scope and the disconnect/connect ops at the
// consumer side pass the closure-preservation gate (V13).
//
// V14 non-redundancy: addLayer is the only Mutator that creates an
// AnimationLayer — its (requiredEdges:['parent'], requiredNodeTypes:[],
// preserves:['animation']) signature is unique vs the existing 6 starter
// Mutators.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { NodeId, Op } from '../../../core/dag/types';

const AddLayerSpec = z.object({
  targetSelectors: z.array(z.string().min(1)).min(1),
  /** Display name for the layer row in the dopesheet. */
  layerName: z.string().default('Layer'),
  /** Caller-supplied layer ids — must equal targetSelectors length when given. */
  layerIds: z.array(z.string().min(1)).optional(),
});
export type AddLayerSpec = z.infer<typeof AddLayerSpec>;

export const addLayerMutator: MutatorDefinition<AddLayerSpec> = {
  name: 'mutator.timeline.addLayer',
  description:
    'Wrap one or more SceneChild targets (BoxMesh, Transform, Character, …) ' +
    'in a new AnimationLayer. The layer slots between target and its current ' +
    'consumer; the target keeps rendering identically until channels are ' +
    "wired into the layer's animation socket. Caller may supply layerIds to " +
    'make subsequent addChannel calls deterministic without dag.inspect.',
  spec: AddLayerSpec,
  specExample: {
    targetSelectors: ['node_id'],
    layerName: 'Layer',
    layerIds: ['node_id_layer'],
  },
  contract: {
    requiredEdges: ['parent'],
    requiredNodeTypes: [],
    preserves: ['position', 'rotation', 'scale', 'material', 'children'],
  },
  buildClosureSpec(spec): ClosureSpec {
    return {
      rootSelectors: spec.targetSelectors,
      followedEdges: ['parent'],
    };
  },
  preconditions(spec, _closure, state) {
    if (spec.layerIds && spec.layerIds.length !== spec.targetSelectors.length) {
      return {
        ok: false,
        reason: `layerIds length (${spec.layerIds.length}) must equal targetSelectors length (${spec.targetSelectors.length}).`,
      };
    }
    for (const id of spec.targetSelectors) {
      const node = state.nodes[id];
      if (!node) return { ok: false, reason: `Target "${id}" not in DAG.` };
      // Reject if the target is itself an AnimationLayer — wrapping a
      // wrapper is almost always unintended; the user wanted addChannel.
      if (node.type === 'AnimationLayer') {
        return {
          ok: false,
          reason: `Target "${id}" is already an AnimationLayer. Use mutator.timeline.addChannel to add channels to an existing layer.`,
        };
      }
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const ops: Op[] = [];
    const usedIds = new Set<NodeId>(Object.keys(state.nodes));

    for (let i = 0; i < spec.targetSelectors.length; i++) {
      const targetId = spec.targetSelectors[i];
      const layerId = spec.layerIds?.[i] ?? nextLayerId(targetId, usedIds);
      usedIds.add(layerId);

      // 1. Create the layer.
      ops.push({
        type: 'addNode',
        nodeId: layerId,
        nodeType: 'AnimationLayer',
        params: { name: spec.layerName },
      });

      // 2. Rewire each existing consumer of target → layer.
      //    The layer becomes the SceneChild seen by consumers; target
      //    moves to the layer's `target` input.
      for (const consumer of Object.values(state.nodes)) {
        if (consumer.id === layerId) continue;
        for (const [socket, binding] of Object.entries(consumer.inputs)) {
          const refs = Array.isArray(binding) ? binding : [binding];
          for (const ref of refs) {
            if (ref.node !== targetId) continue;
            ops.push({
              type: 'disconnect',
              from: { node: targetId, socket: ref.socket },
              to: { node: consumer.id, socket },
            });
            ops.push({
              type: 'connect',
              from: { node: layerId, socket: 'out' },
              to: { node: consumer.id, socket },
            });
          }
        }
      }

      // 3. Connect target into the layer's `target` input.
      ops.push({
        type: 'connect',
        from: { node: targetId, socket: 'out' },
        to: { node: layerId, socket: 'target' },
      });
    }
    return ops;
  },
};

function nextLayerId(target: string, used: Set<NodeId>): NodeId {
  // `<target>_layer`, then `<target>_layer_1`, `_2`, … if collisions.
  const base = `${target}_layer`;
  if (!used.has(base)) return base;
  let n = 1;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}
