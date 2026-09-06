// bakeGltfChannel Mutator — copy-on-write materialization of ONE imported glTF
// bone's TransformClip track into per-bone, editable KeyframeChannel node(s)
// (Phase 7.12 #108, Wave D / D1).
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT IT DOES
// ─────────────────────────────────────────────────────────────────────────
// Given `{ assetRef, childName }`, read the asset's ACTIVE TransformClip, filter
// its keyframes to this bone (`targetNodeId === childName`, the NAME key — R5),
// and emit THREE `KeyframeChannelVec3` addNode ops — the whole bone's TRS
// (position / rotation [degrees] / scale), each seeded from the clip track's
// per-component values at each clip time. Whole-bone (not per-component) keeps
// revert a single delete and the per-bone perf story ≤3 nodes/bone.
//
// ─────────────────────────────────────────────────────────────────────────
// R4 — THE CONSUMPTION-BRIDGE TRAP (the CONTEXT-named footgun): ZERO connects
// ─────────────────────────────────────────────────────────────────────────
// A GltfChild is an EDGE-LESS addressing satellite (R-1) — it has NO render
// input edge. So a baked channel must reach the bone via the renderer's
// resolver ENUMERATION (bakedChannelSamplersForAsset → resolveGltfChildTrs),
// NOT via an `AnimationLayer.animation` edge. The reflex from addChannel — wire
// the channel into a layer — would make it SHOW in the dopesheet but NOT drive
// the bone (the layer patches a SceneChild clone the GltfChild never consumes).
// Therefore this mutator emits NO connect ops at all: no `Time→channel.time`
// (the socket was dropped in D-04 / A4) and no `channel→layer.animation`. The
// channel nodes are inputless satellites, EXACTLY like the GltfChild nodes they
// drive — they survive the closure gate as fresh addNodes (validate gate-3
// `isFreshAddNode`).
//
// ─────────────────────────────────────────────────────────────────────────
// BLOCK-2 — THE DUAL KEY (store BOTH, both mandatory)
// ─────────────────────────────────────────────────────────────────────────
//   params.target    = the GltfChild dagId (gltfChildDagId(assetRef, childName))
//                      — REQUIRED for paramAnimationState (`p.target===nodeId`,
//                      the bone's selection id IS this dagId) AND for D2's
//                      "does a channel already exist for this bone?" idempotency.
//   params.childName = childName — REQUIRED so the resolver enumerator
//                      (bakedGltfChannels.ts) reads it directly, with no
//                      per-frame nodeNameMap inverse scan.
//   params.assetRef  = assetRef — scopes the channel to its owning asset.
// These three are declared on KeyframeChannelVec3Params (the DAG stores
// zod-PARSED params, so an undeclared key would be silently stripped).
//
// V22 (determinism): channel ids are content-addressed
// (gltfChannelDagId(assetRef, childName, component)); re-baking the same bone
// is idempotent — the build guards on `state.nodes[id]` and skips an existing
// channel, so the op set re-emitted is a subset and the ids never change.
//
// REF: PLAN 7.12 Wave D (D1, R4-bridge / BLOCK-2 / R5 / V22 / H36);
//      src/core/import/gltfImportChain.ts (gltfChildDagId/gltfChannelDagId);
//      src/timeline/clipChannelRows.ts (activeClipForAsset, the clip walk —
//        keys AND time domain as one answer, #916); src/app/bakedGltfChannels.ts
//        (the resolver enumeration that consumes the baked channels);
//        src/app/animate/ensureChannelForBone.ts (the sibling road, whose
//        `seedKeysFromClip` this mirrors); vyapti V20/V22/H36 (single writer).

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { gltfChildDagId } from '../../../core/import/gltfImportChain';
import { isImportedChild } from '../../../app/importedChild';
import { bakeChannelOpsForBone } from './bakeChannelOps';
import type { Vec3 } from '../../../nodes/types';
import { activeClipForAsset, activeClipKeyframesForAsset } from '../../../timeline/clipChannelRows';

const BakeGltfChannelSpec = z.object({
  /** The owning GltfAsset's assetRef. */
  assetRef: z.string().min(1),
  /** The bone's sanitised name key — the clip-track `targetNodeId` (R5). */
  childName: z.string().min(1),
});
export type BakeGltfChannelSpec = z.infer<typeof BakeGltfChannelSpec>;

