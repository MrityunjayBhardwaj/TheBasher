// #634 (ns-1) — the ONE place a primitive's attribute set is derived from its params.
//
// ── A PROJECTION, NOT A SECOND AUTHORING SURFACE ──────────────────────────────────────
//
// `BoxData.params.material` stays the single source of truth for what a primitive is made
// of. The face-domain `material_index` this mints is DERIVED from it at evaluate time: every
// face gets slot 0, because a primitive has exactly one material slot and nothing in the UI
// can yet say otherwise. Nothing is authored here, nothing round-trips, and consequently
// nothing in a save file changes shape — which is why this slice needs no migration.
//
// Deriving it anyway, in the degenerate uniform case, is the point of the slice: it moves
// the READ path onto the attribute system while the answers are still identical, so the
// rewrite and the behaviour change do not land in the same commit. The suite cannot tell the
// two implementations apart on this population — every producer writes a uniform assignment
// — and that is expected. The discriminating case has to be MINTED (#634's two-valued
// member); it cannot be found in the real population, because the real population cannot
// express it yet.
//
// ── WHY IT MAY RETURN NOTHING ─────────────────────────────────────────────────────────
//
// A geometry whose face count is not derivable from params (glTF, baked — their buffers live
// in an asset clone or in OPFS) gets NO attribute set rather than a guessed one. Absence
// here means "this road has not been given a data half yet", which is the honest state and
// the subject of a later phase; a fabricated count would be a length that agrees with
// nothing.
//
// REF: src/app/faceCount.ts (`faceCountOf` — the count, why it is gated, and why it is a leaf);
//      src/nodes/attributeKey.ts (`mintAttributes`); src/app/attributeStore.ts (the holder);
//      issues #633, #634, #395.

import { faceCountOf } from '../app/faceCount';
import { insert, read, type AttributeGrowthSource } from '../app/attributeStore';
import { MATERIAL_INDEX, type AttributeData } from './attributes';
import { mintAttributes, type MintedAttributes } from './attributeKey';
import type { GeometryDescriptor } from './types';

/**
 * Refuse a mint that did not say where its growth belongs (#638, ns-1b step 6).
 *
 * ⚠️ THIS EXISTS BECAUSE THE REQUIRED PARAMETER WAS NOT ENOUGH, MEASURED RATHER THAN
 * FEARED. `via` was made required at step 3b — and the tree still had SEVENTEEN call sites
 * passing nothing, because `npm run typecheck` excludes `*.test.*` and vitest transpiles
 * through esbuild without checking types at all. Both standing gates are blind to the same
 * omission. What it does is silent and specific: `growth[undefined]++` writes `NaN` under a
 * junk key, every assertion on `growthBySource().evaluate` still passes, and the attribution
 * that the store ships INSTEAD of eviction quietly under-reports.
 *
 * A required parameter closes the omission where something typechecks. The tier that mints
 * most often is not that tier, so the refusal has to be a runtime one.
 */
function refuseUnattributedGrowth(via: AttributeGrowthSource): void {
  if (via === undefined) {
    throw new Error(
      'meshAttributes: an attribute set was minted without saying where its growth belongs — pass an AttributeGrowthSource',
    );
  }
}

/**
 * The attribute set a primitive with ONE material slot carries: a face-domain
 * `material_index` of all zeros, sized to the geometry's face count.
 *
 * Returns `null` when the face count is not derivable from the descriptor — see the module
 * note. Pure: mints, stores nothing.
 *
 * ⚠️ Takes the DESCRIPTOR, not the handle, and #638 is what forced the narrowing: the
 * attribute key is now folded into `GeometryRef.key`, so it has to exist BEFORE the handle
 * does. Nothing was lost — this only ever read `geometry.descriptor`.
 */
export function uniformMaterialAttributes(descriptor: GeometryDescriptor): MintedAttributes | null {
  const faces = faceCountOf(descriptor);
  if (faces === null) return null;

  const materialIndex: AttributeData = {
    domain: 'face',
    type: 'int',
    count: faces,
    // Int32Array is zero-filled on construction — every face on slot 0.
    data: new Int32Array(faces),
  };
  return mintAttributes({ [MATERIAL_INDEX]: materialIndex });
}

/**
 * Derive the set, put it in the store, and hand back the key a data value carries.
 *
 * Called from `evaluate()` and, since #638, from the animation overlay's handle rebuild.
 * The insertion is content-keyed and idempotent — re-deriving the same set is a HIT, so
 * this stays safe to run on every evaluation and on every frame of a drag, and the node
 * stays pure in the sense that matters: the same params produce the same value.
 *
 * `via` is REQUIRED, not defaulted, and the reason is the same rung of the same ladder the
 * builders' attribute key sits on. The store ships growth attribution by origin INSTEAD of
 * eviction, so a third producer silently counted as one of the first two would leave the
 * total right and the attribution missing — and a missing attribution reads exactly like an
 * attribution of zero. A new producer has to say who it is.
 */
export function mintMeshAttributes(
  descriptor: GeometryDescriptor,
  via: AttributeGrowthSource,
): string | null {
  refuseUnattributedGrowth(via);
  const minted = uniformMaterialAttributes(descriptor);
  if (minted === null) return null;
  insert(minted.key, minted.set, via);
  return minted.key;
}

