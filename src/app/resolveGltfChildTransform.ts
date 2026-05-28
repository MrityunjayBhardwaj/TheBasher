// The ONE layering primitive for a glTF scene child's resolved TRS (Phase 7.7,
// issue #91). Both the renderer (SceneFromDAG.GltfAssetR, B2) and the resolver
// (resolveEvaluatedTransform, Wave C) consume THIS function — there is exactly
// ONE precedence rule for "where a child actually renders" (R-3, V20).
//
// Precedence, per-component (R-4):
//     manual override (if overridden[field]) → clip track (if present) → base
//
// CRITICAL — the value-equality trap: layering branches on the explicit
// `overridden` flag, NEVER on value-equality against the base TRS. A director
// who drags a bone back to its captured base pose must KEEP the override (so
// the clip does not resurface); only the flag distinguishes "user set this"
// from "this is the base value". (GltfChild.ts seeds the params with the base
// TRS at import, so a value-equality check could not tell the two apart.)
//
// CRITICAL — units: everything here is DEGREES Euler XYZ (the codebase
// convention: Transform.rotation, TransformClipValue, GltfChildValue). This
// function does ZERO three.js work — pure data in, data out. The THREE seam
// (SceneFromDAG.tsx) converts to radians via degVec3ToRad on apply.
//
// REF: PLAN.md Wave B (B1); CONTEXT 7.7 R-3/R-4; vyapti V20.

import type { Vec3 } from '../nodes/types';

export interface ChildTrs {
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
}

/** The manual-override layer: a GltfChild node's TRS params + the dirty flags. */
export interface ChildOverride extends ChildTrs {
  readonly overridden: {
    readonly position: boolean;
    readonly rotation: boolean;
    readonly scale: boolean;
  };
}

/**
 * Resolve ONE child's TRS by layering manual override over clip over base.
 *
 * @param base       the child's captured static TRS (degrees). Always present.
 * @param clipTrack  the active TransformClip track for this child, or undefined.
 * @param childNode  the GltfChild node's params (TRS + overridden flags), or
 *                   undefined when no addressable child node exists yet.
 */
export function resolveGltfChildTrs(args: {
  base: ChildTrs;
  clipTrack: ChildTrs | undefined;
  childNode: ChildOverride | undefined;
}): ChildTrs {
  const { base, clipTrack, childNode } = args;
  const pick = (field: 'position' | 'rotation' | 'scale'): Vec3 => {
    if (childNode && childNode.overridden[field]) return childNode[field]; // manual wins
    if (clipTrack) return clipTrack[field]; // clip wins
    return base[field]; // static base
  };
  return {
    position: pick('position'),
    rotation: pick('rotation'),
    scale: pick('scale'),
  };
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
 * @param names         the scene-child name keys to resolve (GltfAsset.nodeNameMap keys).
 * @param childByName   GltfChild params keyed by childName (subscribed selector output).
 * @param clip          the active TransformClip, or null/undefined.
 */
export function resolveAllChildTrs(args: {
  names: readonly string[];
  childByName: Readonly<Record<string, ChildOverride>>;
  clip: { tracks: Readonly<Record<string, ChildTrs>> } | null | undefined;
}): Record<string, ChildTrs> {
  const { names, childByName, clip } = args;
  const out: Record<string, ChildTrs> = {};
  for (const name of names) {
    const childNode = childByName[name];
    const clipTrack = clip?.tracks[name];
    // The base is the child node's seeded TRS (the captured static base when
    // not overridden). With no child node, the clip is the only layer; with
    // neither, omit so the renderer keeps the native cloned TRS.
    if (!childNode && !clipTrack) continue;
    const base: ChildTrs = childNode ??
      clipTrack ?? { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    out[name] = resolveGltfChildTrs({ base, clipTrack, childNode });
  }
  return out;
}
