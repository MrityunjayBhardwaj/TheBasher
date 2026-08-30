// Bind a just-imported motion clip to a character in the scene — the app-layer
// act that makes dropping a walk cycle onto a character animate the character
// (#807).
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT WAS ACTUALLY MISSING
// ─────────────────────────────────────────────────────────────────────────
// Nothing here is new capability. `mutator.animation.retarget` has bridged rigs
// since #100 and `mutator.animation.bakeClipOntoRig` has driven the renderer
// since #803, and neither had a caller anywhere in `src/app`. What was missing
// was the two decisions a director should never have to make by hand — WHICH
// character, and WHICH bone-name map — and the composition that turns them into
// one act. This module is those two decisions and that composition, and it is the
// same shape as `generateRiggedCharacter`: an app-layer action that composes
// existing capabilities and reports its own refusals.
//
// ─────────────────────────────────────────────────────────────────────────
// EVERY REFUSAL SAYS WHICH ONE IT IS
// ─────────────────────────────────────────────────────────────────────────
// Four different things can stop a binding, and they need four different
// answers, because "nothing moved" is the same observation for all of them:
//
//   no character   the scene has no rig at all. Not a failure — nothing was
//                  promised — but it IS the answer to "why didn't it move?".
//   ambiguous      several characters, and no selection to break the tie. The
//                  message names them, because the fix is one click.
//   no bridge      the two rigs share no vocabulary and no registered map spans
//                  them. The clip imported fine; it just cannot drive THIS rig.
//   rejected       a mutator gate refused. That is a real fault and goes to the
//                  persistent error surface, not to a toast that vanishes.
//
// Collapsing these into one "could not bind" would reproduce, at the app layer,
// exactly the defect the model-generation probe was fixed for: a single false
// that four situations fall into, leaving the director to guess which.
//
// Invariants honoured:
//   - V8: app-layer, no `src/viewport/` imports.
//   - K6: ONE atomic dispatch — retarget and bake land as a single Cmd+Z entry
//     via `dispatchRetargetThenBake`, never as two.
//   - V22: no Date.now / Math.random; the output clip id is derived from the pair.
//
// REF: src/app/animate/dispatchMutator.ts (`dispatchRetargetThenBake`);
//      src/core/import/chooseBoneNameMap.ts (the bridge decision);
//      src/app/asset/generateRiggedCharacter.ts (the composition this mirrors);
//      issues #807, #803, #100.

import { useDagStore } from '../../core/dag/store';
import { evaluate } from '../../core/dag/evaluator';
import { chooseBoneNameMap } from '../../core/import/chooseBoneNameMap';
import { dispatchRetargetThenBake } from '../animate/dispatchMutator';
import { useSelectionStore } from '../stores/selectionStore';
import { useNotificationStore } from '../stores/notificationStore';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import type { DagState } from '../../core/dag/state';
import type { BoneSpec, SkeletonValue } from '../../nodes/types';

/** Bind pose is import-time static, so any frame projects the same rig.
 *  Mirrors `retarget.ts` and `bakeClipOntoRig.ts`, which read it the same way. */
const BIND_POSE_CTX = { time: { frame: 0, seconds: 0, normalized: 0 } } as const;

export type BindMotionRefusal = 'no-character' | 'ambiguous' | 'no-bridge' | 'rejected';

export type BindMotionOutcome =
  | {
      readonly ok: true;
      readonly targetSkeletonId: string;
      readonly clipId: string;
      /** How the rigs were bridged — a preset's name, or 'matching bone names'. */
      readonly bridge: string;
      /** Bones placed, out of bones the clip carries. */
      readonly mapped: number;
      readonly total: number;
    }
  | { readonly ok: false; readonly refusal: BindMotionRefusal; readonly reason: string };

/** A character the motion could drive: a rig node with bones, and the asset it projects. */
interface Candidate {
  readonly skeletonId: string;
  readonly assetRef: string;
  readonly boneNames: string[];
  readonly label: string;
}

/** A readable name for a character, from the OPFS path its asset was imported under. */
export function labelForAssetRef(assetRef: string): string {
  const base = assetRef.split('/').filter(Boolean).pop() ?? assetRef;
  return base.replace(/\.[^.]+$/, '') || base;
}

/** The `assetRef` of the `GltfAsset` a `GltfSkeleton` projects. */
function assetRefOfSkeleton(state: DagState, skeletonId: string): string | null {
  const socket = state.nodes[skeletonId]?.inputs?.asset;
  if (!socket) return null;
  const one = Array.isArray(socket) ? socket[0] : socket;
  const asset = one?.node ? state.nodes[one.node] : undefined;
  const ref = (asset?.params as { assetRef?: unknown } | undefined)?.assetRef;
  return typeof ref === 'string' && ref.length > 0 ? ref : null;
}

/**
 * Every character in the scene that could receive motion.
 *
 * A rig node with NO bones is excluded rather than reported as a candidate that
 * happens to fail later: it projects a skin the asset does not carry, so it is
 * not a character the director could have meant.
 */
export function motionTargetCandidates(state: DagState): Candidate[] {
  const out: Candidate[] = [];
  for (const node of Object.values(state.nodes)) {
    if (node.type !== 'GltfSkeleton') continue;
    const assetRef = assetRefOfSkeleton(state, node.id);
    if (!assetRef) continue;
    const value = evaluate(state, node.id, { ctx: BIND_POSE_CTX }).value as SkeletonValue;
    const bones = value?.kind === 'Skeleton' ? value.bones : [];
    if (bones.length === 0) continue;
    out.push({
      skeletonId: node.id,
      assetRef,
      boneNames: bones.map((b) => b.name),
      label: labelForAssetRef(assetRef),
    });
  }
  // Stable order (V22): id-sorted, so an ambiguity message names the candidates
  // in the same order every time rather than in object-key order.
  return out.sort((a, b) => (a.skeletonId < b.skeletonId ? -1 : 1));
}

