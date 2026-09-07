// Put a generated motion where its path was drawn (#730, phase A2).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THE PLACEMENT LANDS HERE AND NOT ON THE CLIP
// ─────────────────────────────────────────────────────────────────────────
// The motion server canonicalises frame 0 to the origin before generating —
// that is a property of the model, not a setting (`authoring/constraints.py`:
// "Generation always canonicalises frame 0 to the origin") — and hands back the
// world XZ needed to put the motion back where it was asked for. Someone has to
// re-apply it, and WHICH node receives it is the whole decision.
//
// It is not the clip. Baking a world position into keyframes would make the clip
// carry a place: drop the same walk on a second character and it teleports to the
// first one's spot. `CurveData` already states the rule this obeys — "where the
// path sits in the world is a pose the Object owns".
//
// It is not a new node either. A glTF character already arrives with a root
// `Group` that exists to be the thing you move (#222 made it the transformable
// import root), and a BVH import deliberately emits no placement at all, because
// a Skeleton + AnimationClip is data. So the offset goes to the placement node
// that is already there, and the import road stays untouched.
//
// ─────────────────────────────────────────────────────────────────────────
// THE ARITHMETIC IS NOT position = offset
// ─────────────────────────────────────────────────────────────────────────
// A Group renders as `Translate(position)·R·S·Translate(-pivot)` (Group.ts), and
// the glTF import bakes `position = drop + pivot` with `pivot` = the model's bbox
// centre, so that the content stays put while the gizmo sits at the centre. The
// effective world translation is therefore `position - pivot`, NOT `position`.
//
// Writing `position = [x, _, z]` would move the character by the bbox centre as
// well as by the offset — wrong by however far the model's centre sits from its
// origin, which for a humanoid is about a metre of height and whatever asymmetry
// it has in XZ. Small enough to look plausible and large enough to be wrong. So
// this writes `position = pivot + offset` and leaves Y alone.
//
// Invariants honoured:
//   - V8: app-layer, no `src/viewport/` imports.
//   - V22: no Date.now / Math.random — the ops are a pure function of the graph.
//
// REF: src/nodes/Group.ts (the transform composition);
//      src/core/import/gltfImportChain.ts (where the Group is emitted and baked);
//      src/app/asset/bindMotionToCharacter.ts (chooses the character this places);
//      issues #730, #826, #897 (the facing half, which nothing here answers).

import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { edgeTarget } from '../animate/graphNodes';
import { clipBakeStates } from './bakeGeneratedClip';
import { evaluate } from '../../core/dag/evaluator';
import type { AnimationClipValue } from '../../nodes/types';

/** What placing a character did, or why it could not. A void return would be the
 *  same trap the bind path was fixed for: four situations collapsing into one
 *  silence, with the character standing at the origin in every one of them. */
export type PlacementOutcome =
  | {
      readonly ok: true;
      /** The Group that was moved — returned so a test can assert the target
       *  rather than infer it from the ops. */
      readonly groupId: string;
      readonly ops: readonly Op[];
      /** Effective world XZ before and after, for the observation log. */
      readonly from: readonly [number, number];
      readonly to: readonly [number, number];
    }
  | { readonly ok: false; readonly reason: string };

/** Read a Vec3 param, defaulting the way the node's own evaluator does. A legacy
 *  Group (pre-#222, params `{}`) is NOT re-parsed through zod on load, so these
 *  can genuinely be absent — Group.evaluate guards the same way for the same
 *  reason, and a placement that read `undefined` here would write NaN. */
function vec3Param(params: unknown, key: string): [number, number, number] {
  const raw = (params as Record<string, unknown> | undefined)?.[key];
  if (!Array.isArray(raw) || raw.length !== 3) return [0, 0, 0];
  const [x, y, z] = raw;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return [0, 0, 0];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return [0, 0, 0];
  return [x, y, z];
}

/**
 * The `GltfAsset` a `GltfSkeleton` projects.
 *
 * Deliberately the same two hops `assetRefOfSkeleton` takes in
 * bindMotionToCharacter — the character this places is the character that bind
 * chose, so it has to arrive by the same road or the two can disagree about
 * which asset a rig belongs to.
 */
function assetIdOfSkeleton(state: DagState, skeletonId: string): string | null {
  const socket = state.nodes[skeletonId]?.inputs?.asset;
  if (!socket) return null;
  const one = Array.isArray(socket) ? socket[0] : socket;
  return one?.node && state.nodes[one.node] ? one.node : null;
}

/**
 * The root `Group` that places a character, found from its rig node.
 *
 * The walk is DOWNSTREAM, and that is why it is a scan rather than a socket
 * read: the import wires `GltfAsset.out → Group.children`, so the asset does not
 * know its Group — only the Group knows its asset. Bounded by the node table and
 * matched on type, so a `Group` that merely happens to contain something else is
 * never mistaken for this character's root.
 */
export function placementGroupFor(state: DagState, skeletonId: string): string | null {
  const assetId = assetIdOfSkeleton(state, skeletonId);
  if (!assetId) return null;
  for (const node of Object.values(state.nodes)) {
    if (node.type !== 'Group') continue;
    const socket = node.inputs?.children;
    const conns = Array.isArray(socket) ? socket : socket ? [socket] : [];
    if (conns.some((c) => c?.node === assetId)) return node.id;
  }
  return null;
}

