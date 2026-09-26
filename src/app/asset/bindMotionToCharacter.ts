// Bind a just-imported motion clip to a character in the scene — the app-layer
// act that makes dropping a walk cycle onto a character animate the character
// (#807).
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT WAS ACTUALLY MISSING
// ─────────────────────────────────────────────────────────────────────────
// Nothing here is new capability. `mutator.animation.retarget` has bridged rigs
// since #100 and had no caller anywhere in `src/app`. What was missing was the
// two decisions a director should never have to make by hand — WHICH character,
// and WHICH bone-name map — and the act that turns them into one gesture. This
// module is those two decisions, and it is the same shape as
// `generateRiggedCharacter`: an app-layer action that composes an existing
// capability and reports its own refusals.
//
// 🔑 BINDING CREATES NO CHANNELS, AND THAT IS THE POINT (#889). Until slice 3
// this dispatched retarget AND `bakeClipOntoRig`, which materialised a
// `KeyframeChannelVec3` for every bone on the rig — 46 of them for 23 bones on
// `Robot-Walk.basher`, not one authored by anybody. The read band reaches a
// bound clip directly (#888), so those channels were a duplicate of what the
// clip already produced: measured on that project, stripping all 46 leaves the
// same 23 bones driven and the sampled rotations agree to 6e-14. A bone gets a
// channel when somebody EDITS it, and not before.
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
//   - K6: ONE atomic dispatch — the retarget is a single Cmd+Z entry.
//   - V22: no Date.now / Math.random; the output clip id is derived from the pair.
//
// REF: src/app/animate/dispatchMutator.ts (`dispatchMutatorFromUI`);
//      src/core/import/chooseBoneNameMap.ts (the bridge decision);
//      src/app/asset/generateRiggedCharacter.ts (the composition this mirrors);
//      issues #807, #889, #803, #100.

import { useDagStore } from '../../core/dag/store';
import { chooseBoneNameMap } from '../../core/import/chooseBoneNameMap';
import { standInObjectOf, standingObjectsOf } from '../../core/import/skeletonObject';
import { dispatchMutatorFromUI } from '../animate/dispatchMutator';
import { edgeTarget } from '../animate/graphNodes';
import { nodeDisplayName } from '../sceneTreeWalk';
import { useSelectionStore } from '../stores/selectionStore';
import { useNotificationStore, type ToastSeverity } from '../stores/notificationStore';
import { formatAssetError, useAssetErrorStore } from '../stores/assetErrorStore';
import type { DagState } from '../../core/dag/state';
import type { BoneSpec } from '../../nodes/types';

export type BindMotionRefusal = 'no-character' | 'ambiguous' | 'no-bridge' | 'rejected';

/**
 * How the clip got here (#823). REQUIRED, not defaulted.
 *
 * The refusals below were written for the drop road and said so. Since #820 a
 * generated clip takes the same continuation, and three of them became reachable
 * from a road where the wording is wrong — one telling a director who had typed
 * a sentence to "drop it again", an instruction with no gesture behind it.
 *
 * 🔑 THE SMALLEST THING THAT VARIES, AND NOT A SENTENCE. Letting each caller
 * supply its own phrasing recreates exactly the divergence a shared bind exists
 * to prevent, and the third road would arrive with a third wording. What varies
 * between roads is a verb and a retry gesture; the refusal still composes its own
 * message, so every road keeps one voice and there is one place to change it.
 *
 * Required rather than defaulted for the same reason: a new road that forgets to
 * say how its clip arrived should not silently inherit "Imported".
 */
export type MotionArrival = 'imported' | 'generated';

const ARRIVAL: Record<MotionArrival, { readonly verb: string; readonly retry: string }> = {
  imported: { verb: 'Imported', retry: 'drop it again' },
  // "generate again" is a gesture that exists: the director typed a sentence to
  // get here and can select a character and type it again. Naming a gesture that
  // does not exist is the defect this fixes, so the replacement has to be real.
  generated: { verb: 'Generated', retry: 'generate again' },
};

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

/**
 * A character the motion could drive (#1213): the rig the retarget targets, and the armature Object
 * whose pose it becomes. (The clone road's rigs — a `GltfSkeleton` standing no Object, posed by its
 * active clip — answered here too until that road's character half retired, #1053.)
 */
