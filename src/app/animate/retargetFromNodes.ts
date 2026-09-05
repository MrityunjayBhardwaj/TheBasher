// Resolve a `RetargetClip` node to clip params, reading ONLY the node table (#901).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS IS PURE OVER PARAMS AND DOES NOT CALL `evaluate()`
// ─────────────────────────────────────────────────────────────────────────
// Every reader that drives pixels goes through `boundClipsForAsset`, which is
// deliberately pure over the node table — no evaluator, no DAG cache, no second
// walk. Its callers include the format migration, which runs on raw saved JSON
// long before an evaluator exists. So the retarget has to be resolvable from
// params alone, and it is: the source clip's keys are params, the bone map is
// params, and the target rig's bind pose is params too — `GltfSkeleton` is a pure
// projection of the asset's captured `skins`, so `projectGltfSkeleton` reaches it
// without evaluating anything.
//
// The node's own `evaluate()` and this resolver therefore both delegate to the
// same `retargetClip()`. One piece of math, two ways in — not two walks.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY IT MEMOIZES ON OPERAND IDENTITY
// ─────────────────────────────────────────────────────────────────────────
// Measured on the real operands (78 bones / 9360 keys / 120 frames → a 23-bone
// glTF rig): `retargetClip()` costs ~12ms. The read band re-derives on every new
// `nodes` object, and dragging a param produces one per pointer move — so an
// unmemoized resolve would put 12ms on a drag of ANY node in the project, including
// nodes that have nothing to do with this rig.
//
// The cache keys on the IDENTITY of the three operand objects. An edit replaces
// the object it touched and leaves the others alone, so this recomputes exactly
// when an operand actually changed and is free otherwise. That is the same
// memoization the evaluator's content-addressed cache would give the value side;
// this is the params side earning it the same way.
//
// REF: src/nodes/RetargetClip.ts (the node, and why it is time-free);
//      src/app/animate/boundClipsForAsset.ts (the one walk that calls this);
//      src/core/import/projectGltfSkeleton.ts; issue #901.

import { retargetClip } from '../../core/import/retarget';
import { projectGltfSkeleton } from '../../core/import/projectGltfSkeleton';
import type { AnimationClipParams } from '../../nodes/AnimationClip';
import type { BoneSpec, GltfSkinMetadata } from '../../nodes/types';
import { edgeTarget, type GraphNodeLike } from './graphNodes';

/** Projections are keyed on the captured skin object, which import writes once. */
const projectedSkins = new WeakMap<object, readonly BoneSpec[]>();

function projectSkin(skin: GltfSkinMetadata): readonly BoneSpec[] {
  const hit = projectedSkins.get(skin as unknown as object);
  if (hit) return hit;
  const bones = projectGltfSkeleton(skin).bones;
  projectedSkins.set(skin as unknown as object, bones);
  return bones;
}

/**
 * The bind-pose bones a `Skeleton`-typed node carries, or null.
 *
 * Both producers are pure over params: a plain `Skeleton` stores its bones
 * directly, and a `GltfSkeleton` is a projection of the asset's captured skin.
 */
export function bonesOfSkeletonNode(
  nodes: Readonly<Record<string, GraphNodeLike>>,
  skeletonId: string | null,
): readonly BoneSpec[] | null {
  if (!skeletonId) return null;
  const node = nodes[skeletonId];
  if (!node) return null;
  if (node.type === 'Skeleton') {
    const bones = (node.params as { bones?: unknown } | undefined)?.bones;
    return Array.isArray(bones) ? (bones as readonly BoneSpec[]) : null;
  }
  if (node.type === 'GltfSkeleton') {
    const assetId = edgeTarget(node, 'asset');
    if (!assetId) return null;
    const skins = (nodes[assetId]?.params as { skins?: unknown } | undefined)?.skins;
    if (!Array.isArray(skins)) return null;
    const i = (node.params as { skinIndex?: unknown } | undefined)?.skinIndex;
    const skin = skins[typeof i === 'number' ? i : 0] as GltfSkinMetadata | undefined;
    return skin ? projectSkin(skin) : null;
  }
  return null;
}

type SourceParams = { name?: string; duration?: number; keyframes?: unknown; loop?: boolean };

/**
 * Every operand a `RetargetClip` reads, resolved from the node table.
 *
 * Extracted (#921) because a SECOND reader arrived: the inspector's bone-map
 * editor needs the same source rig, target rig and map node this resolver needs,
 * and answering "which edges does a retarget read?" in two files is how the two
 * drift. The walk is stated once; each caller applies its own strictness on top.
 *
 * Deliberately NOT strict. This returns what it found and nulls what it did not,
 * because the two callers disagree about what counts as answerable: a clip with
 * no keyframes resolves to no clip params, but its map is still editable — indeed
 * that is exactly when a director most needs to edit it. Folding the strictness in
 * here would make the editor vanish at the moment it is wanted.
 */
