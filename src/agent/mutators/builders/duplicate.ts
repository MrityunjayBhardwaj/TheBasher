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
// Not a drop-in — the delegate is single-root and offset-free, so `build`
// reconciles four things the shared builder doesn't do itself:
//   1. offset       — the shared builder copies position verbatim; the agent
//                     applies `spec.offset` (default [1,0,0]) via a post-hoc
//                     setParam on the returned newRootId.
//   2. multi-target — the mutator takes targetSelectors[]; the builder is
//                     single-root and mints fresh _copy ids from state.nodes
//                     alone, so two targets could collide. A shared `reserved`
//                     id-space is threaded across the calls.
//   3. closure      — the delegated ops touch the edge-less sidecars, so the
//                     closure follows ['parent','children','data','id-ref'] (the
//                     deleteNode set) or gate 3 rejects this mutator's own ops.
//   4. contract     — animation channels are now deep-cloned, so `animation`
//                     moves from lossy to preserves.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op, NodeId } from '../../../core/dag/types';
import { buildDuplicateNodeOps } from '../../../app/sceneNodeActions';

const DuplicateSpec = z.object({
  targetSelectors: z.array(z.string().min(1)).min(1),
  /** Optional offset added to the duplicate's position. Default: [1, 0, 0]. */
  offset: z.tuple([z.number(), z.number(), z.number()]).default([1, 0, 0]),
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
    'aim target, a followed curve, a reusable Action) stay shared. Position is ' +
    'offset by `offset` (default [1,0,0]).',
  spec: DuplicateSpec,
  specExample: { targetSelectors: ['node_id'], offset: [1, 0, 0] },
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
    const ops: Op[] = [];
    // One id-space shared across every target so back-to-back clones of the same
    // base can't mint colliding _copy ids (#437 reconcile #2).
    const reserved = new Set<NodeId>();

    for (const sourceId of spec.targetSelectors) {
      const res = buildDuplicateNodeOps(state, sourceId, reserved);
      // null == the target is not a wired scene child (nothing to duplicate as a
      // sibling). The outliner and Duplicate key no-op here too; the agent matches
      // rather than forking its own answer.
      if (!res) continue;
      ops.push(...res.ops);

      // #437 reconcile #1 — offset. The shared builder copies position verbatim;
      // the agent nudges the clone by `spec.offset` so it's visibly distinct.
      // Only when the source actually carries a 3-vector position (a data-only or
      // positionless node has none — setParam of an absent field is silently
      // dropped, so guard rather than emit a dead op).
      const sourcePos = (state.nodes[sourceId]?.params as { position?: unknown }).position;
      if (Array.isArray(sourcePos) && sourcePos.length === 3) {
        ops.push({
          type: 'setParam',
          nodeId: res.newRootId,
          paramPath: 'position',
          value: [
            (sourcePos[0] as number) + spec.offset[0],
            (sourcePos[1] as number) + spec.offset[1],
            (sourcePos[2] as number) + spec.offset[2],
          ],
        });
      }
    }
    return ops;
  },
};
