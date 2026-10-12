// The pose layers under an armature Object — ONE walk, shared (#1156).
//
// It lived inside the poseBone mutator, which was right while the mutator was the only
// road into the pose lane. It is not any more: the inspector now offers the same gesture
// to a director, and the two must agree about which layers already exist for a bone.
// Two spellings of this walk would be two answers to one question — the shape that cost
// #1088 and #1141, where a bind's hide and a path placement each grew their own answer
// and drifted apart.
//
// The file began as the walk over the clone road's `PoseOverride` chain off a `RetargetClip`
// (#993). That walk's last caller was the load converter; both went in #1424.
//
// REF: src/agent/mutators/builders/poseBone.ts (the mutator that appends to the tip);
//      src/app/animate/poseTargetForBone.ts (the inspector's lookup); issues #993, #1156.

import { edgeTarget, type GraphNodeLike } from './graphNodes';
import type { PoseLayerParams } from '../../nodes/PoseLayer';
import { bodyInputChoicesOf, subnetworkOf } from '../../core/dag/subnetworks';
import type { DagState } from '../../core/dag/state';

/**
 * #1357 — the node types the chain walk passes THROUGH, and how each reads on the way: a pose
 * layer, or a Rig (the pose on its `pose` input, changed by its sub-network). Both read the pose
 * below them on a socket named `pose`. Every other node with a pose output is where a chain
 * starts. `poseChain.test.ts` checks the registry against these two lists, so a new node that
 * takes a pose and gives one is named here or there before it ships.
 */
export const POSE_CHAIN_HOPS = { PoseLayer: 'layer', Rig: 'rig' } as const;
/** Takes a pose and gives one, and is still where a chain STARTS: what it gives is another rig's. */
export const POSE_CHAIN_SOURCES_WITH_A_POSE_INPUT = ['RetargetClip'] as const;

export type PoseHopKind = (typeof POSE_CHAIN_HOPS)[keyof typeof POSE_CHAIN_HOPS];
/** One node the chain passes through. */
export interface PoseHop {
  readonly id: string;
  readonly kind: PoseHopKind;
}

/** The pose layers under an armature Object, and the source they edit. */
export interface PoseLayerChain {
  /**
   * `PoseLayer` ids on the Object's own wire, from the Object down: `[0]` is the top one, the last
   * the lowest. A Rig on the wire is passed through, so layers above and below it are both here;
   * the layers INSIDE a Rig are not (`allLayers`).
   */
  readonly layers: readonly string[];
  /** #1357 — every node the wire passes through, layers and Rigs, from the Object down. */
  readonly hops: readonly PoseHop[];
  /** #1357 — the node whose `pose` input reads the source: the lowest hop, or the Object. */
  readonly bottom: string;
  /**
   * #1357 — every pose layer that can hold a bone name or a key for this Object: `layers`, with
   * each Rig replaced, in place, by the layers inside its sub-network.
   */
  readonly allLayers: readonly string[];
  /** Where the bottom of the chain reads its pose — a clip's `pose`, a retarget's `posed`, a
   *  skeleton's rest `pose` — or null when nothing feeds it. */
  readonly source: { readonly node: string; readonly socket: string } | null;
  /**
   * #1211 — the chain's BASE layer, or null: its bottom layer, when it is an override layer reading a
   * skeleton's rest pose (`Skeleton.pose`). That is where an imported file's motion lives as keys, the
   * counterpart of the action on a Blender armature. A bind replaces it (mutes it, as Blender swaps
   * the action); a hand-pose never writes into it, so a hand-pose survives a rebind (#1244).
   */
  readonly base: string | null;
}

/**
 * #1244 — the layer chain under an armature Object: ONE walk, for every writer of the native pose
 * lane (the bind, which rewires the chain's bottom, and the pose writers, which edit its top).
 *
 * Walked PRODUCER-side from the Object's `pose` input, one hop at a time, while the producer is a
 * `PoseLayer` or a `Rig` (#1357, passed through on its `pose` input); the first producer that is
 * neither is the source. Unlike the clone road's override
 * chain there is no fork to guard: every hop reads a single-cardinality input. Bounded by the node
 * count so a malformed graph cannot spin.
 */