export interface Candidate {
  readonly skeletonId: string;
  readonly objectId: string;
  readonly boneNames: string[];
  readonly label: string;
}

/** A readable name for a character, from the OPFS path its asset was imported under. */
export function labelForAssetRef(assetRef: string): string {
  const base = assetRef.split('/').filter(Boolean).pop() ?? assetRef;
  return base.replace(/\.[^.]+$/, '') || base;
}

/**
 * Every character in the scene that could receive motion — the ONE character query (#1213).
 *
 * A character is a rig that deforms a mesh (user decision, 2026-09-25). Natively that is an armature
 * Object some mesh's Armature modifier points at (#393) — so a motion's own rig, a BVH/FBX/generated
 * skeleton standing as an Object with nothing skinned to it, is never a target, and a second walk
 * dropped beside the first does not chain onto it. A rig with NO bones is excluded rather than reported
 * as a candidate that fails later, because it is not a character the director could have meant.
 */
export function characterTargets(state: DagState): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const node of Object.values(state.nodes)) {
    if (node.type !== 'ArmatureModifier') continue;
    const objectId = edgeTarget(node, 'armature');
    const object = objectId ? state.nodes[objectId] : undefined;
    if (!objectId || object?.type !== 'Object' || seen.has(objectId)) continue;
    const skeletonId = edgeTarget(object, 'data');
    if (!skeletonId || state.nodes[skeletonId]?.type !== 'Skeleton') continue;
    const bones =
      (state.nodes[skeletonId].params as { bones?: BoneSpec[] } | undefined)?.bones ?? [];
    if (bones.length === 0) continue;
    seen.add(objectId);
    out.push({
      skeletonId,
      objectId,
      boneNames: bones.map((b) => b.name),
      label: nodeDisplayName(state.nodes, objectId),
    });
  }
  // Stable order (V22): sorted by the node that IS the character, so an ambiguity message names
  // the candidates in the same order every time rather than in object-key order.
  return out.sort((a, b) => (a.objectId < b.objectId ? -1 : 1));
}

/**
 * The nodes a selection reaches by walking up input edges, a bounded three levels (#1213): the armature
 * Object itself, the skinned mesh's Object (data → Armature modifier → armature), and the Object the
 * import hangs both under (children → mesh Object → modifier → armature). Bounded so it never turns
 * into a search of the graph.
 */
function reachedFromSelection(state: DagState, selectedNodeId: string): Set<string> {
  // Breadth-first, so each node is expanded at the SHALLOWEST depth it is reached: a depth-first walk
  // that met a node deep first would never expand it again from a shorter path.
  const reached = new Set<string>([selectedNodeId]);
  let frontier = [selectedNodeId];
  for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      for (const socket of Object.values(state.nodes[nodeId]?.inputs ?? {})) {
        const conns = Array.isArray(socket) ? socket : socket ? [socket] : [];
        for (const conn of conns) {
          if (!conn?.node || reached.has(conn.node) || !state.nodes[conn.node]) continue;
          reached.add(conn.node);
          next.push(conn.node);
        }
      }
    }
    frontier = next;
  }
  return reached;
}

