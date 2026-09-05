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
import { assetRefForChild, parseClipRowId } from './bakeOnEdit';
import { paramAnimationState, type ParamAnimationState } from './paramAnimationState';
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

/** The TRS components a `GltfChild` bone carries as params. */
const BONE_PARAM_PATHS = new Set<string>(['position', 'rotation', 'scale']);

/**
 * The bone address for `(nodeId, paramPath)`, or null when that pair is not a
 * glTF bone's TRS component.
 *
 * The caller uses it to choose the channel-authoring road. A bone is NOT an
 * ordinary node here: its channel id is content-addressed and it carries the
 * dual `target` / `childName` / `assetRef` key the renderer's enumerator reads.
 * `addChannel`'s generic `<target>_<paramPath>_channel` would produce a channel
 * that shows in the dopesheet and drives nothing — which is the failure the
 * first-key path would have silently taken for every unedited bone once the
 * eager bake stops making channels for them.
 */
export function boneComponentAddress(
  state: DagState,
  nodeId: string,
  paramPath: string,
): { assetRef: string; childName: string; component: BakedComponent } | null {
  if (!BONE_PARAM_PATHS.has(paramPath)) return null;
  const node = state.nodes[nodeId];
  if (!node || node.type !== 'GltfChild') return null;
  const p = node.params as { assetRef?: unknown; childName?: unknown } | undefined;
  if (typeof p?.assetRef !== 'string' || p.assetRef.length === 0) return null;
  if (typeof p?.childName !== 'string' || p.childName.length === 0) return null;
  return { assetRef: p.assetRef, childName: p.childName, component: paramPath as BakedComponent };
}

/**
 * The components an `AnimationClip` can drive.
 *
 * NOT all three: `AnimationClipParams.keyframes` carries `position` and
 * `rotation` and no scale (`AnimationClip.ts` schema), and the read band
 * supplies exactly those two for exactly that reason — claiming scale would
 * suppress the asset's own scale track underneath it. So a clip-driven bone's
 * scale is honestly un-animated, and saying otherwise would be the same lie in
 * the other direction.
 */
const CLIP_DRIVEN_COMPONENTS: ReadonlySet<string> = new Set(['position', 'rotation']);

/**
 * The animation state a READ-ONLY INDICATOR should show for `(nodeId, paramPath)`
 * — the authored-channel state, widened by "and a bound clip drives this bone".
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SECOND FUNCTION RATHER THAN A WIDER `paramAnimationState`
 * ─────────────────────────────────────────────────────────────────────────
 * There are two questions here and copy-on-write is what pulled them apart.
 * While an eager bake gave every bone a channel they had the same answer, so
 * one function could serve both; now they differ on every bone nobody edited.
 *
 *   "is there an AUTHORED CHANNEL for this param?"  → `paramAnimationState`
 *   "does ANYTHING animate this param?"             → here
 *
 * Every one of `paramAnimationState`'s non-display callers wants the FIRST, and
 * censused rather than assumed:
 *   - `ParamDiamond`'s own delete path — it addresses a channel and its comment
 *     says so: the id form "works here only because `animState !== 'none'`
 *     already proved a channel exists". Widening that value in place would arm
 *     a delete on a bone with nothing of its own to delete.
 *   - `routeAnimatedGrab` — routes a gizmo grab to the transient/Auto-Key road
 *     instead of a raw setParam. A clip-driven bone's raw setParam becomes a
 *     MANUAL OVERRIDE, which outranks the clip in the resolver's precedence
 *     (manual → baked → clip → base) and is a deliberate, shipped gesture.
 *   - `autoKeyCommit` / `keyParamFromTransient` — both consult it only in the
 *     arm below `if (bone)`, which a glTF bone never reaches.
 *   - `isApplySourceAnimated` — asks only about pairs it already found a
 *     channel node for, so it cannot see this widening at all.
 *
 * So this is not a parallel answer to one question ([[V101]]); it is the wider
 * of two questions, composed FROM the narrower one, with one home each.
 *
 * REF: `src/app/bakedGltfChannels.ts` (`clipBandSamplersForAsset`, the band this
 *      agrees with); `src/app/resolveGltfChildTransform.ts` (the precedence);
 *      issues #908, #889.
 */