export function poseLayerChain(
  nodes: Readonly<Record<string, GraphNodeLike>>,
  objectId: string,
): PoseLayerChain {
  const hops: PoseHop[] = [];
  const seen = new Set<string>();
  const done = (source: PoseLayerChain['source']): PoseLayerChain => {
    const layers = hops.filter((h) => h.kind === 'layer').map((h) => h.id);
    return {
      layers,
      hops,
      bottom: hops[hops.length - 1]?.id ?? objectId,
      allLayers: hops.flatMap((h) => (h.kind === 'layer' ? [h.id] : layersInsideRig(nodes, h.id))),
      source,
      base: source ? baseOf(nodes, hops, source) : null,
    };
  };
  let at = nodes[objectId];
  const limit = Object.keys(nodes).length;
  for (let n = 0; at && n <= limit; n++) {
    const binding = at.inputs?.pose as { node?: string; socket?: string } | undefined;
    const producer = binding?.node;
    if (typeof producer !== 'string' || !nodes[producer]) return done(null);
    const kind = (POSE_CHAIN_HOPS as Record<string, PoseHopKind | undefined>)[nodes[producer].type];
    if (kind === undefined || seen.has(producer)) {
      return done({ node: producer, socket: binding?.socket ?? 'out' });
    }
    seen.add(producer);
    hops.push({ id: producer, kind });
    at = nodes[producer];
  }
  return done(null);
}

/**
 * #1357 — the pose layers inside a Rig's sub-network: down its own wire from `body` first (top to
 * bottom, as a chain reads), then any other layer the sub-network holds, by id. A Rig nested
 * inside is part of the sub-network, so its layers are here too.
 */
function layersInsideRig(nodes: Readonly<Record<string, GraphNodeLike>>, rigId: string): string[] {
  // The one ownership walk (`subnetworks.ts`); it reads the node table only.
  const inside = subnetworkOf({ nodes } as unknown as DagState, rigId);
  const out: string[] = [];
  let at = edgeTarget(nodes[rigId], 'body');
  while (at && inside.has(at) && !out.includes(at) && nodes[at]?.type === 'PoseLayer') {
    out.push(at);
    at = edgeTarget(nodes[at], 'pose');
  }
  const rest = [...inside].filter((id) => nodes[id]?.type === 'PoseLayer' && !out.includes(id));
  return [...out, ...rest.sort()];
}

/** The lowest hop, when it is an override layer reading a skeleton's rest pose. */
function baseOf(
  nodes: Readonly<Record<string, GraphNodeLike>>,
  hops: readonly PoseHop[],
  source: { readonly node: string; readonly socket: string },
): string | null {
  const bottom = hops[hops.length - 1];
  if (bottom === undefined || bottom.kind !== 'layer') return null;
  if (nodes[source.node]?.type !== 'Skeleton' || source.socket !== 'pose') return null;
  const mode = (nodes[bottom.id].params as { mode?: unknown } | undefined)?.mode;
  return mode === undefined || mode === 'override' ? bottom.id : null;
}

/**
 * The layer a hand-pose on `objectId` is written into: the nearest OVERRIDE layer in the Object's
 * chain, walking down from the top (#1245). Additive layers above it keep adding on top of the pose,
 * which is what a layer stack means; only a chain with no override layer needs one inserted.
 *
 * #1211 — never the chain's BASE layer (an imported file's motion, as keys): a bind mutes that one,
 * and a hand-pose survives a rebind (#1244). Never a MUTED layer either, where a pose would do
 * nothing. With neither to take it, null: the pose mutator inserts one directly under the Object.
 *
 * ONE answer for the writer (`poseBone`) and the reader (the inspector's pose row, #1215): the row
 * shows, keys and auto-keys the layer the pose lands in, never a different one.
 */
export function handPoseLayerOf(
  nodes: Readonly<Record<string, GraphNodeLike>>,
  objectId: string,
): string | null {
  const { hops, base } = poseLayerChain(nodes, objectId);
  // #1343 — a hand-pose is FK: only a layer the solves read from takes it.
  for (const hop of hops.slice(lowestSolve(nodes, hops) + 1)) {
    if (hop.kind === 'layer' && whyNotHandPosable(nodes, hop.id, base) === null) return hop.id;
  }
  return null;
}