/**
 * Which `assetRef`s the current selection points at.
 *
 * The outliner selects the import Group for a character (#222 made the Group the
 * transformable import root), and the Group carries no `assetRef` of its own — so
 * matching on `params.assetRef` alone would find nothing for the most common
 * selection a director can make. Walking a bounded two levels up the input edges
 * reaches the `GltfAsset` from the Group, from a `GltfChild` bone, and from the
 * rig node itself, without turning into an unbounded graph search.
 */
export function selectedAssetRefs(state: DagState, selectedNodeId: string | null): Set<string> {
  const refs = new Set<string>();
  if (!selectedNodeId) return refs;
  const visit = (nodeId: string, depth: number): void => {
    const node = state.nodes[nodeId];
    if (!node || depth > 2) return;
    const ref = (node.params as { assetRef?: unknown } | undefined)?.assetRef;
    if (typeof ref === 'string' && ref.length > 0) refs.add(ref);
    for (const socket of Object.values(node.inputs ?? {})) {
      const conns = Array.isArray(socket) ? socket : socket ? [socket] : [];
      for (const conn of conns) if (conn?.node) visit(conn.node, depth + 1);
    }
  };
  visit(selectedNodeId, 0);
  return refs;
}

/**
 * Choose the character this motion should drive.
 *
 * One candidate means one answer, selection or not — asking a director to select
 * the only character in the scene is a rule with nothing to disambiguate. Two or
 * more, and the selection decides. Neither resolvable is a refusal that NAMES the
 * candidates, because the difference between "nothing happened" and "pick one of
 * these two" is the whole of what the director needs.
 */
export function chooseMotionTarget(
  state: DagState,
  selectedNodeId: string | null,
): { ok: true; target: Candidate } | { ok: false; refusal: BindMotionRefusal; reason: string } {
  const candidates = motionTargetCandidates(state);
  if (candidates.length === 0) {
    return {
      ok: false,
      refusal: 'no-character',
      reason: 'Imported the motion — there is no character in the scene for it to drive yet.',
    };
  }
  if (candidates.length === 1) return { ok: true, target: candidates[0] };

  const refs = selectedAssetRefs(state, selectedNodeId);
  const selected = candidates.filter((c) => refs.has(c.assetRef));
  if (selected.length === 1) return { ok: true, target: selected[0] };

  return {
    ok: false,
    refusal: 'ambiguous',
    reason:
      'Imported the motion — select the character it should drive, then drop it again. ' +
      `In the scene: ${candidates.map((c) => c.label).join(', ')}.`,
  };
}

/** The retargeted clip's id — derived from the PAIR, so the same clip can drive
 *  two different characters without the second binding overwriting the first. */
export function retargetedClipId(sourceClipId: string, targetSkeletonId: string): string {
  return `${sourceClipId}_on_${targetSkeletonId}`;
}

/**
 * Put an imported motion clip onto a character, and make it show in the render.
 *
 * Reports its own outcome — a refusal reaches a toast, a fault reaches the
 * persistent error banner — and ALSO returns it, so the decision is testable
 * without a DOM. A fallible action that returned void would be the trap this
 * codebase has already paid for twice.
 */
export function bindMotionToCharacter(source: {
  clipId: string;
  skeletonId: string;
}): BindMotionOutcome {
  const notify = useNotificationStore.getState().notify;
  const state = useDagStore.getState().state;

  const chosen = chooseMotionTarget(state, useSelectionStore.getState().selectedNodeId);
  if (!chosen.ok) {
    notify({ severity: 'warn', message: chosen.reason });
    return { ok: false, refusal: chosen.refusal, reason: chosen.reason };
  }
  const target = chosen.target;

  const sourceBones =
    (state.nodes[source.skeletonId]?.params as { bones?: BoneSpec[] } | undefined)?.bones ?? [];
  const bridge = chooseBoneNameMap(
    sourceBones.map((b) => b.name),
    target.boneNames,
  );
  if (!bridge) {
    const reason =
      `Imported the motion, but its bones share no naming with ${target.label}'s rig, ` +
      'so there is no way to map one onto the other.';
    notify({ severity: 'warn', message: reason });
    return { ok: false, refusal: 'no-bridge', reason };
  }

  const outputClipId = retargetedClipId(source.clipId, target.skeletonId);
  const result = dispatchRetargetThenBake({
    sourceClipId: source.clipId,
    sourceSkeletonId: source.skeletonId,
    targetSkeletonId: target.skeletonId,
    mapPresetId: bridge.presetId,
    customMap: bridge.customMap,
    outputClipId,
    outputName: `${target.label} motion`,
  });
  if (!result.ok) {
    // A gate refused. That is a fault in the graph, not a choice the director
    // made, so it goes to the surface that PERSISTS until something changes.
    useAssetErrorStore
      .getState()
      .report(target.assetRef, `could not bind motion: ${formatAssetError(result.reason)}`);
    return { ok: false, refusal: 'rejected', reason: result.reason };
  }

  // The count is in the message on purpose. "Bound" alone cannot be told apart
  // from "bound two bones out of seventy-eight", and those look identical in the
  // viewport until someone plays the clip and watches a wrist move alone.
  notify({
    severity: 'success',
    message: `${target.label} is now driving ${bridge.mapped} of ${bridge.total} bones (${bridge.label}).`,
  });
  return {
    ok: true,
    targetSkeletonId: target.skeletonId,
    clipId: outputClipId,
    bridge: bridge.label,
    mapped: bridge.mapped,
    total: bridge.total,
  };
}
