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
  // ACTIVE FIRST, then by id (#907).
  //
  // The id order alone made "which motion plays" depend on the alphabetical
  // order of the two source filenames, because a retargeted clip's id is derived
  // from the pair. Deterministic — which is why the sort is here at all — but
  // arbitrary from where the director stands, and invisible either way.
  //
  // The tie-break stays the id, so this is a REFINEMENT of the old order rather
  // than a replacement: with no active clip (every project saved before this)
  // every entry compares equal on the first key and the result is byte-identical
  // to what it has always been. That is what makes the flag safe with no
  // migration.
  clipIds.sort((a, b) => {
    const rank = (id: string) =>
      (nodes[id].params as { active?: unknown }).active === true ? 0 : 1;
    return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
  });

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
 * Every character rig a clip's motion ends up driving, in deterministic order.
 *
 * The INVERSE of the walk above: that one starts at an asset and finds its
 * clips, this one starts at a clip and finds its rigs. Both answer "which clip
 * drives which rig", so they live together — the alternative is a second copy of
 * the edge knowledge, and this file's header is about what that costs.
 *
 * 🔴 A GENERATED CLIP IS NOT ON ITS CHARACTER'S EDGE, AND NEVER WAS (#966).
 * `bindMotionToCharacter` leaves the incoming 78-bone clip hanging off its own
 * source `Skeleton` and builds a `RetargetClip` beside it carrying the
 * `GltfSkeleton`. So a caller asking a generated clip "which character are you
 * on?" by reading `clip.inputs.skeleton` gets the SOURCE rig — the right socket
 * name on the wrong node — and concludes the clip is bound to no character at
 * all. Measured in a browser: the motion generated along a drawn path, 18 of 23
 * bones animating, and placement refusing every time because it asked here.
 *
 * Both arrangements are answered: a clip already sitting on a `GltfSkeleton` (an
 * import that needed no retarget) reports it directly, and a clip reached through
 * one or more `RetargetClip`s reports each rig those carry.
 *
 * Returns every rig rather than the first, because one generated walk can be
 * bound to two characters and both of them walk the path. Picking one would make
 * WHICH character moves depend on id order — the same arbitrariness the sort
 * above exists to remove (V22).
 */
export function riggedSkeletonsForClip(
  nodes: Readonly<Record<string, GraphNodeLike>>,
  clipId: string,
): string[] {
  const out = new Set<string>();
  const direct = edgeTarget(nodes[clipId], 'skeleton');
  if (direct && nodes[direct]?.type === 'GltfSkeleton') out.add(direct);
  for (const id of Object.keys(nodes)) {
    const n = nodes[id];
    // A COST GATE, not a correctness one, and said so because it cannot be
    // falsified: `RetargetClip` is the only node in the tree that declares a
    // `sourceClip` input, so deleting this line changes no answer today. It
    // earns its place by skipping two edge reads per node on a table that runs
    // to several hundred after a glTF import. What makes the answer RIGHT is the
    // `sourceClip` match below.
    if (n.type !== 'RetargetClip') continue;
    if (edgeTarget(n, 'sourceClip') !== clipId) continue;
    const skel = edgeTarget(n, 'skeleton');
    if (skel && nodes[skel]?.type === 'GltfSkeleton') out.add(skel);
  }
  return [...out].sort();
}

/** A retarget's two ends: the SOURCE clip it reads and the rig it drives. */
export interface RetargetPair {
  readonly retargetId: string;
  readonly sourceClipId: string;
  readonly targetSkeletonId: string;
}

/**
 * Every retarget in the graph, as the pair of ends it connects (#977).
 *
 * `riggedSkeletonsForClip` walks this same spine from the CLIP end and answers
 * "which rigs does this clip drive". This walks it whole and answers "what does
 * each retarget read, and what does it drive" — which is what a viewer needs to
 * draw the source rig beside the character it is being retargeted onto.
 *
 * It lives here, next to that walk, rather than beside the drawing code: two
 * modules resolving `RetargetClip`'s edges independently would be two answers to
 * one question, which is exactly the divergence V425 was filed for.
 *
 * A retarget missing either end is skipped — a half-wired graph draws no
 * reference rig rather than throwing in a render loop.
 */
export function retargetPairs(nodes: Readonly<Record<string, GraphNodeLike>>): RetargetPair[] {
  const out: RetargetPair[] = [];
  for (const id of Object.keys(nodes)) {
    const n = nodes[id];
    if (n.type !== 'RetargetClip') continue;
    const sourceClipId = edgeTarget(n, 'sourceClip');
    const targetSkeletonId = edgeTarget(n, 'skeleton');
    if (!sourceClipId || !targetSkeletonId) continue;
    out.push({ retargetId: id, sourceClipId, targetSkeletonId });
  }
  // Sorted so WHICH reference rig pairs with which character can never depend
  // on object-key order (V22, the same reason riggedSkeletonsForClip sorts).
  return out.sort((a, b) =>
    a.retargetId < b.retargetId ? -1 : a.retargetId > b.retargetId ? 1 : 0,
  );
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