export interface RetargetOperands {
  /** The `AnimationClip` node feeding `sourceClip`, when there is one. */
  readonly sourceNode: GraphNodeLike | null;
  readonly sourceParams: SourceParams | null;
  /** The rig the source clip's keyframe indices address — off the CLIP's own edge. */
  readonly sourceBones: readonly BoneSpec[] | null;
  readonly mapNodeId: string | null;
  readonly map: Readonly<Record<string, string>> | null;
  readonly targetBones: readonly BoneSpec[] | null;
}

/** Null when `node` is not a `RetargetClip`; otherwise whatever its edges reach. */
export function retargetOperandsFromNodes(
  nodes: Readonly<Record<string, GraphNodeLike>>,
  node: GraphNodeLike | undefined,
): RetargetOperands | null {
  if (!node || node.type !== 'RetargetClip') return null;

  const sourceId = edgeTarget(node, 'sourceClip');
  const sourceCandidate = sourceId ? nodes[sourceId] : undefined;
  const sourceNode =
    sourceCandidate && sourceCandidate.type === 'AnimationClip' ? sourceCandidate : null;

  // The source rig comes off the SOURCE CLIP's own edge — its keys are indices
  // into that rig and nothing else. Mirrors the node's `sourceClip.skeleton`.
  const sourceBones = sourceNode
    ? bonesOfSkeletonNode(nodes, edgeTarget(sourceNode, 'skeleton'))
    : null;

  const mapId = edgeTarget(node, 'boneMap');
  const mapNode = mapId ? nodes[mapId] : undefined;
  const mapOwned = mapNode && mapNode.type === 'BoneNameMap' ? mapNode : null;
  const rawMap = (mapOwned?.params as { map?: unknown } | undefined)?.map;

  return {
    sourceNode,
    sourceParams: sourceNode ? ((sourceNode.params as SourceParams | undefined) ?? null) : null,
    sourceBones,
    mapNodeId: mapOwned ? mapId : null,
    map: rawMap && typeof rawMap === 'object' ? (rawMap as Readonly<Record<string, string>>) : null,
    targetBones: bonesOfSkeletonNode(nodes, edgeTarget(node, 'skeleton')),
  };
}

/**
 * operand identities → output name → resolved params.
 *
 * Three weak levels so any one operand changing misses, and a fourth keyed on the
 * OUTPUT NAME, which is a param rather than an operand. Self-review caught it as a
 * measured wrong answer, not a worry: two RetargetClip nodes sharing a source, a
 * map and a rig but naming their outputs differently got the FIRST one's name,
 * because the key described only what the math reads and not everything the answer
 * carries. The name rides in `clipParams`, so it belongs in the key.
 */
const memo = new WeakMap<
  object,
  WeakMap<object, WeakMap<object, Map<string, Partial<AnimationClipParams>>>>
>();

/**
 * The clip params a `RetargetClip` node resolves to, or null when its graph is
 * not complete enough to answer (an unwired input, a rig with no bones, a source
 * clip with no keys).
 *
 * Null rather than an empty clip: the caller's contract is "clips that drive this
 * rig", and a half-wired retarget drives nothing. An empty clip would occupy a
 * slot in that answer and shadow a real one behind it.
 */
export function retargetClipParamsFromNodes(
  nodes: Readonly<Record<string, GraphNodeLike>>,
  node: GraphNodeLike | undefined,
): Partial<AnimationClipParams> | null {
  const operands = node ? retargetOperandsFromNodes(nodes, node) : null;
  if (!node || !operands) return null;

  const { sourceParams, sourceBones, map, targetBones } = operands;
  if (!Array.isArray(sourceParams?.keyframes) || sourceParams.keyframes.length === 0) return null;
  if (!sourceBones || sourceBones.length === 0) return null;
  if (!map) return null;
  if (!targetBones || targetBones.length === 0) return null;

  const outputName = (node.params as { name?: unknown } | undefined)?.name;

  const k1 = sourceParams as object;
  const k2 = map as object;
  const k3 = targetBones as unknown as object;
  const k4 = typeof outputName === 'string' ? outputName : '';
  const cached = memo.get(k1)?.get(k2)?.get(k3)?.get(k4);
  if (cached) return cached;

  const result = retargetClip({
    sourceBones,
    sourceClip: {
      name: typeof sourceParams.name === 'string' ? sourceParams.name : 'clip',
      duration: typeof sourceParams.duration === 'number' ? sourceParams.duration : 0,
      keyframes: sourceParams.keyframes as AnimationClipParams['keyframes'],
      // #919 — the source's own time domain travels with its keys.
      loop: sourceParams.loop !== false,
    },
    targetBones,
    nameMap: map as Readonly<Record<string, string>>,
    ...(k4 ? { outputName: k4 } : {}),
  });
  // Read-only in, read-only out: `retargetClip` returns readonly arrays and every
  // consumer of a BoundClip only reads. The cast widens the array type, not the
  // ownership — nothing here or downstream writes into it.
  const params = result.clipParams as Partial<AnimationClipParams>;

  let l2 = memo.get(k1);
  if (!l2) memo.set(k1, (l2 = new WeakMap()));
  let l3 = l2.get(k2);
  if (!l3) l2.set(k2, (l3 = new WeakMap()));
  let l4 = l3.get(k3);
  if (!l4) l3.set(k3, (l4 = new Map()));
  l4.set(k4, params);
  return params;
}
