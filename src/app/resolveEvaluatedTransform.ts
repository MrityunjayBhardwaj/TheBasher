// Resolve the EVALUATED rendered transform of a selected node — the single
// source of truth for "where the cube renders" — so the gizmo proxy can
// anchor to it instead of the static authored `node.params`.
//
// WHY this exists (issue #68 — gizmo ↔ evaluated-scene boundary):
//   Once a param is animated, `node.params.position` (the static authored
//   source) and the AnimationLayer's evaluated patched clone diverge.
//   `AnimationLayer.patchTarget` (AnimationLayer.ts:107-122) deep-clones the
//   target and writes the channel value at `paramPath` onto the CLONE — the
//   source node is NEVER mutated (the H34 mechanism). The rendered transform
//   lives in the evaluated wrapper output, not on the node. This is the
//   H22/H34 family: source/closure scope ≠ render reachability/evaluated value.
//
// The SceneFromDAG mirror (Chesterton — the resolver mechanism EXISTS):
//   `SceneFromDAG.tsx:88-142` already does the exact walk we need:
//   evaluate(state, outputs.render.node) once, then `value.scene.children[i]`
//   corresponds index-for-index with `sceneNode.inputs.children[i].node`
//   (childRefs). For an AnimationLayer scene child the rendered transform is
//   the patched clone at `value.scene.children[i].target`
//   (SceneFromDAG.tsx:379-381). We REUSE that correspondence; we do NOT invent
//   a parallel walk (issue #68 names a parallel walk / `evaluate(selectedId)`
//   in isolation as THE trap — that returns the box RAW value, not the clone).
//
// V8 file-location justification: this lives in `src/app/` because its
//   consumer (Gizmo.tsx, `src/app/`) and its unit test both sit in
//   `src/app/`-reach. Placing it in `src/viewport/` would force
//   `src/app/Gizmo.tsx` to import upward into the viewport tree — the exact
//   V8 violation the Gizmo header (Gizmo.tsx:22-23) guards against. This is
//   gizmo-binding logic, not scene composition.
//
// NodeRef-shape normalization (FLAG-B — addLayer.ts:101 is the owner):
//   `addLayer` writes the layer's `inputs.target` via
//   `Array.isArray(b) ? b : [b]` (addLayer.ts:101) — it can be a bare
//   `{node,socket}` OR an array of them. We normalize through that SAME shape
//   when testing layer-target membership; a bare-ref assumption would
//   silently miss a wrapped target and break select-by-box (D-01).
//
// Single-hop layer-membership limit: the P7 box→layer shape is one hop
//   (layer.inputs.target → box). We test the layer's direct `inputs.target`
//   refs only — we do NOT deep-recurse the input chain. This keeps the
//   resolver cheap (one evaluate from the render root, the shared evaluator
//   cache; no graph crawl). Deeper nesting is out of scope (D-08).
//
// REF: issue #68, CONTEXT D-01/D-05, hetvabhasa H22/H34, vyapti V1/V8/V20.

import { evaluate, type EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, NodeRef } from '../core/dag/types';
import type { GltfAssetValue, RenderOutputValue, SceneChild } from '../nodes/types';
import { resolveGltfChildTrs, type ChildTrs, type BakedChannel } from './resolveGltfChildTransform';
import { bakedChannelSamplersForAsset, sampleBakedChannel } from './bakedGltfChannels';
import { overlayTransients } from './overlayTransients';
import { overlayChannels } from '../nodes/overlayChannels';
import { directChannelValuesForTarget } from './nodeChannels';
import { useTransientEditStore } from './stores/transientEditStore';
import { resolveEditTargetId } from './animate/resolveEditTarget';

type Vec3 = [number, number, number];

export interface EvaluatedTransform {
  /** World/local position of the rendered child. Always present (a
   *  renderable SceneChild value carries it) or the resolver returns null. */
  position: Vec3;
  /** Degrees, as the params store rotation. null when the value carries none. */
  rotation: Vec3 | null;
  /** Explicit `.scale` wins; `.size` is the BoxMesh-style fallback (mirrors
   *  getManipulable Gizmo.tsx:69-76). null when neither is present. */
  scale: Vec3 | null;
}

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
}

/** Normalize an inputs binding through addLayer.ts:101's own shape:
 *  `Array.isArray(t) ? t : [t]`. Never assume a bare ref. */
function normalizeRefs(binding: unknown): NodeRef[] {
  if (binding == null) return [];
  return Array.isArray(binding) ? (binding as NodeRef[]) : [binding as NodeRef];
}

/**
 * Resolve the evaluated rendered transform for `selectedId` (the box id OR
 * its wrapping AnimationLayer id — D-01). Pure: no store reads, caller passes
 * `state`, `ctx`, and the optional shared `cache`.
 *
 * Returns null on the identity-null path (selectedId is neither a rendered
 * scene child nor a single-hop wrapped layer target) — the caller falls back
 * to the static `node.params` value (today's behavior, no crash).
 */