/**
 * Move a character so its motion starts where the path was drawn.
 *
 * `offsetXZ` is the generator's `worldOffsetXZ`: world metres, and the first
 * waypoint of the requested path. World units are metres here — the BVH importer
 * has always assumed one metre per unit (`BVH_UNIT_SCALE_METRES = 1`) and glTF
 * states metres by spec — so the offset applies with no conversion. That is a
 * fact about both formats, not a coincidence to rely on quietly, which is why it
 * is written down rather than left as an unremarked `+`.
 */
export function placeCharacterAtPathStart(
  state: DagState,
  skeletonId: string,
  offsetXZ: readonly [number, number],
): PlacementOutcome {
  const [x, z] = offsetXZ;
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    return { ok: false, reason: `world offset is not a finite [x, z] pair — got [${x}, ${z}].` };
  }

  const groupId = placementGroupFor(state, skeletonId);
  if (!groupId) {
    // Reported, not swallowed. The motion is bound and will play; it will play in
    // the wrong place, and that is a different thing from "nothing happened".
    return {
      ok: false,
      reason:
        'the motion is bound, but the character has no root group to place it by, ' +
        'so it will play at the origin rather than along the path.',
    };
  }

  const params = state.nodes[groupId]?.params;
  const position = vec3Param(params, 'position');
  const pivot = vec3Param(params, 'pivot');

  // Effective translation is `position - pivot` (see the header). Solving
  // `next - pivot == offset` for `next` gives `pivot + offset`; Y is untouched so
  // a character dropped at a height stays at that height.
  const next: [number, number, number] = [pivot[0] + x, position[1], pivot[2] + z];

  return {
    ok: true,
    groupId,
    ops: [{ type: 'setParam', nodeId: groupId, paramPath: 'position', value: next }],
    from: [position[0] - pivot[0], position[2] - pivot[2]],
    to: [x, z],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE NODE ROAD'S HALF (#935)
// ─────────────────────────────────────────────────────────────────────────────
// The imperative road places once, at the moment it generates. The node road has
// no such moment: a cook can happen at any time, and the path it was asked to
// walk may have moved since the last one. So placement is DERIVED from the graph
// on every cook rather than remembered from a generation.
//
// That is safe to repeat because `placeCharacterAtPathStart` computes an ABSOLUTE
// target (`pivot + offset`) rather than a delta. Cooking twice puts the character
// in the same place twice; a delta would walk it down the path one offset per
// cook, which is the shape of bug that looks like drift and reads like physics.

export interface CookedPlacement {
  readonly ops: Op[];
  /** One per clip that asked to be placed and could not. Never swallowed: the
   *  motion plays correctly and only its POSITION is wrong, which is exactly the
   *  failure that looks like success in a screenshot. */
  readonly refusals: { readonly clipId: string; readonly reason: string }[];
}

/**
 * Place every character whose generated clip came back with a world offset.
 *
 * A `worldOffsetXZ` of `null` means no world path was requested, and those clips
 * are skipped rather than placed at the origin — the distinction the generator
 * chain refuses to collapse, kept here for the same reason.
 */
/**
 * The character rig a generated clip actually drives.
 *
 * 🔑 ASK THE BIND, NOT THE CLIP (#949). A clip minted by `mintMotionGenerateOps`
 * keeps the generator's own empty `Skeleton` on its `skeleton` socket for the
 * whole of its life: the bind does not rewire that edge, it builds a
 * `RetargetClip` that READS the clip and writes onto the character's rig. So
 * reading the clip's own edge finds the generator's skeleton, never a
 * `GltfSkeleton` — and every placement on the minted road refused, leaving the
 * character at the origin with a banner instead of at the start of its path.
 *
 * The one-shot road this replaced never had the bug because it never asked the
 * clip: it placed `bound.skeletonId`, the rig the bind had just chosen. This is
 * that same question asked of the graph, so it also answers on a RE-COOK, where
 * there is no bind result in hand.
 *
 * The clip's own edge stays as the fallback: an IMPORTED clip is wired straight
 * to the rig it was authored against, with no retarget in between.
 */
function boundRigFor(state: DagState, clipId: string): string | null {
  for (const node of Object.values(state.nodes)) {
    if (node.type !== 'RetargetClip') continue;
    if (edgeTarget(node, 'sourceClip') !== clipId) continue;
    const rig = edgeTarget(node, 'skeleton');
    if (rig && state.nodes[rig]?.type === 'GltfSkeleton') return rig;
  }
  const own = edgeTarget(state.nodes[clipId], 'skeleton');
  return own && state.nodes[own]?.type === 'GltfSkeleton' ? own : null;
}

export function placeCookedMotionOps(state: DagState): CookedPlacement {
  const ops: Op[] = [];
  const refusals: { clipId: string; reason: string }[] = [];

  for (const { clipId, producerId, status } of clipBakeStates(state)) {
    if (status !== 'ready') continue;
    const value = evaluate(state, producerId).value as AnimationClipValue;
    const offset = value.generation?.worldOffsetXZ;
    if (!offset) continue;

    // The rig the clip drives IS the character to place, so the thing that moves
    // is the thing that animates — found through the bind, for the reason
    // `boundRigFor` states.
    const skeletonId = boundRigFor(state, clipId);
    if (!skeletonId) {
      refusals.push({
        clipId,
        reason:
          'the motion was generated along a world path, but the clip is not bound to a ' +
          'character rig, so there is nothing to place — it will play at the origin.',
      });
      continue;
    }

    const placed = placeCharacterAtPathStart(state, skeletonId, offset);
    if (placed.ok) ops.push(...(placed.ops as Op[]));
    else refusals.push({ clipId, reason: placed.reason });
  }

  return { ops, refusals };
}
