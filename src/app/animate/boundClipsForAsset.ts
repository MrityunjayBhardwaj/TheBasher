// Which `AnimationClip`s drive a glTF asset's rig, and which bone each key is for.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS IS ONE FUNCTION AND NOT TWO WALKS
// ─────────────────────────────────────────────────────────────────────────
// #888 taught the read band to reach a retargeted clip by walking
//
//   AnimationClip --inputs.skeleton--> GltfSkeleton --inputs.asset--> GltfAsset
//
// #889 needs the SAME walk for a different purpose: to seed a channel from the
// clip at the moment a bone is first edited. Two copies of an edge walk are two
// answers to "which clip drives this bone", and they would diverge silently —
// the read side would render one clip's motion while the mint seeded from
// another, which looks like a bad seed rather than like a disagreement.
//
// So the walk lives here once, and both sides consume it: the band turns the
// result into samplers, the mint turns it into keys.
//
// WHY THE EDGE AND NOT A NAME MATCH. A clip keyframe's bone INDEX is only
// meaningful against the skeleton the indices were authored for. Reading the
// skeleton off the clip's own edge makes an index/rig mismatch unrepresentable
// rather than unlikely. In `Robot-Walk.basher` that is load-bearing: the
// retargeted 23-bone clip hangs off the `GltfSkeleton` while the 78-bone SOURCE
// clip hangs off a plain `Skeleton`, so the walk excludes the source with no
// special case.
//
// REF: src/app/bakedGltfChannels.ts (the read band that consumes this);
//      src/nodes/AnimationClip.ts (buildClipBoneSamplers); issues #888, #889.

import type { AnimationClipParams } from '../../nodes/AnimationClip';
import { edgeTarget, type GraphNodeLike } from './graphNodes';
import { retargetClipParamsFromNodes } from './retargetFromNodes';

// Re-exported so every existing importer of the walk keeps its one import site.
export { edgeTarget };
export type { GraphNodeLike };

/** One clip bound to an asset's rig, with the index→name spine to read it by. */
export interface BoundClip {
  readonly clipId: string;
  /** bone INDEX → childName, from the skin's `jointKeys`. */
  readonly jointKeys: readonly string[];
  readonly params: Partial<AnimationClipParams>;
}

/**
 * Every clip bound to `assetRef`'s rig, in deterministic order — a materialised
 * `AnimationClip` or a `RetargetClip` resolved from its inputs (#901).
 *
 * ONE pass buckets the three node types the walk needs, then the work happens
 * over the buckets. The read-side caller hands in the WHOLE node table on every
 * resolve and a glTF import runs to several hundred nodes, so sorting all of
 * them — or scanning them once per skeleton — would put an O(n log n) and an
 * O(n²) on a path that used to be a single sweep. Almost every project has no
 * retargeted clip at all, and that case exits after this pass having sorted
 * nothing.
 *
 * Sorted (V22): with more than one clip bound to a rig, WHICH one supplies a
 * bone must not depend on object-key order. Earlier entries win at both call
 * sites, so the order is part of the answer rather than incidental.
 */
export function boundClipsForAsset(
  nodes: Readonly<Record<string, GraphNodeLike>>,
  assetRef: string,
): BoundClip[] {
  let assetId: string | undefined;
  const skeletonIds: string[] = [];
  const clipIds: string[] = [];
  for (const id of Object.keys(nodes)) {
    const n = nodes[id];
    if (n.type === 'AnimationClip' || n.type === 'RetargetClip') clipIds.push(id);
    else if (n.type === 'GltfSkeleton') skeletonIds.push(id);
    else if (
      assetId === undefined &&
      n.type === 'GltfAsset' &&
      (n.params as { assetRef?: unknown }).assetRef === assetRef
    ) {
      assetId = id;
    }
  }
  if (assetId === undefined || skeletonIds.length === 0 || clipIds.length === 0) return [];
  const skins = (nodes[assetId].params as { skins?: unknown }).skins;
  if (!Array.isArray(skins)) return [];

  skeletonIds.sort();
  clipIds.sort();

  const out: BoundClip[] = [];
  for (const skeletonId of skeletonIds) {
    const skel = nodes[skeletonId];
    if (edgeTarget(skel, 'asset') !== assetId) continue;

    // bone INDEX → childName. `skin.jointKeys` IS the projection spine: the
    // GltfSkeleton value's bones[i].name is jointKeys[i], and the same key is a
    // nodeNameMap key. Reading it off the asset's captured params keeps this
    // pure over the node table — no evaluate(), no second walk.
    const skinIndex = (skel.params as { skinIndex?: unknown }).skinIndex;
    const skin = skins[typeof skinIndex === 'number' ? skinIndex : 0] as
      | { jointKeys?: unknown }
      | undefined;
    const jointKeys = skin?.jointKeys;
    if (!Array.isArray(jointKeys)) continue;

    for (const clipId of clipIds) {
      const clip = nodes[clipId];
      if (edgeTarget(clip, 'skeleton') !== skeletonId) continue;
      // #901 — a RetargetClip's keys are not in its params; they are the graph
      // relationship, resolved here. Both kinds answer the same question ("which
      // keys drive this rig"), so they share the one bucket and the one edge
      // check rather than forking the walk.
      const params =
        clip.type === 'RetargetClip'
          ? retargetClipParamsFromNodes(nodes, clip)
          : (clip.params as Partial<AnimationClipParams> | undefined);
      if (!Array.isArray(params?.keyframes) || params.keyframes.length === 0) continue;
      out.push({ clipId, jointKeys: jointKeys as readonly string[], params });
    }
  }
  return out;
}

/**
 * The bone index a childName occupies in a bound clip, or null when that clip's
 * rig does not carry the bone.
 *
 * Separate from the walk because the two callers ask different questions of the
 * same spine: the read band iterates every bone a clip has, while the mint asks
 * about exactly one.
 */
export function boneIndexOf(clip: BoundClip, childName: string): number | null {
  const i = clip.jointKeys.indexOf(childName);
  return i >= 0 ? i : null;
}
