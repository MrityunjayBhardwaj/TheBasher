// duplicate Mutator — clone a target into the same scene aggregator.
//
// #437 — DELEGATE to the one shared authority (`buildDuplicateNodeOps`) instead
// of reimplementing, exactly as `deleteNodeMutator` now delegates to
// `buildDeleteNodesOps` (#424). This builder used to be a SECOND, independent
// answer to "duplicate a node", and the more broken of the two: it cloned only
// the single target (a duplicated Group came out with no children wired), shared
// its animation channels outright (`lossy: animation` — the clone's keyframes
// moved the ORIGINAL), and ignored constraints, drivers, and NLA strips entirely.
// #433/#434 had already taught the outliner path to clone the whole id-reference
// universe (channels, Track-To / Follow-Path constraints, param drivers, strips);
// leaving the agent on the old channels-blind walker just re-opened the #424
// two-authorities divergence in the duplicate direction. Now three callers
// (outliner, Duplicate key, agent) share one implementation.
//
// What `build` adds to the shared builder (#1561 made it multi-root, deep or linked):
//   1. offset       — the shared builder copies position verbatim; the agent applies
//                     `spec.offset` (default [1,0,0]) to each copied root.
//   2. twice        — a target named twice is asked for two copies, so the targets still
//                     owed one are copied in a further pass, ids and names held back.
//   3. closure      — the delegated ops touch the edge-less sidecars, so the closure follows
//                     ['parent','children','data','id-ref'] or gate 3 rejects this mutator's
//                     own ops. Every other op lands on a node the plan itself adds.
//   4. contract     — animation channels are deep-cloned, so `animation` is preserved.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op, NodeId } from '../../../core/dag/types';
import { buildDuplicateNodesOps } from '../../../app/sceneNodeActions';

const DuplicateSpec = z.object({
  targetSelectors: z.array(z.string().min(1)).min(1),
  /** Optional offset added to the duplicate's position. Default: [1, 0, 0]. */
  offset: z.tuple([z.number(), z.number(), z.number()]).default([1, 0, 0]),
  /** #1561 — Blender's Alt+D: the copy shares its original's data (mesh and modifiers, pose,
   *  driver sources) and gets its own transform and animation. Absent or false: Shift+D. */
  linked: z.boolean().optional(),
});
export type DuplicateSpec = z.infer<typeof DuplicateSpec>;

export const duplicateMutator: MutatorDefinition<DuplicateSpec> = {
  name: 'mutator.duplicate',
  description:
    'Duplicate one or more nodes (Blender Shift+D). Each clone gets a fresh id ' +
    'and is wired in as a sibling right after its source. Deep-copies the owned ' +
    'subtree (a Group takes its children, a split Object its geometry/material ' +
    'data node) AND the animation that belongs to the source — keyframe ' +
    'channels, constraints, drivers, and NLA strips are cloned and re-pointed at ' +
    'the clone, so editing the copy never moves the original. Shared assets (an ' +
    'aim target, a followed curve, a reusable Action, a Material) stay shared. ' +
    'All targets are copied in one step, so a constraint between two of them ' +
    'points at the copies. `linked: true` is Alt+D: the copy shares its ' +
    "original's data (edit the mesh or a modifier and both change) and keeps its " +
    'own transform and animation. Position is offset by `offset` (default [1,0,0]).',
  spec: DuplicateSpec,
  specExample: { targetSelectors: ['node_id'], offset: [1, 0, 0], linked: false },
  contract: {
    requiredEdges: ['parent'],
    requiredNodeTypes: [],
    // #437 — animation is now deep-cloned (moved out of lossy). rotation/scale/
    // material ride along in the verbatim param copy as before.
    preserves: ['rotation', 'scale', 'material', 'animation'],
    lossy: [],
  },
  buildClosureSpec(spec): ClosureSpec {
    // #437 — the delegated ops clone the whole id-reference universe, so the
    // closure must reach it the same way deleteNode's does:
    //   'parent'   — the consumer we clone the new root beside.
    //   'children' — a Group OWNS its children and they clone with it.
    //   'data'     — a split Object OWNS its data node.
    //   'id-ref'   — the edge-less half: channels/constraints/drivers/strips
    //                swept with their subject, plus the Track a cloned strip is
    //                appended to. No edge kind reaches these, so without it gate 3
    //                rejects this mutator's OWN ops (the #424 lesson).
    return {
      rootSelectors: spec.targetSelectors,
      followedEdges: ['parent', 'children', 'data', 'id-ref'],
    };
  },
  preconditions(spec, _closure, state) {
    for (const id of spec.targetSelectors) {
      if (!state.nodes[id]) return { ok: false, reason: `Target "${id}" not in DAG.` };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    // #1561 — ONE call for every target, so the copies share one id map: a reference between
    // two targets lands on the copies, and no two copies can mint the same id. It was one call
    // per target with a shared id-space, which kept the ids apart and nothing else.
    //
    // A target named TWICE is asked for two copies (#437). Each further pass copies the targets
    // still owed one, against the same state, with the ids and names already minted held back.
    const reserved = new Set<NodeId>();
    const reservedNames = new Set<string>();
    const ops: Op[] = [];
    const newRootIds: NodeId[] = [];
    const owed = [...spec.targetSelectors];
    while (owed.length > 0) {
      const pass = [...new Set(owed)];
      for (const id of pass) owed.splice(owed.indexOf(id), 1);
      const res = buildDuplicateNodesOps(state, pass, {
        linked: spec.linked === true,
        reserved,
        reservedNames,
      });
      // null == no target in this pass is a wired scene child (nothing to duplicate as a
      // sibling). The outliner and the Duplicate keys no-op here too; the agent matches them.
      if (!res) continue;
      ops.push(...res.ops);
      newRootIds.push(...res.newRootIds);
    }

    // #437 reconcile #1 — offset. The shared builder copies position verbatim; the agent
    // nudges each copied root by `spec.offset` so it's visibly distinct. Only when the source
    // carries a 3-vector position (setParam of an absent field is silently dropped, so guard
    // rather than emit a dead op). A target copied as part of another target's subtree is not
    // a root and moves with its parent.
    for (const newRootId of newRootIds) {
      const added = ops.find((op) => op.type === 'addNode' && op.nodeId === newRootId);
      const position = (added as { params?: { position?: unknown } } | undefined)?.params?.position;
      if (Array.isArray(position) && position.length === 3) {
        ops.push({
          type: 'setParam',
          nodeId: newRootId,
          paramPath: 'position',
          value: [
            (position[0] as number) + spec.offset[0],
            (position[1] as number) + spec.offset[1],
            (position[2] as number) + spec.offset[2],
          ],
        });
      }
    }
    return ops;
  },
};
