// The ONE layering primitive for a glTF scene child's resolved TRS (Phase 7.7,
// issue #91; extended P7.12 #108). Both the renderer (SceneFromDAG.GltfAssetR,
// B2/C2) and the read-side resolver (resolveEvaluatedTransform, C3) consume THIS
// function — there is exactly ONE precedence rule for "where a child actually
// renders" (R-3, V20).
//
// **TWO CALLERS, BLOCK-1 (do NOT fork, do NOT under-thread):** this primitive
// is called by (1) the renderer useFrame (SceneFromDAG.GltfAssetR, C2) AND (2)
// the read-side gizmo/NPanel resolver (resolveEvaluatedTransform:205, C3). Any
// NEW precedence band added here MUST be threaded into BOTH callers, or the
// surface that omits it shows a displayed-≠-rendered split — the #68/#77
// second-surface bug class (H40) this boundary's dharana exists to prevent. The
// `bakedChannel` arg is OPTIONAL purely for compile-staging; both callers pass
// it in P7.12.
//
// Precedence, per-component (R-4) — P7.12 adds the `bakedChannel` band BETWEEN
// manual and clip:
//     manual override (if overridden[field])
//       → baked channel (if present for field)
//       → clip track (if present)
//       → base
//
// CRITICAL — PRESENCE, not value-equality (R-4), at BOTH the manual and the
// baked band: layering branches on the explicit `overridden` flag (manual) and
// on the field KEY EXISTING in `bakedChannel` (baked), NEVER on value-equality
// against the base or clip TRS. A baked channel whose sampled value happens to
// equal the base pose STILL wins over the clip — the bone was edited; its track
// is now the per-bone KeyframeChannel, not the clip. A director who drags a bone
// back to its captured base pose must KEEP the override (so the clip does not
// resurface); only the flag/presence distinguishes "user authored this" from
// "this is the base value". (GltfChild.ts seeds the params with the base TRS at
// import, so a value-equality check could not tell the two apart.)
//
// CRITICAL — units: everything here is DEGREES Euler XYZ (the codebase
// convention: Transform.rotation, TransformClipValue, GltfChildValue). This
// function does ZERO three.js work — pure data in, data out. The THREE seam
// (SceneFromDAG.tsx) converts to radians via degVec3ToRad on apply.
//
// REF: PLAN.md Wave B (B1) + Wave C (C1/C2/C3, BLOCK-1); CONTEXT 7.7 R-3/R-4,
//      7.12 D-01; vyapti V20; hetvabhasa H40.

import type { Vec3 } from '../nodes/types';
import { mergeOverridden } from '../core/override/overrideSet';

export interface ChildTrs {
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
}

/** The three TRS components, in the canonical order, for the override merge. */
const TRS_FIELDS = ['position', 'rotation', 'scale'] as const;

/** The manual-override layer: a GltfChild node's TRS params + the dirty flags. */
export interface ChildOverride extends ChildTrs {
  readonly overridden: {
    readonly position: boolean;
    readonly rotation: boolean;
    readonly scale: boolean;
  };
}

/**
 * The baked-channel layer (P7.12 #108): a per-component pre-sampled TRS the
 * caller materializes from the per-bone KeyframeChannel node(s)' `sample(t)` at
 * the SAME time it samples the clip. A field is PRESENT (key exists) iff a baked
 * channel node contributed that component — presence, never value, is the win
 * signal (R-4). Absent fields fall through to the clip / base. This is the
 * copy-on-write edit layer: once a bone is edited, its track lives here, not in
 * the clip.
 */
export interface BakedChannel {
  readonly position?: Vec3;
  readonly rotation?: Vec3;
  readonly scale?: Vec3;
}

/**
 * Resolve ONE child's TRS by layering manual override over baked channel over
 * clip over base (P7.12 #108 inserted the baked-channel band).
 *
 * @param base         the child's captured static TRS (degrees). Always present.
 * @param clipTrack    the active TransformClip track for this child, or undefined.
 * @param childNode    the GltfChild node's params (TRS + overridden flags), or
 *                     undefined when no addressable child node exists yet.
 * @param bakedChannel the per-component pre-sampled TRS from the bone's per-bone
 *                     KeyframeChannel node(s), or undefined when none exist. A
 *                     field is present (key exists) iff a baked channel
 *                     contributed it — PRESENCE wins (R-4), never value-equality.
 *                     OPTIONAL for compile-staging only; BOTH callers (C2
 *                     renderer + C3 read-side resolveEvaluatedTransform) pass it.
 */
