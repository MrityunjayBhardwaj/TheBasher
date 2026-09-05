// Pure enumeration of per-bone BAKED KeyframeChannel nodes for a glTF asset
// (P7.12 #108, copy-on-write edit layer). Shared by the TWO callers of the
// layering primitive (BLOCK-1) so both surfaces resolve the SAME baked band:
//   1. the renderer  — SceneFromDAG.GltfAssetR useFrame (C2)
//   2. the read-side — resolveEvaluatedTransform GltfChild branch (C3, gizmo/NPanel)
// A baked band threaded into only one surface produces a displayed-≠-rendered
// split (the #68/#77 second-surface bug class, H40) — hence ONE shared
// enumerator, not a per-surface re-implementation.
//
// BLOCK-2 (the dual key): the bake mutator (Wave D) stores BOTH
// `params.childName` (the glTF child name) AND `params.target` (= the GltfChild
// dagId, hashId('gltfChild', assetRef, childName)). This enumerator reads
// `childName` DIRECTLY — no per-frame nodeNameMap inverse scan — and uses the
// asset's `nodeNameMap` (childName → dagId) as the asset-membership scope:
// a channel belongs to THIS asset iff `nodeNameMap[childName] === params.target`
// (the two keys agree, by D1 construction).
//
// PRESENCE, not value (R-4): a component appears in the returned samplers iff a
// baked channel node drives it; the resolver (resolveGltfChildTrs) then lets
// presence win over the clip — never value-equality. Time-sampling is deferred:
// the enumerator returns sampler closures, the caller invokes them at its own
// cadence (the renderer's useFrame snapshot / the read-side ctx.time.seconds),
// so NO new time subscription is introduced (H48).
//
// REF: PLAN 7.12 Wave C (C2/C3, BLOCK-1/BLOCK-2); resolveGltfChildTransform.ts
//      (the layering primitive); vyapti V20/V24; hetvabhasa H40/H48.

import { buildVec3Sampler, type KeyframeChannelVec3Params } from '../nodes/KeyframeChannelVec3';
import { buildClipBoneSamplers } from '../nodes/AnimationClip';
import type { Vec3 } from '../nodes/types';
import type { BakedChannel } from './resolveGltfChildTransform';
// The radians→degrees boundary. THE SAME helper `ensureChannelForBone` seeds a
// minted channel with (animate/ensureChannelForBone.ts, where the unit change is
// documented at length): the clip band below must produce, for an UNEDITED bone,
// the value a mint would have produced for that same bone the instant it is
// edited — otherwise the bone visibly jumps on its first keyframe. Two
// conversion sites are two chances to drift, which is why they name each other.
import { radVec3ToDeg } from '../viewport/rotation';
import { boundClipsForAsset, type GraphNodeLike } from './animate/boundClipsForAsset';

type ChannelSampler = (seconds: number) => Vec3;

/** A bone's baked component samplers (function-of-time, V24), by TRS component. */
export type BakedChannelSamplers = Partial<
  Record<'position' | 'rotation' | 'scale', ChannelSampler>
>;

/** Minimal node shape this enumerator reads — the DagState node subset it needs. */
interface ChannelNodeLike {
  readonly type: string;
  readonly params?: unknown;
}

/**
 * Does this node carry baked TRS motion for the asset described by `nodeNameMap`?
 *
 * THE ONE definition of "this asset's baked motion", because more than one caller
 * now depends on the answer and they must not drift: the samplers the renderer
 * reads (below) and the ids the clear action deletes
 * (`bakedChannelNodeIdsForAsset`) are the SAME set by construction. A clear that
 * used its own predicate could leave behind a channel the renderer still plays —
 * the character would keep moving after "clear baked motion" reported success,
 * which is the silent-mismatch shape this area has already produced once (H516).
 */
function isBakedTransformChannelOf(
  node: ChannelNodeLike,
  nodeNameMap: Readonly<Record<string, string>>,
): boolean {
  if (node.type !== 'KeyframeChannelVec3') return false;
  const p = node.params as { childName?: unknown; target?: unknown; paramPath?: unknown };
  if (typeof p.childName !== 'string' || typeof p.target !== 'string') return false;
  if (p.paramPath !== 'position' && p.paramPath !== 'rotation' && p.paramPath !== 'scale') {
    return false;
  }
  // BLOCK-2 membership: in THIS asset iff childName maps to a dagId here AND
  // the channel's stored target dagId agrees (D1 wrote them hashId-consistent).
  return nodeNameMap[p.childName] === p.target;
}

/**
 * The node ids of every baked transform channel belonging to ONE glTF asset.
 *
 * The delete-side counterpart of `bakedChannelSamplersForAsset`: same predicate,
 * ids instead of samplers. Deleting exactly this set is what makes "clear baked
 * motion" mean "the renderer now sees no baked motion for this character" rather
 * than "some channels were removed".
 *
 * Ids are returned SORTED (V22): the op set a director undoes must not depend on
 * object-key order.
 *
 * @param nodes        the DAG node table, keyed by node id (read-only).
 * @param nodeNameMap  the asset's childName → dagId map (GltfAsset.params.nodeNameMap).
 */