/** Does the selection point at this character? */
function selectionPicks(
  state: DagState,
  selectedNodeId: string | null,
  candidate: Candidate,
): boolean {
  return (
    selectedNodeId !== null && reachedFromSelection(state, selectedNodeId).has(candidate.objectId)
  );
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
 * The Object standing this skeleton in the scene, or null when none does.
 *
 * The import's own Object first — the one the retarget's hide names (`standInObjectOf`,
 * #1088), so a message naming it names the Object a bind would hide. Without it, any
 * Object whose `data` is the skeleton still says where the motion is, id-sorted (V22) so
 * a skeleton two Objects show is named the same way every time. Null when nothing stands:
 * a project with no scene aggregator, or a motion with no bones to draw.
 */
export function standingObjectOf(state: DagState, skeletonId: string): string | null {
  // The shared lookups, so the Object named here is one path placement moves (#1100).
  return standInObjectOf(state, skeletonId) ?? standingObjectsOf(state, skeletonId)[0] ?? null;
}

/**
 * Choose the character this motion should drive.
 *
 * One candidate means one answer, selection or not — asking a director to select
 * the only character in the scene is a rule with nothing to disambiguate. Two or
 * more, and the selection decides. Neither resolvable is a refusal that NAMES the
 * candidates, because the difference between "nothing happened" and "pick one of
 * these two" is the whole of what the director needs.
 *
 * `sourceSkeletonId` is REQUIRED for the same reason `arrival` is (#1103): whether
 * "no character" is news or a problem depends on whether the motion already
 * stands in the scene, and a caller that could leave it out, or pass nothing,
 * would silently get the warning back.
 */
export function chooseMotionTarget(
  state: DagState,
  selectedNodeId: string | null,
  arrival: MotionArrival,
  sourceSkeletonId: string,
):
  | { ok: true; target: Candidate }
  | { ok: false; refusal: BindMotionRefusal; reason: string; severity: ToastSeverity } {
  const { verb, retry } = ARRIVAL[arrival];
  // The motion's own rig is never its target: a bind hides it (#1056).
  const candidates = characterTargets(state).filter((c) => c.skeletonId !== sourceSkeletonId);
  if (candidates.length === 0) {
    // #1103 — since #1056 (files) and #1078 (generation) a motion with no character
    // is not left with nothing: its skeleton stands in the scene as an Object. So
    // when that Object is there, the message says where the motion is, and it is a
    // notice, because nothing went wrong. When it is not, nothing visible happened
    // and the warning stays.
    const standing = standingObjectOf(state, sourceSkeletonId);
    if (standing !== null) {
      return {
        ok: false,
        refusal: 'no-character',
        severity: 'info',
        reason:
          `${verb} the motion — it stands in the scene as ` +
          `${nodeDisplayName(state.nodes, standing)} until a character is added to play it.`,
      };
    }
    return {
      ok: false,
      refusal: 'no-character',
      severity: 'warn',
      reason: `${verb} the motion — there is no character in the scene for it to drive yet.`,
    };
  }
  if (candidates.length === 1) return { ok: true, target: candidates[0] };

  const selected = candidates.filter((c) => selectionPicks(state, selectedNodeId, c));
  if (selected.length === 1) return { ok: true, target: selected[0] };

  return {
    ok: false,
    refusal: 'ambiguous',
    severity: 'warn',
    reason:
      `${verb} the motion — select the character it should drive, then ${retry}. ` +
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
export function bindMotionToCharacter(
  source: {
    clipId: string;
    skeletonId: string;
  },
  arrival: MotionArrival,
): BindMotionOutcome {
  const notify = useNotificationStore.getState().notify;
  const state = useDagStore.getState().state;

  const chosen = chooseMotionTarget(
    state,
    useSelectionStore.getState().selectedNodeId,
    arrival,
    source.skeletonId,
  );
  if (!chosen.ok) {
    notify({ severity: chosen.severity, message: chosen.reason });
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
      `${ARRIVAL[arrival].verb} the motion, but its bones share no naming with ` +
      `${target.label}'s rig, so there is no way to map one onto the other.`;
    notify({ severity: 'warn', message: reason });
    return { ok: false, refusal: 'no-bridge', reason };
  }

  const outputClipId = retargetedClipId(source.clipId, target.skeletonId);
  const outputName = `${target.label} motion`;
  const result = dispatchMutatorFromUI(
    'mutator.animation.retarget',
    {
      sourceClipId: source.clipId,
      sourceSkeletonId: source.skeletonId,
      targetSkeletonId: target.skeletonId,
      ...(bridge.presetId ? { mapPresetId: bridge.presetId } : {}),
      ...(bridge.customMap ? { customMap: bridge.customMap } : {}),
      // #1213 — the Object whose pose the retarget becomes; a clone-road rig stands none.
      ...(target.objectId !== null ? { targetObjectId: target.objectId } : {}),
      outputClipId,
      outputName,
    },
    `Bind motion to rig: ${outputName}`,
  );
  if (!result.ok) {
    // A gate refused. That is a fault in the graph, not a choice the director
    // made, so it goes to the surface that PERSISTS until something changes.
    // Keyed by the asset on the clone road and by the character's Object natively.
    useAssetErrorStore
      .getState()
      .report(target.objectId, `could not bind motion: ${formatAssetError(result.reason)}`);
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
