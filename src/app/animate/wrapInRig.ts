// wrapInRig — put pose layers that already exist inside a Rig (#1357).
//
//   before   feed → L_low → … → L_top → consumer.pose
//   after    feed → Rig.pose                       Rig.out → consumer.pose
//                   BodyInputPose → L_low → … → L_top → Rig.body
//
// The layers keep their ids, params and order; only where the lowest reads and where the top goes
// change. The Rig binds its leaf to exactly what arrives on its `pose` input (`evaluator.ts`), so
// the pose the Object draws is the same before and after: this is a regrouping, not an edit.
//
// What can be wrapped is a run of layers next to each other on the Object's own wire. Not the
// chain's base layer: that is the character's motion, which a bind replaces, and a Rig holds logic
// over the motion, not the motion.
//
// ── THE ORDER OF THE OPS ────────────────────────────────────────────────────────────────────────
//
// A node inside a sub-network may feed nothing outside it, and that is checked op by op. So the
// run is cut out of the wire first (the Rig takes its place, with nothing in it), and only then
// closed behind the Rig's `body`. Wired the other way round, the top layer would for one step feed
// both the Rig's body and the consumer outside it, and the op would be refused.
//
// REF: src/nodes/Rig.ts; src/core/dag/subnetworks.ts (the single-owner rule);
//      src/app/animate/poseChain.ts (`poseLayerChain`); issue #1357.

import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import type { GraphNodeLike } from './graphNodes';
import { edgeTarget } from './graphNodes';
import { poseLayerChain, type PoseLayerChain } from './poseChain';

export const WRAP_IN_RIG_LABEL = 'wrap in a Rig';

export interface WrapInRigArgs {
  /** The armature Object whose pose chain holds the layers. */
  readonly object: string;
  /** The layers to wrap: a run next to each other on the Object's wire, in any order. */
  readonly layers: readonly string[];
  /** The ids the Rig and its input leaf take. */
  readonly rigId: string;
  readonly inputId: string;
}

export type WrapInRigResult =
  | { readonly ok: true; readonly ops: readonly Op[]; readonly wrapped: readonly string[] }
  | { readonly ok: false; readonly reason: string };

const asGraph = (state: DagState) =>
  state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;

/** The ids a wrap on `objectId` takes unless told otherwise. */
export function rigIdFor(objectId: string): string {
  return `${objectId}_rig`;
}
export function rigInputIdFor(objectId: string): string {
  return `${objectId}_rig_in`;
}

/** `base`, `base_2`, `base_3` …: the first id no node holds. */
function free(state: DagState, base: string): string {
  if (!state.nodes[base]) return base;
  for (let n = 2; ; n++) if (!state.nodes[`${base}_${n}`]) return `${base}_${n}`;
}
export function freeRigIds(state: DagState, objectId: string): { rigId: string; inputId: string } {
  return { rigId: free(state, rigIdFor(objectId)), inputId: free(state, rigInputIdFor(objectId)) };
}

/**
 * The layers a wrap takes when none are named: on the Object's wire, the highest run of layers
 * (between Rigs already there) that holds an `ik` layer, from the run's top down to its lowest ik
 * layer. That is the solves and everything layered over them, the part of the chain a hand-pose
 * never lands in (`handPoseInsertionOf`). Empty when no ik layer is left on the wire to wrap.
 */
export function rigCandidateLayers(state: DagState, objectId: string): string[] {
  const { hops } = poseLayerChain(asGraph(state), objectId);
  const isIk = (id: string) =>
    (state.nodes[id].params as { mode?: unknown } | undefined)?.mode === 'ik';
  let run: string[] = [];
  let upToIk = 0;
  for (const hop of [...hops, { id: '', kind: 'rig' as const }]) {
    if (hop.kind === 'layer') {
      run.push(hop.id);
      if (isIk(hop.id)) upToIk = run.length;
      continue;
    }
    if (upToIk > 0) return run.slice(0, upToIk);
    run = [];
  }
  return [];
}