export function bakedChannelNodeIdsForAsset(
  nodes: Readonly<Record<string, ChannelNodeLike>>,
  nodeNameMap: Readonly<Record<string, string>>,
): string[] {
  const out: string[] = [];
  for (const [id, node] of Object.entries(nodes)) {
    if (isBakedTransformChannelOf(node, nodeNameMap)) out.push(id);
  }
  return out.sort();
}

/** Minimal asset-node shape the assetRef → nodeNameMap lookup reads. */
interface AssetNodeLike {
  readonly type: string;
  readonly params?: unknown;
}

/**
 * The baked-channel node ids for an asset addressed by `assetRef`, or `null`
 * when no `GltfAsset` in the scene carries that ref (or carries no usable
 * `nodeNameMap`).
 *
 * `null` is NOT the empty array, and the difference matters: an asset whose map
 * is missing has an UNKNOWN baked set, and reporting it as "nothing baked" would
 * let a clear announce success having deleted nothing. Callers must distinguish
 * "already clear" from "cannot tell".
 *
 * The single entry point for both consumers — the clear dispatch and the button
 * that offers it — so the action and the affordance cannot disagree about whether
 * a character has motion to clear.
 */
export function bakedChannelIdsForAssetRef(
  nodes: Readonly<Record<string, AssetNodeLike>>,
  assetRef: string,
): string[] | null {
  for (const node of Object.values(nodes)) {
    if (node.type !== 'GltfAsset') continue;
    const p = node.params as { assetRef?: unknown; nodeNameMap?: unknown };
    if (p.assetRef !== assetRef) continue;
    if (!p.nodeNameMap || typeof p.nodeNameMap !== 'object') return null;
    return bakedChannelNodeIdsForAsset(
      nodes as Readonly<Record<string, ChannelNodeLike>>,
      p.nodeNameMap as Record<string, string>,
    );
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// THE CLIP BAND (#888) — how a bone with NO channel node still reaches motion
// ───────────────────────────────────────────────────────────────────────────
// The resolver already falls through to the clip when a bone has no baked
// channel. For ONE of the two bake sources that is enough; for the other it is
// not, and that difference is the whole reason the eager bake exists:
//
//   bakeGltfChannel   — the asset's OWN embedded clip. `clipTrack` is the
//                       asset's `transformClip` socket, so the resolver falls
//                       through to it. The bake is a duplicate of what would
//                       have been read anyway.
//   the clip band     — a FOREIGN clip: BVH, FBX, retarget, or generated. An
//   below               `AnimationClip` is not on that socket, so nothing falls
//                       through, and until #888 materialising every bone was the
//                       only bridge to the rendered skin. That was the copy that
//                       went stale, and #889 deleted the mutator that made it.
//
// It did not have to be. The clip is already edged to the rig — nothing had ever
// looked at the edge:
//
//   AnimationClip  --inputs.skeleton-->  GltfSkeleton  --inputs.asset-->  GltfAsset
//
// Walking it gives a bone with no channel a sampler over the clip, which is what
// let #889 stop making the copy at all. Measured on `Robot-Walk.basher`:
// stripping all 46 baked channels leaves the same 23 bones driven, with the
// sampled rotations agreeing to 6e-14.
//
// WHY THE EDGE AND NOT A NAME MATCH. The bone INDEX in a clip keyframe is only
// meaningful against the skeleton the indices were authored for. Reading the
// skeleton off the clip's own edge makes an index/rig mismatch unrepresentable
// rather than merely unlikely — the same argument `retarget` makes for reading
// the rig off an edge instead of a parameter. In `Robot-Walk.basher` this is load
// bearing rather than theoretical: the retargeted 23-bone clip hangs off the
// `GltfSkeleton`, while the 78-bone SOURCE clip it came from hangs off a plain
// `Skeleton`, so the edge walk excludes the source clip without a special case.

/**
 * Per-bone samplers over the `AnimationClip`s bound to this asset's rig, keyed
 * by childName. These are the FALLBACK band: a bone that has a real channel
 * node is served by that channel, never by this.
 *
 * The edge walk itself lives in `boundClipsForAsset` because #889's mint needs
 * the SAME answer to "which clip drives this bone". Two copies would diverge
 * silently — the read side rendering one clip while a mint seeded from another,
 * which reads as a bad seed rather than as a disagreement.
 *
 * Only `position` and `rotation` are produced. `AnimationClipParams.keyframes`
 * carries no scale, so claiming a scale component would SUPPRESS the asset's
 * own scale track underneath it (the resolver reads presence, not value) —
 * omitting it leaves scale to the bands below, which is the honest answer and
 * the same call `ensureChannelForBone` makes when it mints.
 */
function clipBandSamplersForAsset(
  nodes: Readonly<Record<string, GraphNodeLike>>,
  nodeNameMap: Readonly<Record<string, string>>,
  assetRef: string,
): Record<string, BakedChannelSamplers> {
  const out: Record<string, BakedChannelSamplers> = {};
  for (const clip of boundClipsForAsset(nodes, assetRef)) {
    const params = clip.params;
    // Delegate to the CLIP's own sampling (AnimationClip.buildClipBoneSamplers)
    // rather than rebuilding its keys as channel params — nothing is
    // defaulted because nothing is invented. See that function's header.
    const boneSamplers = buildClipBoneSamplers({
      keyframes: params.keyframes ?? [],
      duration: typeof params.duration === 'number' ? params.duration : 1,
      loop: params.loop !== false,
    });

    for (const [boneIndex, sample] of boneSamplers) {
      const childName = clip.jointKeys[boneIndex];
      // A bone the skeleton cannot name, or one outside this asset, cannot be
      // addressed — the same skip `bakeChannelOpsForBone` makes for the same
      // reason: a channel under an empty key is scoped to no asset and silently
      // never applies.
      if (typeof childName !== 'string' || childName.length === 0) continue;
      if (!(childName in nodeNameMap)) continue;
      // First clip by sorted id wins a bone; a later one does not overwrite.
      const slot = (out[childName] ??= {});
      slot.position ??= (seconds) => sample(seconds).position;
      // 🔴 UNITS: an AnimationKeyframe rotation is RADIANS and this band is
      // DEGREES. `ensureChannelForBone` documents why at length — copying
      // through unconverted scales every bone rotation by π/180, which renders
      // as a character standing still while its root position travels (#843).
      slot.rotation ??= (seconds) => radVec3ToDeg(sample(seconds).rotation);
    }
  }
  return out;
}

/**
 * Enumerate the motion bands belonging to ONE glTF asset, keyed by childName →
 * per-component sampler closures.
 *
 * TWO SOURCES, ONE BAND, in precedence order:
 *   1. baked `KeyframeChannelVec3` nodes — an authored/materialised track;
 *   2. (#888) the `AnimationClip`s bound to this asset's rig, for any component
 *      no channel node supplies.
 *
 * The merge happens HERE, not at the call sites. Both surfaces — the renderer
 * (C2) and the read-side gizmo/NPanel (C3) — consume this one function
 * precisely so a band cannot be threaded into one and not the other; a merge
 * performed per-caller would be exactly the per-surface re-implementation that
 * produces a displayed-≠-rendered split (H40).
 *
 * @param nodes        the DAG node table (read-only).
 * @param nodeNameMap  the asset's childName → dagId map (GltfAssetValue.nodeNameMap)
 *                     — also the asset-membership scope (BLOCK-2).
 * @param assetRef     the asset's storage handle. REQUIRED, not optional: it is
 *                     the root of the edge walk, and a caller that omitted it
 *                     would silently get the channel band alone — which is a
 *                     correct-looking result and the wrong one. Both callers
 *                     have it in hand.
 */
export function bakedChannelSamplersForAsset(
  nodes: Readonly<Record<string, ChannelNodeLike>>,
  nodeNameMap: Readonly<Record<string, string>>,
  assetRef: string,
): Record<string, BakedChannelSamplers> {
  const out: Record<string, BakedChannelSamplers> = {};
  for (const node of Object.values(nodes)) {
    if (!isBakedTransformChannelOf(node, nodeNameMap)) continue;
    const p = node.params as { childName: string; paramPath: 'position' | 'rotation' | 'scale' };
    // Function-of-time (V24): build the sampler closure once here (per DAG
    // change), invoked per-frame by the caller. buildVec3Sampler is the SAME
    // sort+interp the node's evaluate uses — one source of the sampling math.
    (out[p.childName] ??= {})[p.paramPath] = buildVec3Sampler(
      node.params as KeyframeChannelVec3Params,
    );
  }
  // The clip band fills only what no channel node supplied. `??=` is the
  // precedence rule in one character: a real channel is an authored (or
  // materialised) track and outranks the clip it came from, per-component —
  // the same presence-not-value rule the resolver applies one layer up.
  for (const [childName, fromClip] of Object.entries(
    clipBandSamplersForAsset(
      nodes as Readonly<Record<string, GraphNodeLike>>,
      nodeNameMap,
      assetRef,
    ),
  )) {
    const slot = (out[childName] ??= {});
    slot.position ??= fromClip.position;
    slot.rotation ??= fromClip.rotation;
  }
  return out;
}

/**
 * Sample a child's baked component samplers at `seconds` into a `BakedChannel`
 * (the per-component pre-sampled TRS the resolver layers). Returns `undefined`
 * when the child has no baked channel, so the resolver falls through to clip/base.
 * Present components win over the clip (presence, R-4); absent ones fall through.
 */
export function sampleBakedChannel(
  samplers: BakedChannelSamplers | undefined,
  seconds: number,
): BakedChannel | undefined {
  if (!samplers) return undefined;
  const out: { position?: Vec3; rotation?: Vec3; scale?: Vec3 } = {};
  if (samplers.position) out.position = samplers.position(seconds);
  if (samplers.rotation) out.rotation = samplers.rotation(seconds);
  if (samplers.scale) out.scale = samplers.scale(seconds);
  return out;
}
