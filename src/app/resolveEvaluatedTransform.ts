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
import { layeredChannelValues } from './layeredChannels';
import { driverChannelValuesForTarget } from './paramDrivers';
import { resolveConstraintRotation, resolveConstraintPosition } from './nodeConstraints';
import { useTransientEditStore } from './stores/transientEditStore';

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

/**
 * Resolve the evaluated rendered transform for `selectedId` (the producing
 * node's own id — v0.7 #199 retired the AnimationLayer wrapper, so there is no
 * layer indirection). Pure: no store reads, caller passes `state`, `ctx`, and
 * the optional shared `cache`.
 *
 * Returns null on the identity-null path (selectedId is neither a rendered
 * scene child nor a GltfChild) — the caller falls back to the static
 * `node.params` value (today's behavior, no crash).
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

  // 4. Find the matching scene-child index: childRefs[i].node === selectedId
  //    (the producing node IS its own scene child — v0.7 #199 retired the
  //    AnimationLayer wrapper, so there is no layer-target indirection to match).
  let matchIdx = -1;
  for (let i = 0; i < value.scene.children.length; i++) {
    if (childRefs[i]?.node === selectedId) {
      matchIdx = i;
      break;
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

    // 4c. FOLLOWED-LIGHT branch (#343). A light is wired FLAT into scene.lights, never a
    //   scene child, so the index-correspondence walk above always misses it → this
    //   resolver returned null for a light, and its gizmo/inspector fell back to the RAW
    //   authored position. Once a light follows a path (the render road moves it), that
    //   raw position is stale — the displayed≠rendered (H40) hole. So: if the selection is
    //   a LIGHT that is actually followed, return the followed position (a flat light's
    //   local == world, so resolveConstraintPosition's null-parent path gives world
    //   directly — the camera road's contract). Gated tightly: an UNCONSTRAINED light still
    //   returns null → gizmo uses raw params, byte-identical; a followed CAMERA is excluded
    //   by the kind check (it keeps resolveCameraPoseAt); a followed mesh/Null/Group already
    //   matched the children walk above and never reaches here.
    let lightVal: unknown;
    try {
      lightVal = evaluate(state, selectedId, { cache, ctx }).value;
    } catch {
      lightVal = null;
    }
    if ((lightVal as { kind?: unknown } | null)?.kind === 'light') {
      const followed = resolveConstraintPosition(state, selectedId, ctx, cache);
      if (followed) {
        const lv = lightVal as { rotation?: unknown; scale?: unknown };
        return {
          position: followed,
          rotation: isVec3(lv.rotation) ? (lv.rotation as Vec3) : null,
          scale: isVec3(lv.scale) ? (lv.scale as Vec3) : null,
        };
      }
    }
    return null;
  }

  // 5. The matched scene child IS the producing node's evaluated value (v0.7
  //    #199 retired the AnimationLayer wrapper, so there is no patched clone to
  //    unwrap — the animation overlay below is the only "animated value" source).
  let child: SceneChild | null = value.scene.children[matchIdx];

  // v0.7 unification (#197/#199) — overlay free-floating DIRECT channels the SAME
  // way the render side (DirectChannelsR, SceneFromDAG) does: the SAME
  // overlayChannels primitive at the SAME ctx.time.seconds, BEFORE the transient
  // (channels → transient, one band, H40). The matched `child` is the RAW static
  // value — without this the gizmo/NPanel would read the authored pose while the
  // viewport renders the animated one (the #68/#77 displayed≠rendered class).
  // Empty → identity.
  if (child) {
    // #283 Phase 2 (E) — the SAME layered enumeration the render side uses
    // (SceneFromDAG's useLayeredChannels): bare direct channels AND strip-derived
    // channels, folded by the SAME overlayChannels. So a placed Strip's transform is
    // read == rendered (H40). Empty strip set → exactly the bare values (byte-identical).
    const directChannels = layeredChannelValues(state.nodes, selectedId);
    // #300 F2b — the READ side folds the SAME driver overlays the render side already
    // does (SceneFromDAG `useLayeredChannels` appends `driverChannelValuesForTarget`).
    // Without this, a driven position/rotation/scale RENDERS at the driven value while
    // the gizmo + inspector read the AUTHORED one — the displayed≠rendered H40 hole this
    // increment closes (render side-A == read side-B). ONE band, ONE `overlayChannels`,
    // both callers (V88/H40): a vec driver on `position` folds a Vec3 channel exactly as
    // a position keyframe channel does; a scalar driver on a channel folds a Number one.
    // The transform-source road inside `driverChannelValuesForTarget` may re-enter this
    // resolver for the CONTROLLER node — a different node, bounded by DAG acyclicity + the
    // G6 driver-cycle guard (a driver that reads back its own target is rejected at bind).
    const drivers = driverChannelValuesForTarget(state, selectedId, ctx, cache);
    const overlays = drivers.length > 0 ? [...directChannels, ...drivers] : directChannels;
    if (overlays.length > 0) {
      child = overlayChannels(child, overlays, 1, ctx.time.seconds);
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
  // transform boundary-pair e2e (C3). v0.7 #199: the transient is keyed by the
  // selected node directly — no AnimationLayer wrapper to unwrap (the render side
  // keys DirectChannelsR's transient by the same node id).
  child = overlayTransients(child, selectedId, useTransientEditStore.getState().edits);

  if (!child) return null;

  // 6. Read the transform off the (possibly unwrapped) child value.
  const c = child as unknown as {
    position?: unknown;
    rotation?: unknown;
    scale?: unknown;
  };
  if (!isVec3(c.position)) return null; // identity-null: not a transformable child
  let rotation = isVec3(c.rotation) ? (c.rotation as Vec3) : null;
  // #231 D — scale is the TRS band only; the legacy size-as-scale fallback is
  // retired (size is geometry, on a separate node). Mirror of getManipulable.
  const scale = isVec3(c.scale) ? (c.scale as Vec3) : null;

  // #204 (epic #201) — a Track-To constraint DERIVES this node's rotation from
  // its world position → the aim target ([[V58]]), so it OVERRIDES the
  // authored/animated rotation. Applying it here (the read side) keeps the gizmo
  // + inspector showing the SAME aim the renderer applies (read==render, H40) —
  // one band, two callers. Unconstrained nodes → null → rotation unchanged.
  const aim = resolveConstraintRotation(state, selectedId, ctx, cache);
  if (aim) rotation = aim;

  // #339 — a Follow-Path constraint DERIVES this node's position from a curve, so it
  // OVERRIDES the authored/animated position exactly as the aim overrides rotation. The
  // second band, resolved the same way at the same seam and applied by the same two
  // callers (here and ConstrainedR) — one band, two callers, read == render.
  const followed = resolveConstraintPosition(state, selectedId, ctx, cache);
  const position = followed ?? (c.position as Vec3);

  return { position, rotation, scale };
}