/** The run `layers` forms on the chain's hops, top first, or why it is not one. */
function runOf(
  chain: PoseLayerChain,
  args: WrapInRigArgs,
): { ok: true; from: number; to: number } | { ok: false; reason: string } {
  if (args.layers.length === 0) return { ok: false, reason: 'no layers to wrap' };
  const at = args.layers.map((id) => chain.hops.findIndex((h) => h.id === id));
  const stranger = args.layers[at.indexOf(-1)];
  if (stranger !== undefined) {
    return {
      ok: false,
      reason: chain.allLayers.includes(stranger)
        ? `“${stranger}” is already inside a Rig`
        : `“${stranger}” is not a pose layer on “${args.object}”’s wire`,
    };
  }
  const from = Math.min(...at);
  const to = Math.max(...at);
  if (new Set(at).size !== at.length) return { ok: false, reason: 'a layer is named twice' };
  for (let i = from; i <= to; i++) {
    const hop = chain.hops[i];
    if (hop.kind === 'rig') {
      return {
        ok: false,
        reason: `the Rig “${hop.id}” sits between the layers: wrap one side of it`,
      };
    }
    if (!at.includes(i)) {
      return {
        ok: false,
        reason: `“${hop.id}” sits between the layers and is not named: a Rig holds layers next to each other`,
      };
    }
  }
  return { ok: true, from, to };
}

export function wrapInRig(state: DagState, args: WrapInRigArgs): WrapInRigResult {
  const object = state.nodes[args.object];
  if (!object || object.type !== 'Object') {
    return { ok: false, reason: `“${args.object}” is not an Object` };
  }
  for (const id of [args.rigId, args.inputId]) {
    if (state.nodes[id]) return { ok: false, reason: `“${id}” is taken` };
  }
  if (args.rigId === args.inputId)
    return { ok: false, reason: 'the Rig and its input need two ids' };
  const chain = poseLayerChain(asGraph(state), args.object);
  const run = runOf(chain, args);
  if (!run.ok) return run;
  const wrapped = chain.hops.slice(run.from, run.to + 1).map((h) => h.id);
  if (chain.base !== null && wrapped.includes(chain.base)) {
    return {
      ok: false,
      reason:
        `“${chain.base}” is “${args.object}”’s base layer, its own motion, which a bind replaces: ` +
        'a Rig holds the layers over the motion',
    };
  }
  const top = wrapped[0];
  const low = wrapped[wrapped.length - 1];
  const consumer = run.from > 0 ? chain.hops[run.from - 1].id : args.object;
  const feed = state.nodes[low].inputs?.pose as { node: string; socket: string } | undefined;
  if (!feed || Array.isArray(feed) || !edgeTarget(asGraph(state)[low], 'pose')) {
    return { ok: false, reason: `nothing feeds “${low}”, so the Rig would have no pose to read` };
  }
  const ops: Op[] = [
    { type: 'addNode', nodeId: args.inputId, nodeType: 'BodyInputPose', params: { input: 'pose' } },
    { type: 'addNode', nodeId: args.rigId, nodeType: 'Rig', params: {} },
    {
      type: 'connect',
      from: { node: feed.node, socket: feed.socket },
      to: { node: args.rigId, socket: 'pose' },
    },
    // The Rig takes the run's place on the wire; the run now feeds nothing.
    {
      type: 'connect',
      from: { node: args.rigId, socket: 'out' },
      to: { node: consumer, socket: 'pose' },
      replace: true,
    },
    {
      type: 'connect',
      from: { node: args.inputId, socket: 'out' },
      to: { node: low, socket: 'pose' },
      replace: true,
    },
    {
      type: 'connect',
      from: { node: top, socket: 'out' },
      to: { node: args.rigId, socket: 'body' },
    },
  ];
  return { ok: true, ops, wrapped };
}