export const bakeGltfChannelMutator: MutatorDefinition<BakeGltfChannelSpec> = {
  name: 'mutator.timeline.bakeGltfChannel',
  description:
    "Materialize an imported glTF bone's animation clip track into editable " +
    'per-bone KeyframeChannel nodes (copy-on-write). Given { assetRef, childName }, ' +
    'emits one KeyframeChannelVec3 per TRS component (position/rotation/scale), ' +
    'seeded from the clip. The channels carry the bone as params.target (the ' +
    'GltfChild dagId) and params.childName so the renderer resolver enumerates ' +
    'them; NO AnimationLayer edge is wired (the bone is edge-less). Deterministic, ' +
    'idempotent: re-baking the same bone is a no-op.',
  spec: BakeGltfChannelSpec,
  specExample: { assetRef: 'asset_abc', childName: 'bone_1' },
  contract: {
    // The bake emits ONLY fresh addNode ops (no edges). No edge kinds to walk.
    requiredEdges: [],
    // The bone must be in scope — see buildClosureSpec. #389 split the fused kind, so
    // the DISCRIMINATING type is the data half: after the split the bone's own node is an
    // ordinary `Object`, which every box, light and camera also is, and requiring that
    // would make this contract match anything posable. `GltfData` is what says "imported
    // child", and the closure follows `data` to reach it.
    requiredNodeTypes: ['GltfData'],
    // The clip is untouched (D-02 coexist); the bake CREATES editable curves.
    preserves: ['animation'],
  },
  buildClosureSpec(spec): ClosureSpec {
    // Root on the bone's own dagId (a real node in the DAG — the Object half inherits
    // it). The baked channels themselves are fresh addNodes (gate-3 isFreshAddNode), so
    // they need no closure membership.
    //
    // #389 — `followedEdges` was EMPTY, on the reasoning that a fused GltfChild is
    // edge-less (R-1). The bone is still edge-less as far as the SCENE goes, but it now
    // has exactly one edge: `data`, to the half that says which child it is. Gate 4 walks
    // the closure for `requiredNodeTypes`, so without this the mutator would reject
    // itself on every bone — with a message about a missing GltfData rather than about
    // the edge that was not followed.
    return {
      rootSelectors: [gltfChildDagId(spec.assetRef, spec.childName)],
      followedEdges: ['data'],
    };
  },
  preconditions(spec, _closure, state) {
    const childId = gltfChildDagId(spec.assetRef, spec.childName);
    const child = state.nodes[childId];
    if (!child) {
      return {
        ok: false,
        reason: `No GltfChild for assetRef="${spec.assetRef}" childName="${spec.childName}".`,
      };
    }
    if (!isImportedChild(state.nodes, childId)) {
      return {
        ok: false,
        reason: `Node "${childId}" is ${child.type}; expected an imported glTF child.`,
      };
    }
    // A clip track must exist for this bone — otherwise there is nothing to bake.
    const keyframes = activeClipKeyframesForAsset(state.nodes, spec.assetRef).filter(
      (k) => k.targetNodeId === spec.childName,
    );
    if (keyframes.length === 0) {
      return {
        ok: false,
        reason: `No active clip track for bone "${spec.childName}" (nothing to bake).`,
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const { assetRef, childName } = spec;

    // R5: filter the active clip's keyframes to THIS bone by NAME, sort by time.
    // The clip is taken as ONE answer — keys AND time domain — because taking
    // the first without the second is exactly how this road minted a copy that
    // stopped where its source wrapped (#916).
    const active = activeClipForAsset(state.nodes, assetRef);
    const forChild = (active?.keyframes ?? [])
      .filter((k) => k.targetNodeId === childName)
      .slice()
      .sort((a, b) => a.time - b.time);

    // The SHARED emitter (bakeChannelOps.ts) — consumer 1 of 2. The source
    // differs between consumers; everything downstream of it must not, because
    // the resolver enumerator recognises a channel by its id, its dual key and
    // its edge-lessness. See that module header.
    const ops: Op[] = bakeChannelOpsForBone({
      assetRef,
      childName,
      byComponent: {
        position: forChild.map((k) => ({ time: k.time, value: k.position as Vec3 })),
        rotation: forChild.map((k) => ({ time: k.time, value: k.rotation as Vec3 })),
        scale: forChild.map((k) => ({ time: k.time, value: k.scale as Vec3 })),
      },
      state,
      // #916 — the SOURCE's time domain, the half #913 taught the sibling road to
      // carry and this one did not. A cycling `TransformClip` wraps at its
      // duration; a channel minted from it used to hold, so the bone froze at
      // the end of the first cycle while the clip it came from kept going.
      //
      // 🔴 A DIVERGENCE PRESERVED ON PURPOSE (#930), NOT AN OVERSIGHT.
      // A cycling TransformClip mints a channel that TRAVELS (`cycle-offset`),
      // while the clip itself folds TIME — which replays identical frames and so
      // cycles IN PLACE. The two have therefore never agreed on this road, and
      // #930 deliberately did not resolve it: the tri-state vocabulary made the
      // mismatch *visible* (before, both were spelled by one boolean and neither
      // could say which it meant), but flipping the mint to match the clip would
      // silently change what every existing looping glTF import does at
      // playback. `bakeGltfChannel.test.ts` pins the shipped behaviour with a
      // stated rationale — "a root that covers ground must keep covering it" —
      // and that claim deserves to be re-decided in the open rather than
      // reversed as a side effect of a rename.
      //
      // So the mapping is explicit here rather than inherited: this carrier's
      // `cycle` means "wrap the time", and the channel minted from it keeps the
      // travelling extend it has always had.
      loop: active?.loop === 'cycle' ? 'cycle-offset' : 'hold',
    });

    // R4: NO connect ops. The baked channels are edge-less satellites that
    // reach the bone via the resolver enumeration, never an AnimationLayer edge.
    return ops;
  },
};
