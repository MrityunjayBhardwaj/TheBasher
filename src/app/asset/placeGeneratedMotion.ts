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
//      src/core/motiongen/pathHeadings.ts (where the rotation is derived);
//      issues #730, #826, #897.
//
// ─────────────────────────────────────────────────────────────────────────
// THE FACING HALF (#897) LANDS ON THE SAME NODE, AND MUST
// ─────────────────────────────────────────────────────────────────────────
// Generation canonicalises frame 0's HEADING to zero as well as its position.
// The capability answers that by expressing the request in the canonical frame
// and reporting the angle it turned it by (`worldRotationRadians`), so what
// arrives here is a rotation to undo, exactly parallel to the offset.
//
// It goes on this node for the reason the offset does — a place and a facing are
// both poses the Object owns, not properties of the clip — and it goes on it in
// the SAME op, because half a placement is worse than none. Rotation without
// translation puts the character on a path rotated off the drawn one; translation
// without rotation is the defect #897 reports, and it is the quiet one: a
// character standing in the right place facing the wrong way reads as a retarget
// fault rather than a placement one.

import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { riggedSkeletonsForClip } from '../animate/boundClipsForAsset';
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
  rotationRadians: number | null,
): PlacementOutcome {
  const [x, z] = offsetXZ;
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    return { ok: false, reason: `world offset is not a finite [x, z] pair — got [${x}, ${z}].` };
  }
  if (rotationRadians !== null && !Number.isFinite(rotationRadians)) {
    return {
      ok: false,
      reason: `world rotation is not a finite angle in radians — got ${rotationRadians}.`,
    };
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
  const rotation = vec3Param(params, 'rotation');

  // 🔴 THE SIGN IS MEASURED, NOT DERIVED. `worldRotationRadians` is an angle in
  // the waypoint frame (+X = 0, +Z = +pi/2); `Group.rotation` is degrees into a
  // THREE Euler, whose Y rotation has the OPPOSITE handedness. Observed:
  //
  //     euler.y = +90 deg  takes (1, 0, 0) -> (0, 0, -1)   i.e. -Z
  //     euler.y = -90 deg  takes (1, 0, 0) -> (0, 0, +1)   i.e. +Z
  //
  // so a character asked to set off toward +Z (angle +pi/2) needs euler.y =
  // -90 deg. Guessing this is a coin flip whose wrong face is a character walking
  // backwards down a correct path — plausible enough to be blamed on the model.
  const yawDeg = rotationRadians === null ? rotation[1] : -rotationRadians * (180 / Math.PI);

  // Effective translation is `position - pivot` (see the header) only while the
  // rotation is identity. In general the content's world start is
  // `position + R·(-pivot)`, so solving for `position` gives `offset + R·pivot`.
  // With no rotation R is the identity and this reduces to `pivot + offset`,
  // which is what shipped before the facing half existed.
  //
  // (Scale is assumed identity here, as it was before: the glTF import bakes
  // `position = drop + pivot` and never writes a scale, so S has no author on
  // this road. A scaled character would need `R·S·pivot`, and nothing produces
  // one yet.)
  const c = Math.cos(rotationRadians ?? 0);
  const sn = Math.sin(rotationRadians ?? 0);
  const rp: [number, number] = [pivot[0] * c - pivot[2] * sn, pivot[0] * sn + pivot[2] * c];
  const next: [number, number, number] = [rp[0] + x, position[1], rp[1] + z];

  // Both halves in ONE op list, always. Y-position is untouched so a character
  // dropped at a height stays there; X and Z of the rotation are untouched for
  // the same reason — only the ground-plane facing is ours to state.
  const ops: Op[] = [{ type: 'setParam', nodeId: groupId, paramPath: 'position', value: next }];
  if (rotationRadians !== null) {
    ops.push({
      type: 'setParam',
      nodeId: groupId,
      paramPath: 'rotation',
      value: [rotation[0], yawDeg, rotation[2]] as [number, number, number],
    });
  }

  return {
    ok: true,
    groupId,
    ops,
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
export function placeCookedMotionOps(state: DagState): CookedPlacement {
  const ops: Op[] = [];
  const refusals: { clipId: string; reason: string }[] = [];

  for (const { clipId, producerId, status } of clipBakeStates(state)) {
    if (status !== 'ready') continue;
    const value = evaluate(state, producerId).value as AnimationClipValue;
    const offset = value.generation?.worldOffsetXZ;
    if (!offset) continue;
    // `?? null` rather than a default of 0: a clip generated before the facing
    // half existed states no rotation, and turning that silence into "the
    // canonical direction was requested" would rotate characters nobody asked to
    // rotate. Absent means leave the facing alone.
    const rotation = value.generation?.worldRotationRadians ?? null;

    // The rig the clip drives IS the character to place — asked of the ONE walk
    // the read band uses, so the thing that moves is the thing that animates.
    //
    // 🔴 NOT `edgeTarget(clip, 'skeleton')`, which is what this did and what
    // #966 was. A generated clip keeps its 78-bone SOURCE `Skeleton` on that
    // socket and the bind hangs the character's `GltfSkeleton` off a
    // `RetargetClip` beside it — so reading the clip's own edge finds a
    // `Skeleton` that is not a rig and refuses, every time, on the only road
    // that produces generated motion. The comment here used to claim parity
    // with the read band; the read band matches the RETARGETED clip and
    // deliberately excludes the source. Same socket name, different node.
    const skeletonIds = riggedSkeletonsForClip(state.nodes, clipId);
    if (skeletonIds.length === 0) {
      refusals.push({
        clipId,
        reason:
          'the motion was generated along a world path, but the clip is not bound to a ' +
          'character rig, so there is nothing to place — it will play at the origin.',
      });
      continue;
    }

    // Every character the clip drives, not the first: one generated walk bound to
    // two characters walks the path twice, and placing one of them would leave
    // the other at the origin with nothing said.
    for (const skeletonId of skeletonIds) {
      const placed = placeCharacterAtPathStart(state, skeletonId, offset, rotation);
      if (placed.ok) ops.push(...(placed.ops as Op[]));
      else refusals.push({ clipId, reason: placed.reason });
    }
  }

  return { ops, refusals };
}