export function paramAnimationDisplayState(
  state: DagState,
  nodeId: string,
  paramPath: string,
  currentFrame: number,
): ParamAnimationState {
  const authored = paramAnimationState(state, nodeId, paramPath, currentFrame);
  // An authored channel outranks the clip here for the same reason it does in
  // the band: it IS the bone's track once it exists. `on-key` therefore stays a
  // statement about the director's OWN keys, never about the clip's.
  if (authored !== 'none') return authored;

  const bone = boneComponentAddress(state, nodeId, paramPath);
  if (!bone || !CLIP_DRIVEN_COMPONENTS.has(bone.component)) return 'none';
  // Deliberately never 'on-key': a clip key is not the director's to remove —
  // the clip is read-only and shared, and yellow reads as "click to unkey".
  return animationClipCarriesBone(state, bone.assetRef, bone.childName) ? 'animated' : 'none';
}

/** A channel a keyboard edit is about to write to, and what it will hold. */
export interface RowChannelWrite {
  readonly channelId: string;
  /** Empty when the channel is already there. */
  readonly mintOps: readonly Op[];
  /** The params the channel WILL have — from the mint when it is about to be
   *  created, so an insert lands ON the clip's track rather than replacing it,
   *  and so a caller that needs to SAMPLE the channel has the extrapolation and
   *  modifier fields too, not just the keys. */
  readonly params: Record<string, unknown>;
  readonly nodeType: string;
}

/**
 * Resolve the timeline's active row id — a real channel id, or a synthetic
 * `clip:<childName>:<component>` one — into the channel a write lands on.
 *
 * The synthetic form is why this exists. A read-only clip row has no DAG node,
 * so every keyboard path bailed on it: `buildKeyframeInsertOp` and
 * `buildKeyframeDeleteOp` both `return null` when `state.nodes[channelId]` is
 * missing, which was correct while an eager bake meant it never was, and is a
 * silent no-op on 22 of 23 bones once the bake stops. The key IS reachable —
 * TimelineCanvas calls `setActiveKeyframe` with the `clip:` id on a read-only
 * row — so the director presses Delete and nothing happens.
 */
export function resolveRowChannelForWrite(
  state: DagState,
  rowChannelId: string,
): RowChannelWrite | null {
  const clip = parseClipRowId(rowChannelId);
  if (!clip) {
    const live = state.nodes[rowChannelId];
    if (!live) return null;
    return {
      channelId: rowChannelId,
      mintOps: [],
      params: (live.params ?? {}) as Record<string, unknown>,
      nodeType: live.type,
    };
  }

  const assetRef = assetRefForChild(state.nodes, clip.childName);
  if (!assetRef) return null;
  const mint = clipRowMintOps(state, assetRef, clip.childName, clip.component);
  if (!mint.ok) return null;
  const channelId = gltfChannelDagId(assetRef, clip.childName, clip.component);
  const fromMint = mint.ops.find((op) => op.type === 'addNode' && op.nodeId === channelId);
  if (fromMint && fromMint.type === 'addNode') {
    return {
      channelId,
      mintOps: mint.ops,
      params: (fromMint.params ?? {}) as Record<string, unknown>,
      nodeType: fromMint.nodeType,
    };
  }
  // The mint emitted nothing for this component: the channel is already there
  // and the row id was simply stale (the suppression that hides a clip row once
  // its component is authored is recomputed on the next render).
  const live = state.nodes[channelId];
  if (!live) return null;
  return {
    channelId,
    mintOps: [],
    params: (live.params ?? {}) as Record<string, unknown>,
    nodeType: live.type,
  };
}