export function resolveEvaluatedTransform(
  state: DagState,
  selectedId: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): EvaluatedTransform | null {
  // 1. Render root.
  const target = state.outputs.render;
  if (!target) return null;

  // 2. Evaluate the render tree once (shared cache when provided — the same
  //    call SceneFromDAG already makes every render).
  let value: RenderOutputValue;
  try {
    const result = evaluate(state, target.node, { cache, ctx });
    value = result.value as RenderOutputValue;
  } catch {
    return null;
  }
  if (!value?.scene?.children) return null;

  // 3. Resolve the scene child-ref list EXACTLY as SceneFromDAG:91-110 —
  //    childRefs[i].node ↔ value.scene.children[i].
  const sceneRef = state.outputs.scene;
  const sceneNode = sceneRef ? state.nodes[sceneRef.node] : null;
  const childRefs =
    sceneNode && Array.isArray(sceneNode.inputs.children)
      ? (sceneNode.inputs.children as NodeRef[])
      : [];

  // 4. Find the matching scene-child index. Match when:
  //    (a) childRefs[i].node === selectedId (direct producer — box not
  //        wrapped, OR selectedId IS the layer post-addLayer rewire), OR
  //    (b) the scene child is an AnimationLayer whose layer node's
  //        `inputs.target` (normalized through addLayer.ts:101's shape)
  //        contains selectedId (select-by-box on a wrapped cube — D-01).
  let matchIdx = -1;
  for (let i = 0; i < value.scene.children.length; i++) {
    const refNode = childRefs[i]?.node;
    if (refNode === selectedId) {
      matchIdx = i;
      break;
    }
    const child = value.scene.children[i];
    if (child && child.kind === 'AnimationLayer' && refNode) {
      const layerNode = state.nodes[refNode];
      if (layerNode) {
        // Single-hop only: the layer's direct target refs (P7 box→layer
        // shape). No deep recursion (keeps it cheap; D-08).
        const targetRefs = normalizeRefs(layerNode.inputs.target);
        if (targetRefs.some((r) => r?.node === selectedId)) {
          matchIdx = i;
          break;
        }
      }
    }
  }
  if (matchIdx === -1) {
    // 4b. TRAILING glTF-child branch (P7.7 / #91 — purely additive, H40).
    //   A GltfChild id is NEITHER a top-level scene-child ref NOR a single-hop
    //   AnimationLayer target — it lives BY NAME inside a GltfAssetValue, so the
    //   index-correspondence match above (the box/AnimationLayer path) always
    //   misses it. This branch fires ONLY on that miss AND only when the node is
    //   a GltfChild, so the existing paths are never reordered or shadowed.
    //
    //   It layers the SAME way the renderer does (resolveGltfChildTrs, B1 — one
    //   precedence rule across renderer + resolver, V20): manual override (if
    //   overridden[field]) → active clip track → captured base. The base for a
    //   non-overridden field IS the child node's seeded param (A2 seeded it with
    //   the captured static base at import), so the child node serves as BOTH
    //   the override layer AND the base. The clip track comes from the owning
    //   GltfAsset's evaluated TransformClip.
    const selected = state.nodes[selectedId];
    if (selected?.type === 'GltfChild') {
      const cp = selected.params as {
        position?: unknown;
        rotation?: unknown;
        scale?: unknown;
        assetRef?: unknown;
        childName?: unknown;
        overridden?: { position: boolean; rotation: boolean; scale: boolean };
      };
      if (
        !isVec3(cp.position) ||
        !isVec3(cp.rotation) ||
        !isVec3(cp.scale) ||
        typeof cp.assetRef !== 'string' ||
        typeof cp.childName !== 'string' ||
        !cp.overridden
      ) {
        return null;
      }
      const childTrs: ChildTrs = {
        position: cp.position,
        rotation: cp.rotation,
        scale: cp.scale,
      };

      // Find the owning GltfAsset (matched by assetRef) and read its evaluated
      // TransformClip track for this child. Evaluation is best-effort: a missing
      // / unevaluable asset simply means "no clip layer" — the override or base
      // still resolves (the child node carries both).
      let clipTrack: ChildTrs | undefined;
      // P7.12 (#108, C3, BLOCK-1) — the read-side MUST layer the SAME
      // baked-channel band the renderer (C2) does, or a baked-then-edited bone
      // renders the baked value while the gizmo/NPanel show clip/base (the
      // #68/#77 displayed-≠-rendered second-surface class, H40). Use the SAME
      // shared enumerator (bakedGltfChannels) the renderer uses, sampled at the
      // SAME ctx.time.seconds the clip is sampled at on the line below.
      let bakedChannel: BakedChannel | undefined;
      for (const node of Object.values(state.nodes)) {
        if (node.type !== 'GltfAsset') continue;
        const ap = node.params as { assetRef?: unknown };
        if (ap.assetRef !== cp.assetRef) continue;
        try {
          const assetVal = evaluate(state, node.id, { cache, ctx }).value as GltfAssetValue;
          // P7.10 (#114): TransformClipValue carries `.sample(seconds)` instead
          // of a pre-baked `.tracks` map. Sample at the caller's ctx.time —
          // this resolver is the gizmo/NPanel static-read path, so the right
          // time is "the current play time" the caller passed in.
          clipTrack = assetVal.transformClip?.sample(ctx.time.seconds)[cp.childName];
          const bakedSamplers = bakedChannelSamplersForAsset(state.nodes, assetVal.nodeNameMap);
          bakedChannel = sampleBakedChannel(bakedSamplers[cp.childName], ctx.time.seconds);
        } catch {
          clipTrack = undefined;
          bakedChannel = undefined;
        }
        break;
      }

      const resolved = resolveGltfChildTrs({
        base: childTrs,
        clipTrack,
        childNode: { ...childTrs, overridden: cp.overridden },
        bakedChannel,
      });
      // The child always carries rotation + scale (seeded at import), so unlike
      // the box/size-fallback path these are never null. Copy into mutable
      // tuples — resolveGltfChildTrs returns readonly Vec3s (ChildTrs), the
      // EvaluatedTransform contract is the mutable local Vec3.
      return {
        position: [resolved.position[0], resolved.position[1], resolved.position[2]],
        rotation: [resolved.rotation[0], resolved.rotation[1], resolved.rotation[2]],
        scale: [resolved.scale[0], resolved.scale[1], resolved.scale[2]],
      };
    }
    return null;
  }

  // 5. Unwrap the AnimationLayer to the patched clone (the H34 mechanism —
  //    THIS is the animated value, NOT a re-evaluate of selectedId).
  //    P7.12 D-04 (H40 read-side parity): the layer's `target` is now the
  //    UN-PATCHED base (the channels are function-of-time). The renderer
  //    (AnimationLayerR) patches via sampleTarget(seconds) in a useFrame; the
  //    read-side MUST sample at the SAME ctx.time.seconds so the gizmo/NPanel
  //    evaluated transform equals what renders. Reading the eager `target`
  //    would show the static base while the viewport shows the animated clone
  //    (the #68/#77 displayed≠rendered class this resolver exists to prevent).
  let child: SceneChild | null = value.scene.children[matchIdx];
  if (child && child.kind === 'AnimationLayer') {
    child = child.sampleTarget(ctx.time.seconds);
  }

  // v0.7 unification (#197) — overlay free-floating DIRECT channels the SAME way
  // the render side (DirectChannelsR, SceneFromDAG) does: the SAME overlayChannels
  // primitive at the SAME ctx.time.seconds, BEFORE the transient (channels →
  // transient, one band, H40). For a direct-channeled box (not layer-wrapped) the
  // matched `child` above is the RAW static value — without this the gizmo/NPanel
  // would read the authored pose while the viewport renders the animated one (the
  // #68/#77 displayed≠rendered class). Layer-wired channels are EXCLUDED by the
  // coexistence guard (nodeChannels.ts), so a wrapped node — already overlaid via
  // the AnimationLayer unwrap above — is never double-applied. Empty → identity.
  if (child) {
    const directChannels = directChannelValuesForTarget(state.nodes, selectedId);
    if (directChannels.length > 0) {
      child = overlayChannels(child, directChannels, 1, ctx.time.seconds);
    }
  }

  // #149 C1 — overlay the held transient the SAME way the renderer does
  // (AnimationLayerR/B2): SAME overlayTransients primitive, SAME ctx.time.seconds
  // (transient > channel). This is the READ side of the H40 boundary-pair — the
  // gizmo proxy + NPanel transform display read THROUGH here, so they show
  // exactly the edit the viewport shows. The transient SET is read LIVE (like a
  // ctx, not a hook) — the one UI-store read in this otherwise-pure resolver,
  // justified by H40 (it MUST reflect the same live edit the subscribed render
  // reads). Empty store → identity (purity tests stay green). Gated by the PAUSED
  // transform boundary-pair e2e (C3).
  //
  // #160 — key the overlay by the EDIT TARGET, not the raw selection. The render
  // side (AnimationLayerR) keys the transient by the wrapped target id
  // (`animationTargetId`); when the selection IS the AnimationLayer (a viewport
  // click on a keyframed cube), the transient lives on the target — so the read
  // side must unwrap the same way or the gizmo proxy snaps back to the curve
  // value while the object holds the edit. Identity for a box/glTF selection
  // (resolveEditTargetId returns selectedId), so the C3 box case is unchanged.
  const overlayId = resolveEditTargetId(state, selectedId);
  child = overlayTransients(child, overlayId, useTransientEditStore.getState().edits);

  if (!child) return null;

  // 6. Read the transform off the (possibly unwrapped) child value.
  const c = child as unknown as {
    position?: unknown;
    rotation?: unknown;
    scale?: unknown;
    size?: unknown;
  };
  if (!isVec3(c.position)) return null; // identity-null: not a transformable child
  const rotation = isVec3(c.rotation) ? (c.rotation as Vec3) : null;
  // Mirror getManipulable:69-76 — explicit scale wins, then size fallback.
  const scale = isVec3(c.scale) ? (c.scale as Vec3) : isVec3(c.size) ? (c.size as Vec3) : null;

  return { position: c.position as Vec3, rotation, scale };
}