/**
 * The attribute set for a mesh whose faces in `[from, to]` use slot 1 and the rest slot 0
 * (#638, ns-1b step 6) — the FIRST non-uniform assignment anything in this app can author.
 *
 * The bounds are clamped rather than refused: an authored range reaching past the end of a
 * mesh is an ordinary state while a param is being dragged or a source is being resized, and
 * a value that refuses to evaluate mid-drag is worse than one that assigns what exists. An
 * INVERTED range (`from > to`) clamps to nothing and every face stays on slot 0 — which then
 * resolves back to a single material, because the assignment reports one used slot. No arm
 * is needed for it anywhere downstream; it simply is not a two-material mesh.
 *
 * Returns `null` when the face count is not derivable from the descriptor, exactly as
 * {@link uniformMaterialAttributes} does — see the module note.
 */
export function faceRangeMaterialAttributes(
  descriptor: GeometryDescriptor,
  from: number,
  to: number,
): MintedAttributes | null {
  const faces = faceCountOf(descriptor);
  if (faces === null) return null;

  const data = new Int32Array(faces);
  const lo = Math.max(0, Math.trunc(from));
  const hi = Math.min(faces - 1, Math.trunc(to));
  for (let face = lo; face <= hi; face++) data[face] = 1;

  const materialIndex: AttributeData = { domain: 'face', type: 'int', count: faces, data };
  return mintAttributes({ [MATERIAL_INDEX]: materialIndex });
}

/**
 * Derive a face-range assignment, store it, and hand back the key — the range sibling of
 * {@link mintMeshAttributes}, with the same content-keyed idempotence and the same required
 * `via`, for the same reasons.
 */
export function mintFaceRangeAttributes(
  descriptor: GeometryDescriptor,
  from: number,
  to: number,
  via: AttributeGrowthSource,
): string | null {
  refuseUnattributedGrowth(via);
  const minted = faceRangeMaterialAttributes(descriptor, from, to);
  if (minted === null) return null;
  insert(minted.key, minted.set, via);
  return minted.key;
}

/** What {@link rebuiltMeshAttributes} decided, and why — the reason is never dropped. */
export interface RebuiltAttributes {
  /** The key the rebuilt handle should carry, or `null` for "no attributes on this one". */
  readonly key: string | null;
  /** `null` when nothing was given up; otherwise what was dropped and why. */
  readonly reason: string | null;
}

/**
 * What attribute key a REBUILT geometry handle carries — the overlay road's answer (#638).
 *
 * ── WHY THE OVERLAY MAY NOT SIMPLY CARRY THE OLD KEY FORWARD ──────────────────────────
 *
 * The animation overlay rebuilds a handle whenever a channel writes one of its descriptor's
 * param fields, and for a sphere those fields include `widthSegments` / `heightSegments`.
 * A sphere's face count is `2w(h−1)`, so an animated segment count changes how many faces
 * exist — while the carried key still names a set sized for the OLD count. That set then
 * describes a different mesh: the count gate refuses it, no group layout is written, and
 * under a multi-slot assignment the mesh is handed a material array over an empty layout,
 * which in three.js draws nothing at all. The object disappears mid-animation, casts no
 * shadow, and stops being clickable, with nothing logged.
 *
 * ⚠️ The previous shape of this defence — asserting the rebuilt key *still carries a
 * component* — is satisfied by a STALE component, which is precisely the failure. Only the
 * count discriminates.
 *
 * Three arms, and the middle one is the only one that carries:
 *
 *   uniform carried set        → RE-MINT at the rebuilt descriptor's face count. For a box
 *                                this is a no-op by value (12 faces at every size), so the
 *                                current population sees no change at all; for a sphere it
 *                                is the correct new set.
 *   non-uniform, count intact  → carry it. The assignment is authored data the overlay has
 *                                no business re-deriving, and it still fits.
 *   non-uniform, count changed → DROP it and say so. There is no correct answer without a
 *                                resampling policy, and a visible degradation to one
 *                                material is the honest failure; the invisible mesh is not.
 */
export function rebuiltMeshAttributes(
  carriedKey: string | undefined,
  rebuilt: GeometryDescriptor,
): RebuiltAttributes {
  if (carriedKey === undefined) return { key: null, reason: null };

  const carried = read(carriedKey);
  const index = carried?.[MATERIAL_INDEX];
  // Nothing resident under the carried key, or nothing face-domain in it: re-derive rather
  // than propagate a name the store cannot resolve.
  if (index === undefined) return { key: mintMeshAttributes(rebuilt, 'overlay'), reason: null };

  let uniform = true;
  for (let i = 0; i < index.data.length; i++) {
    if (index.data[i] !== index.data[0]) {
      uniform = false;
      break;
    }
  }
  if (uniform) return { key: mintMeshAttributes(rebuilt, 'overlay'), reason: null };

  const faces = faceCountOf(rebuilt);
  if (faces === null || faces === index.count) return { key: carriedKey, reason: null };
  return {
    key: null,
    reason: `meshAttributes: a per-face assignment over ${index.count} faces cannot follow '${rebuilt.kind}' to ${faces} faces — dropping it, so the mesh draws with one material rather than not at all`,
  };
}
