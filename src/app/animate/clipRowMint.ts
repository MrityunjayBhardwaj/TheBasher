// Which mint does this bone's clip row use? (#889 slice 3 / #903)
//
// ─────────────────────────────────────────────────────────────────────────
// TWO CLIPS REACH A BONE, AND THEY ARE NOT INTERCHANGEABLE
// ─────────────────────────────────────────────────────────────────────────
// `TransformClip` is a glTF file's OWN embedded animation (gltfImportChain.ts:887)
// — keyed by `targetNodeId`, full TRS per key, rotation already in degrees.
// `AnimationClip` is a generated / BVH / FBX / retargeted motion
// (bvhImportChain.ts:91, fbxImportChain.ts:65, retarget.ts:224) — keyed by bone
// INDEX, position and rotation only, rotation in radians.
//
// They are not two encodings of one thing; they are two roads, and only the
// second one reaches the render through the baked band (`bakedGltfChannels`
// reads `boundClipsForAsset`, which walks AnimationClip alone). So the mint that
// materialises a bone's first edit differs by road:
//
//   AnimationClip  → ensureChannelForBone — per component, seeded from the clip,
//                    never claiming scale (the schema has no scale track, and an
//                    empty channel is a claim rather than silence).
//   TransformClip  → mutator.timeline.bakeGltfChannel — whole bone, all three
//                    components, the Wave D behaviour that has shipped since.
//
// MEASURED, not assumed: `bakeGltfChannel` REFUSES on an AnimationClip rig —
// "No active clip track for bone (nothing to bake)" — so before this, dragging a
// key on a generated character's clip row aborted at the first step and did
// nothing at all.
//
// WHY A CHOICE AND NOT A FALLBACK. A fallback would fire whenever the first
// road produced nothing, which includes "this bone genuinely has no track" — and
// it would then mint from the wrong source rather than refuse. The question
// asked here is which road the bone is ON, which has an observable answer:
// does a clip bound to this rig carry keys for this bone?
//
// REF: src/app/animate/ensureChannelForBone.ts; src/app/animate/boundClipsForAsset.ts;
//      src/agent/mutators/builders/bakeGltfChannel.ts; issues #889, #903, #877.

import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import type { ClosureSpec } from '../../agent/closure/types';
// The NARROW modules, not the `agent/mutators` barrel. The barrel pulls every
// builder and the tool registry, which reach back into src/app — measured, by
// importing it and watching the import-cycle gate red with this file, its
// caller and bindMotionToCharacter newly inside the cluster. dispatchMutator
// imports these two the same way for the same reason.
import { getMutator } from '../../agent/mutators/catalog';
import { validatePlan } from '../../agent/mutators/validate';
import { gltfChannelDagId, gltfChildDagId } from '../../core/import/gltfImportChain';
import type { AnimationClipParams } from '../../nodes/AnimationClip';
import { boneIndexOf, boundClipsForAsset } from './boundClipsForAsset';
import { ensureChannelForBone } from './ensureChannelForBone';
import type { BakedComponent } from '../../agent/mutators/builders/bakeChannelOps';

export type ClipRowMint =
  | {
      readonly ok: true;
      readonly ops: readonly Op[];
      readonly closure: ClosureSpec;
      /** Which road the bone turned out to be on — for the intent line and for
       *  tests that would otherwise pass while minting from the wrong source. */
      readonly source: 'animation-clip' | 'transform-clip';
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Does a clip BOUND TO THIS RIG carry keys for this bone?
 *
 * The bound-ness matters and is not a formality: a clip's bone indices are only
 * meaningful against the skeleton they were authored for, and a project can hold
 * a 78-bone source clip alongside the 23-bone retargeted one. `boundClipsForAsset`
 * follows the skeleton edge, so the source clip is excluded with no special case.
 */
export function animationClipCarriesBone(
  state: DagState,
  assetRef: string,
  childName: string,
): boolean {
  for (const clip of boundClipsForAsset(state.nodes, assetRef)) {
    const index = boneIndexOf(clip, childName);
    if (index === null) continue;
    const keyframes = (clip.params as Partial<AnimationClipParams>).keyframes ?? [];
    if (keyframes.some((k) => k.bone === index)) return true;
  }
  return false;
}

/**
 * The ops that materialise `childName`'s channel for `component`, chosen by the
 * road the bone is on. Empty `ops` means the channel was already there — the
 * caller appends either way and never branches on which happened.
 */
export function clipRowMintOps(
  state: DagState,
  assetRef: string,
  childName: string,
  component: BakedComponent,
): ClipRowMint {
  const boneId = gltfChildDagId(assetRef, childName);
  const channelId = gltfChannelDagId(assetRef, childName, component);

  if (animationClipCarriesBone(state, assetRef, childName)) {
    const ensured = ensureChannelForBone(state, boneId, component);
    if (!ensured) {
      return { ok: false, reason: `No GltfChild for "${childName}" on asset "${assetRef}".` };
    }
    return {
      ok: true,
      ops: ensured.ops,
      // Hand-built rather than borrowed from a mutator, because the mint is a
      // pure function here rather than a plan.
      //
      // The channel root is NOT what keeps the composite's later write legal —
      // measured, by removing it and watching every drag row stay green. Each
      // retime step validates against the forked state and declares its own
      // root, and the mint's own addNode is exempt from gate 3 anyway. It is
      // declared because a closure should describe the step that produced it: a
      // caller that mints and then writes in ONE plan (the keyboard paths) needs
      // it, and a spec that only named the bone would be true by accident.
      closure: { rootSelectors: [boneId, channelId], followedEdges: [] },
      source: 'animation-clip',
      warnings: [],
    };
  }

  const bake = getMutator('mutator.timeline.bakeGltfChannel');
  if (!bake) {
    return { ok: false, reason: 'Timeline Mutators not registered (bakeGltfChannel).' };
  }
  const parsed = bake.spec.safeParse({ assetRef, childName });
  if (!parsed.success) {
    return { ok: false, reason: `bakeGltfChannel spec invalid: ${parsed.error.message}` };
  }
  const result = validatePlan(bake, parsed.data, state, `Edit imported clip: ${childName}`);
  if (!result.ok) {
    return { ok: false, reason: `bakeGltfChannel rejected: ${result.reason}` };
  }
  return {
    ok: true,
    ops: result.ops,
    closure: result.closure.spec,
    source: 'transform-clip',
    warnings: result.warnings,
  };
}