/**
 * The index in `hops` of the lowest SOLVE, or -1 when the chain has none: an `ik` layer (#1343), or
 * a Rig (#1357), which is rig logic reading the animation below it.
 */
function lowestSolve(
  nodes: Readonly<Record<string, GraphNodeLike>>,
  hops: readonly PoseHop[],
): number {
  for (let i = hops.length - 1; i >= 0; i--) {
    if (hops[i].kind === 'rig') return i;
    if ((nodes[hops[i].id].params as { mode?: unknown } | undefined)?.mode === 'ik') return i;
  }
  return -1;
}

/**
 * #1343 — where a hand-pose layer goes when `handPoseLayerOf` finds none: the node whose `pose` input
 * it is inserted under. That is the lowest solve (an `ik` layer, or a Rig, #1357), so the new layer is
 * FK that every solve reads (Blender solves IK after every pose channel and constraint); with no
 * solve, the Object itself. Inserted above a solve, a hand-pose would override what it should steer.
 */
export function handPoseInsertionOf(
  nodes: Readonly<Record<string, GraphNodeLike>>,
  objectId: string,
): string {
  const { hops } = poseLayerChain(nodes, objectId);
  const at = lowestSolve(nodes, hops);
  return at >= 0 ? hops[at].id : objectId;
}

/** Why the chain layer `id` cannot take a hand-pose, or null when it can. The walk only passes
 *  through `PoseLayer`s, so its params are that node's. */
export function whyNotHandPosable(
  nodes: Readonly<Record<string, GraphNodeLike>>,
  id: string,
  base: string | null,
): string | null {
  if (id === base) return "is this Object's base layer, which a bind replaces";
  const params = nodes[id].params as Partial<PoseLayerParams> | undefined;
  if (params?.mute === true) return 'is muted';
  if (params?.mode !== undefined && params.mode !== 'override')
    return `is ${params.mode}, not override`;
  return null;
}

/**
 * The `Skeleton` node whose rig a pose output stands, walked on the node table (#1250).
 *
 * The evaluated wire already answers this — a `PosedSkeletonValue` carries its `skeleton` — and a
 * reader that evaluates should read it there. This is the params-side answer for readers that
 * cannot evaluate (the bone-map editor's rows), and it is the ONE such walk: each producer of a
 * `PosedSkeleton` output is named once, and `poseChain.test.ts` checks every one against the wire
 * and fails when a registered node type gains a pose output this does not know.
 *
 * - `Skeleton.pose` stands its own rig (the rest pose).
 * - `AnimationClip.pose` and `PosedSkeleton.out` (a procedural sway) stand the rig on their
 *   `skeleton` edge.
 * - `RetargetClip.posed` stands its TARGET rig (`skeleton`), which is what it poses.
 * - `PoseLayer.out` passes the pose on its `pose` input through.
 * - `Rig.out` (#1357) is what its sub-network hands back on `body`; with none wired, the pose on
 *   its `pose` input.
 * - `BodyInputPose.out` is the input of its Rig that it names. Asked of the node table, that is
 *   the rig it stands INSIDE its Rig; evaluated on its own, outside one, it stands none.
 *
 * Null for anything else, an unwired input, or a cycle.
 */
export function poseSkeletonIdOf(
  nodes: Readonly<Record<string, GraphNodeLike>>,
  nodeId: string | null,
): string | null {
  const seen = new Set<string>();
  let cur = nodeId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node = nodes[cur];
    if (!node) return null;
    switch (node.type) {
      case 'Skeleton':
        return cur;
      case 'AnimationClip':
      case 'PosedSkeleton':
      case 'RetargetClip':
        return edgeTarget(node, 'skeleton');
      case 'PoseLayer':
        cur = edgeTarget(node, 'pose');
        continue;
      case 'Rig':
        cur = edgeTarget(node, 'body') ?? edgeTarget(node, 'pose');
        continue;
      case 'BodyInputPose': {
        // The one ownership walk (`subnetworks.ts`); it reads the node table only.
        const [owner] = bodyInputChoicesOf({ nodes } as unknown as DagState, cur).owners;
        const input = (node.params as { input?: unknown } | undefined)?.input;
        cur =
          owner !== undefined && typeof input === 'string' ? edgeTarget(nodes[owner], input) : null;
        continue;
      }
      default:
        return null;
    }
  }
  return null;
}
