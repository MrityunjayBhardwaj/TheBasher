// duplicate Mutator — clone a target into the same scene aggregator.
//
// Multi-root closure (P-2 mitigation): the source node + its consumer
// chain (so the gate accepts a connect to scene). The new node id is
// fresh and propagates to subsequent ops via the introducedIds tracker
// in validate.ts gate 3.
//
// Preserves: rotation + scale + material (clones params verbatim).
// Lossy: pose/animation references are NOT deep-cloned — the dup will
// share the source's animation channels (acceptable for v0.5; Wave D
// can revisit when KeyframeChannel lands in P3).
//
// #365 Phase 5a (object↔data split) — a split Object owns only its TRS and
// points at a data node (BoxData: geometry + material) through its `data`
// input. Cloning ONLY the Object leaves the clone's `data` unwired → the
// dup renders as an empty. So a clone whose source carries a `data` input
// deep-copies that data node too (fresh id, deep-copied params) and wires
// clone.data → the new data node. This is Blender's Shift+D: the two cubes
// are fully independent — recolour one, the other stands (NOT a shared
// fan-out). Only the `data`-owned node is deep-copied; any other refs the
// source carries follow the existing (shallow) wiring below.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op, NodeId, NodeRef } from '../../../core/dag/types';

const DuplicateSpec = z.object({
  targetSelectors: z.array(z.string().min(1)).min(1),
  /** Optional offset added to the duplicate's position. Default: [1, 0, 0]. */
  offset: z.tuple([z.number(), z.number(), z.number()]).default([1, 0, 0]),
});
export type DuplicateSpec = z.infer<typeof DuplicateSpec>;

export const duplicateMutator: MutatorDefinition<DuplicateSpec> = {
  name: 'mutator.duplicate',
  description:
    'Duplicate one or more nodes. Each clone gets a fresh id and is wired ' +
    'into the same consumer (typically scene.children) as its source. ' +
    'Position is offset by `offset` (default [1,0,0]). Preserves rotation, ' +
    'scale, material; a split Object also gets an independent deep copy of ' +
    'its linked data node (geometry + material); does NOT deep-clone ' +
    'animation channels.',
  spec: DuplicateSpec,
  specExample: { targetSelectors: ['node_id'], offset: [1, 0, 0] },
  contract: {
    requiredEdges: ['parent'],
    requiredNodeTypes: [],
    preserves: ['rotation', 'scale', 'material'],
    lossy: [
      {
        kind: 'animation',
        reason: 'Animation channels are shared with the source, not deep-cloned.',
      },
    ],
  },
  buildClosureSpec(spec): ClosureSpec {
    // Source + its consumer chain. We need consumers in scope so the
    // connect ops to wire the clone into scene.children pass gate 3.
    return {
      rootSelectors: spec.targetSelectors,
      followedEdges: ['parent'],
    };
  },
  preconditions(spec, _closure, state) {
    for (const id of spec.targetSelectors) {
      const node = state.nodes[id];
      if (!node) return { ok: false, reason: `Target "${id}" not in DAG.` };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const ops: Op[] = [];
    const usedIds = new Set<NodeId>(Object.keys(state.nodes));

    for (const sourceId of spec.targetSelectors) {
      const source = state.nodes[sourceId];
      const cloneId = nextFreshId(sourceId, usedIds);
      usedIds.add(cloneId);

      // Clone params with optional position offset.
      const sourceParams = (source.params ?? {}) as Record<string, unknown>;
      const clonedParams = JSON.parse(JSON.stringify(sourceParams)) as Record<string, unknown>;
      const sourcePos = sourceParams.position;
      if (Array.isArray(sourcePos) && sourcePos.length === 3) {
        clonedParams.position = [
          (sourcePos[0] as number) + spec.offset[0],
          (sourcePos[1] as number) + spec.offset[1],
          (sourcePos[2] as number) + spec.offset[2],
        ];
      }

      ops.push({
        type: 'addNode',
        nodeId: cloneId,
        nodeType: source.type,
        params: clonedParams,
      });

      // #365 Phase 5a — deep-copy the linked data node (Blender Shift+D). A split
      // Object's geometry + material live on the node it points at via `data`;
      // cloning only the Object leaves the clone's `data` unwired → it renders as
      // an empty. Emit a fresh data node (deep-copied params) and wire it to the
      // clone's `data` socket, BEFORE that connect so the op layer's from-node
      // check (applyConnect) sees it exist. The two objects are now independent.
      const dataRef = firstRef(source.inputs?.data);
      if (dataRef) {
        const dataNode = state.nodes[dataRef.node];
        if (dataNode) {
          const dataCloneId = nextFreshId(dataRef.node, usedIds);
          usedIds.add(dataCloneId);
          const dataParams = JSON.parse(JSON.stringify(dataNode.params ?? {})) as Record<
            string,
            unknown
          >;
          ops.push({
            type: 'addNode',
            nodeId: dataCloneId,
            nodeType: dataNode.type,
            params: dataParams,
          });
          ops.push({
            type: 'connect',
            from: { node: dataCloneId, socket: dataRef.socket },
            to: { node: cloneId, socket: 'data' },
          });
        }
      }

      // Wire the clone into every consumer the source already feeds.
      // Closure (parent edge) ensures every such consumer is in scope —
      // gate 3 accepts these connect ops.
      for (const consumer of Object.values(state.nodes)) {
        for (const [socket, binding] of Object.entries(consumer.inputs)) {
          const refs = Array.isArray(binding) ? binding : [binding];
          for (const ref of refs) {
            if (ref.node !== sourceId) continue;
            ops.push({
              type: 'connect',
              from: { node: cloneId, socket: ref.socket },
              to: { node: consumer.id, socket },
            });
          }
        }
      }
    }
    return ops;
  },
};

/** The first NodeRef of an input binding (single ref or array), or undefined. */
function firstRef(binding: NodeRef | NodeRef[] | undefined): NodeRef | undefined {
  if (!binding) return undefined;
  return Array.isArray(binding) ? binding[0] : binding;
}

function nextFreshId(base: NodeId, used: Set<NodeId>): NodeId {
  let n = 1;
  // Strip any prior `_copyN` suffix so chained dups don't pile suffixes.
  const root = base.replace(/_copy\d+$/, '');
  while (used.has(`${root}_copy${n}`)) n++;
  return `${root}_copy${n}`;
}
