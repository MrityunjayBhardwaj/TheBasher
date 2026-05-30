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
//      src/timeline/clipChannelRows.ts (activeClipKeyframesForAsset, the clip
//        walk); src/app/bakedGltfChannels.ts (the resolver enumeration that
//        consumes the baked channels); vyapti V20/V22/H36 (single writer).

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { gltfChannelDagId, gltfChildDagId } from '../../../core/import/gltfImportChain';
import { activeClipKeyframesForAsset } from '../../../timeline/clipChannelRows';

const BakeGltfChannelSpec = z.object({
  /** The owning GltfAsset's assetRef. */
  assetRef: z.string().min(1),
  /** The bone's sanitised name key — the clip-track `targetNodeId` (R5). */
  childName: z.string().min(1),
});
export type BakeGltfChannelSpec = z.infer<typeof BakeGltfChannelSpec>;

/** The three TRS components baked, in stable order. */
const COMPONENTS = ['position', 'rotation', 'scale'] as const;

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
    // The bone (a GltfChild) must be in scope — see buildClosureSpec.
    requiredNodeTypes: ['GltfChild'],
    // The clip is untouched (D-02 coexist); the bake CREATES editable curves.
    preserves: ['animation'],
  },
  buildClosureSpec(spec): ClosureSpec {
    // Root on the bone's own dagId (a real node in the DAG). The baked channels
    // themselves are fresh addNodes (gate-3 isFreshAddNode), so they need no
    // closure membership. No edges to follow — the GltfChild is edge-less (R-1).
    return {
      rootSelectors: [gltfChildDagId(spec.assetRef, spec.childName)],
      followedEdges: [],
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
    if (child.type !== 'GltfChild') {
      return { ok: false, reason: `Node "${childId}" is ${child.type}; expected GltfChild.` };
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
    const target = gltfChildDagId(assetRef, childName);

    // R5: filter the active clip's keyframes to THIS bone by NAME, sort by time.
    const forChild = activeClipKeyframesForAsset(state.nodes, assetRef)
      .filter((k) => k.targetNodeId === childName)
      .slice()
      .sort((a, b) => a.time - b.time);

    const ops: Op[] = [];
    for (const component of COMPONENTS) {
      const channelId = gltfChannelDagId(assetRef, childName, component);
      // V22 idempotency: re-baking the same bone is a no-op for an existing
      // channel (same content-addressed id). Guard on the LIVE state so a
      // re-bake adds nothing and the ids stay stable.
      if (state.nodes[channelId]) continue;

      // Seed the channel's keyframes from the clip's per-component values. The
      // clip stores degrees for rotation (gltfImportChain radVec3ToDeg), and
      // KeyframeChannelVec3 is degrees too — no conversion (H40 no-jump: the
      // baked sample equals the clip track value at every key).
      const keyframes = forChild.map((k) => ({
        time: k.time,
        value: k[component] as [number, number, number],
        // cubic mirrors the KeyframeChannelVec3 default (spatial channels).
        easing: 'cubic' as const,
      }));

      ops.push({
        type: 'addNode',
        nodeId: channelId,
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: `${childName} — ${component}`,
          // BLOCK-2: BOTH keys, both mandatory.
          target, // = GltfChild dagId (paramAnimationState / D2 idempotency)
          childName, // = clip-track key (resolver enumeration, no inverse scan)
          assetRef, // scopes the channel to its asset
          paramPath: component,
          keyframes,
        },
      });
    }

    // R4: NO connect ops. The baked channels are edge-less satellites that
    // reach the bone via the resolver enumeration, never an AnimationLayer edge.
    return ops;
  },
};
