// The ONE emitter of baked per-bone `KeyframeChannelVec3` nodes for a glTF
// asset — shared by the two mutators that materialise motion onto a rig.
//
// Extracted when the second consumer arrived (the "2nd consumer justifies the
// module" retrofit this codebase already applies at D-06). Consumer 1 is
// `bakeGltfChannel`, whose source is the asset's OWN embedded TransformClip.
// Consumer 2 is `bakeClipOntoRig`, whose source is a retargeted `AnimationClip`
// that arrived from somewhere else entirely.
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
}): Op[] {
  const { assetRef, childName, byComponent, state } = args;
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
          // Mirrors KeyframeChannelVec3's own default for spatial channels.
          easing: 'cubic' as const,
        })),
      },
    });
  }

  return ops;
}
