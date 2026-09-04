// The ONE emitter of baked per-bone `KeyframeChannelVec3` nodes for a glTF
// asset — shared by the two mutators that materialise motion onto a rig.
//
// Extracted when the second consumer arrived (the "2nd consumer justifies the
// module" retrofit this codebase already applies at D-06). Consumer 1 is
// `bakeGltfChannel`, whose source is the asset's OWN embedded TransformClip.
// Consumer 2 is `ensureChannelForBone`, whose source is a bound `AnimationClip`
// that arrived from somewhere else entirely — a BVH, an FBX, a retarget, or a
// generator. (Consumer 2 was `bakeClipOntoRig` until #889: same source, but it
// emitted for every bone at bind time instead of for one bone at edit time.)
//
// 🔑 THE SOURCE DIFFERS; EVERYTHING DOWNSTREAM OF IT MUST NOT. Both consumers
// must emit the same node type, under the same content-addressed ids, carrying
// the same dual key, with no edges — because the renderer's enumerator
// (`bakedChannelSamplersForAsset`) recognises a channel by exactly those
// properties. A second, subtly-different emitter would produce channels that
// look right in the graph and are invisible to the resolver, which is the
// silent-failure shape this whole area keeps producing.
//
// What it does NOT do, and why:
//   - NO connect ops. A GltfChild is an edge-less addressing satellite (R-1),
//     so a baked channel reaches its bone through the renderer's resolver
//     ENUMERATION, never an `AnimationLayer.animation` edge. Wiring one would
//     make the channel show in the dopesheet and NOT drive the bone.
//   - NO overwrite. Ids are content-addressed, so re-baking the same bone is a
//     no-op against live state and the ids never move (V22).
//
// REF: src/app/bakedGltfChannels.ts (the enumerator that consumes these);
//      src/app/resolveGltfChildTransform.ts (the layering primitive — baked
//        beats clip on PRESENCE); src/core/import/gltfImportChain.ts
//        (gltfChildDagId / gltfChannelDagId); vyapti V20/V22, hetvabhasa H36/H40.

import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import type { Vec3 } from '../../../nodes/types';
import { gltfChannelDagId, gltfChildDagId } from '../../../core/import/gltfImportChain';
import { defaultModifier } from '../../../nodes/channelModifiers';

/** The TRS components a bone can carry, in stable emission order. */
export const BAKED_COMPONENTS = ['position', 'rotation', 'scale'] as const;
export type BakedComponent = (typeof BAKED_COMPONENTS)[number];

/** One keyframe as the channel stores it. Rotation is DEGREES throughout — the
 *  clip stores degrees and `KeyframeChannelVec3` reads degrees, so there is no
 *  conversion anywhere on this road and no place for one to be forgotten. */
export interface BakedKey {
  readonly time: number;
  readonly value: Vec3;
}

/**
 * Emit the baked channels for ONE bone.
 *
 * A component with no keys is omitted rather than emitted empty: the resolver
 * treats PRESENCE as the signal that a baked channel owns that component, so an
 * empty channel would claim a component it cannot drive and would silently
 * suppress the clip track underneath it.
 *
 * @param state live DAG state — read for the idempotency guard only.
 */
export function bakeChannelOpsForBone(args: {
  readonly assetRef: string;
  readonly childName: string;
  readonly byComponent: Partial<Record<BakedComponent, readonly BakedKey[]>>;
  readonly state: DagState;
  /** #913 — does the SOURCE these keys were copied from repeat past its end?
   *
   *  Same producer-vs-consumer distinction as the `easing` field below, on the
   *  time axis instead of the value axis. A channel's schema default is `hold`,
   *  which is right for a curve a director drew from nothing and wrong for a
   *  frame-by-frame copy of a LOOPING clip: the clip wraps at its duration and
   *  the copy would stop dead, so the bone freezes after one cycle while its
   *  neighbours keep going. Stating the source's time domain is what keeps the
   *  copy indistinguishable from what it copied.
   *
   *  Optional and default-false, so the road that does not know its source's
   *  time domain emits exactly the params it emitted before. */
  readonly cyclic?: boolean;
}): Op[] {
  const { assetRef, childName, byComponent, state, cyclic = false } = args;
  const target = gltfChildDagId(assetRef, childName);
  const ops: Op[] = [];

  for (const component of BAKED_COMPONENTS) {
    const keys = byComponent[component];
    if (!keys || keys.length === 0) continue;

    const channelId = gltfChannelDagId(assetRef, childName, component);
    // V22 idempotency against LIVE state: re-baking the same bone adds nothing
    // and the content-addressed id never changes.
    if (state.nodes[channelId]) continue;

    ops.push({
      type: 'addNode',
      nodeId: channelId,
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: `${childName} — ${component}`,
        // BLOCK-2, the dual key: BOTH are mandatory. `target` is what
        // paramAnimationState matches on (the bone's selection id IS this
        // dagId); `childName` is what the renderer's enumerator reads directly,
        // so it needs no per-frame nodeNameMap inverse scan.
        target,
        childName,
        assetRef,
        paramPath: component,
        keyframes: keys.map((k) => ({
          time: k.time,
          value: k.value,
          // #877 — LINEAR, and it must be stated: the schema's own default is
          // 'cubic', so omitting this field would silently restore smoothstep.
          //
          // These keys are not hand-authored — they are a per-frame RESTATEMENT
          // of a clip whose sampler is raw `lerpVec3` (AnimationClip.ts:89-90,
          // TransformClip.ts:116-118) and whose keyframes cannot express easing
          // at all. Stamping the authored-curve default onto baked data made the
          // bake disagree with its own source between keyframes: identical at
          // every key, but up to |smoothstep(u) - u| = 1/(6*sqrt(3)) ~ 9.6% of
          // each interval away from it in between (8.5357 deg on a real clip).
          //
          // Same producer-vs-consumer distinction as #867: 'cubic' is right for
          // a curve a director drew, and wrong for a frame-by-frame copy.
          easing: 'linear' as const,
        })),
        // #913 — the source's time domain, expressed the way this project
        // decided to express cycling (#275 moved the repeat family out of the
        // extend enum and into a Cycles F-Modifier). `repeat` cycles the
        // channel's key range, which equals the clip's `[0, duration)` fold
        // whenever the seeded keys span the clip — true for every generated,
        // imported and retargeted clip, because they carry a key per frame.
        // Measured on Robot-Walk.basher: 78 of 78 bones span it exactly.
        //
        // The key is OMITTED rather than set to `[]` when the source does not
        // cycle, so a non-looping mint stays byte-identical to pre-#913.
        ...(cyclic ? { modifiers: [defaultModifier('cycles')] } : {}),
      },
    });
  }

  return ops;
}