export function resolveGltfChildTrs(args: {
  base: ChildTrs;
  clipTrack: ChildTrs | undefined;
  childNode: ChildOverride | undefined;
  bakedChannel?: BakedChannel | undefined;
}): ChildTrs {
  const { base, clipTrack, childNode, bakedChannel } = args;
  // Lower bands (baked → clip → base), per-component PRESENCE not value (R-4).
  // This resolves the "source" that the manual override layers on top of.
  const lower = (field: 'position' | 'rotation' | 'scale'): Vec3 => {
    const baked = bakedChannel?.[field];
    if (baked !== undefined) return baked; // baked channel wins over clip (presence, not value)
    if (clipTrack) return clipTrack[field]; // clip wins
    return base[field]; // static base
  };
  const source: ChildTrs = {
    position: lower('position'),
    rotation: lower('rotation'),
    scale: lower('scale'),
  };
  // Manual override band via the SHARED primitive (#124, V28): for each field
  // the node's authored value wins iff `overridden[field]` is set, else the
  // lower band. Behaviourally identical to the previous inline
  // `childNode.overridden[field]` short-circuit — the band ORDER (manual →
  // baked → clip → base) and the presence-not-value rule (R-4) are unchanged.
  // This is the "2nd consumer justifies the module" retrofit (D-06): GltfChild
  // is consumer #1, MaterialOverride #2.
  if (!childNode) return source;
  return mergeOverridden(source, childNode, childNode.overridden, TRS_FIELDS);
}

/**
 * Resolve EVERY child at once (the renderer's consumer side, B2). Built on the
 * per-child function so there is exactly one precedence rule.
 *
 * The `base` for each name is the GltfChild node's seeded TRS when an
 * addressable node exists (it was seeded with the captured base at import,
 * gltfImportChain A2). When no node exists for a name (pre-7.7 value, or a name
 * the importer did not emit), the clip track is the only source; if neither is
 * present the name is simply omitted (the renderer leaves the cloned scene's
 * native TRS untouched).
 *
 * **P7.10 (B13 Pass 3, #114):** the `tracks` argument is now a pre-sampled
 * TRS map (caller materialized it from `TransformClipValue.sample(currentTime)`).
 * Pre-P7.10 this function accepted `clip: TransformClipValue | null` and read
 * `clip.tracks` internally; the value-shape change moved time-sampling OUT of
 * the layering helper so the renderer (useFrame-driven) and static readers
 * (gizmo / NPanel — current-time resolution) can each control the sample
 * cadence. The layering rule (manual → clip → base) is unchanged.
 *
 * @param names         the scene-child name keys to resolve (GltfAsset.nodeNameMap keys).
 * @param childByName   GltfChild params keyed by childName (subscribed selector output).
 * @param tracks        the active clip's per-child TRS at the current sample
 *                       time, or null/undefined when no clip is active.
 * @param bakedByName   the per-bone baked-channel TRS keyed by childName, the
 *                       caller having pre-sampled each channel's `sample(t)` at
 *                       the SAME time as `tracks` (P7.12 #108). A bone with a
 *                       baked channel takes precedence over its clip track
 *                       (presence-based, R-4). null/undefined when none exist.
 */
export function resolveAllChildTrs(args: {
  names: readonly string[];
  childByName: Readonly<Record<string, ChildOverride>>;
  tracks: Readonly<Record<string, ChildTrs>> | null | undefined;
  bakedByName?: Readonly<Record<string, BakedChannel>> | null | undefined;
}): Record<string, ChildTrs> {
  const { names, childByName, tracks, bakedByName } = args;
  const out: Record<string, ChildTrs> = {};
  for (const name of names) {
    const childNode = childByName[name];
    const clipTrack = tracks?.[name];
    const bakedChannel = bakedByName?.[name];
    // The base is the child node's seeded TRS (the captured static base when
    // not overridden). With no child node, the clip is the only layer; with
    // neither, omit so the renderer keeps the native cloned TRS. A baked
    // channel alone (no node, no clip) still resolves — a bone can be edited
    // (baked) even where the clip never touched it.
    if (!childNode && !clipTrack && !bakedChannel) continue;
    const base: ChildTrs = childNode ??
      clipTrack ?? { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    out[name] = resolveGltfChildTrs({ base, clipTrack, childNode, bakedChannel });
  }
  return out;
}
