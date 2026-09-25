// The `PoseOverride` chain hanging off a `RetargetClip` — ONE walk, shared (#1156).
//
// It lived inside the poseBone mutator, which was right while the mutator was the only
// road into the pose lane. It is not any more: the inspector now offers the same gesture
// to a director, and the two must agree about which overrides already exist for a bone.
// Two spellings of this walk would be two answers to "does this bone already carry an
// override" — the shape that cost #1088 and #1141, where a bind's hide and a path
// placement each grew their own answer to one question and drifted apart.
//
// REF: src/agent/mutators/builders/poseBone.ts (the mutator that appends to the tip);
//      src/app/animate/poseTargetForBone.ts (the inspector's lookup); issues #993, #1156.

import { edgeTarget, type GraphNodeLike } from './graphNodes';
import type { PoseLayerParams } from '../../nodes/PoseLayer';

export interface OverrideNode {
  readonly id: string;
  readonly bone: string;
  readonly overridden: { position?: boolean; rotation?: boolean };
}

/**
 * The chain of `PoseOverride`s hanging off `retargetId`, nearest first.
 *
 * Walked consumer-side one hop at a time: at each step, the override whose `pose`
 * input names the current node. Bounded by the node count so a malformed graph
 * cannot spin, and by taking the FIRST match at each hop it reports a single
 * chain even if a previous road (or a hand-edited file) left a fork — `build`
 * appends to the tip of what it reports, which keeps a fork from widening.
 */
export function overrideChain(
  nodes: Readonly<Record<string, GraphNodeLike>>,
  retargetId: string,
): OverrideNode[] {
  const ids = Object.keys(nodes).sort();
  const out: OverrideNode[] = [];
  let cur = retargetId;
  const seen = new Set<string>([retargetId]);
  for (let hops = 0; hops < ids.length; hops++) {
    const nextId = ids.find(
      (id) =>
        nodes[id].type === 'PoseOverride' && edgeTarget(nodes[id], 'pose') === cur && !seen.has(id),
    );
    if (nextId === undefined) break;
    const p = (nodes[nextId].params ?? {}) as {
      bone?: unknown;
      overridden?: { position?: boolean; rotation?: boolean };
    };
    out.push({
      id: nextId,
      bone: typeof p.bone === 'string' ? p.bone : '',
      overridden: p.overridden ?? {},
    });
    seen.add(nextId);
    cur = nextId;
  }
  return out;
}

/** The pose layers under an armature Object, and the source they edit. */
export interface PoseLayerChain {
  /** `PoseLayer` ids from the Object down: `[0]` feeds the Object, the last reads the source. */
  readonly layers: readonly string[];
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
 * `PoseLayer`; the first producer that is not one is the source. Unlike the clone road's override
 * chain there is no fork to guard: every hop reads a single-cardinality input. Bounded by the node
 * count so a malformed graph cannot spin.
 */
export function poseLayerChain(
  nodes: Readonly<Record<string, GraphNodeLike>>,
  objectId: string,
): PoseLayerChain {
  const layers: string[] = [];
  let at = nodes[objectId];
  const limit = Object.keys(nodes).length;
  for (let hops = 0; at && hops <= limit; hops++) {
    const binding = at.inputs?.pose as { node?: string; socket?: string } | undefined;
    const producer = binding?.node;
    if (typeof producer !== 'string' || !nodes[producer]) {
      return { layers, source: null, base: null };
    }
    if (nodes[producer].type !== 'PoseLayer' || layers.includes(producer)) {
      const source = { node: producer, socket: binding?.socket ?? 'out' };
      return { layers, source, base: baseOf(nodes, layers, source) };
    }
    layers.push(producer);
    at = nodes[producer];
  }
  return { layers, source: null, base: null };
}

/** The bottom layer, when it is an override layer reading a skeleton's rest pose. */
function baseOf(
  nodes: Readonly<Record<string, GraphNodeLike>>,
  layers: readonly string[],
  source: { readonly node: string; readonly socket: string },
): string | null {
  const bottom = layers[layers.length - 1];
  if (bottom === undefined) return null;
  if (nodes[source.node]?.type !== 'Skeleton' || source.socket !== 'pose') return null;
  const mode = (nodes[bottom].params as { mode?: unknown } | undefined)?.mode;
  return mode === undefined || mode === 'override' ? bottom : null;
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
  const { layers, base } = poseLayerChain(nodes, objectId);
  for (const id of layers) {
    if (whyNotHandPosable(nodes, id, base) === null) return id;
  }
  return null;
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
