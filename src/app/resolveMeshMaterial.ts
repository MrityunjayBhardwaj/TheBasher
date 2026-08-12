// #638 (ns-1b step 5) — ONE function decides what a mesh draws with, from the geometry it
// is about to draw.
//
// ── WHY BOTH HALVES HAVE TO BE DECIDED IN ONE PLACE ───────────────────────────────────
//
// A three.js mesh drawn with a material ARRAY reads its `geometry.groups` to know which
// material each run of index elements uses. The two halves are therefore one decision, and
// the previous shape of this phase made them two: `build()` wrote groups from the ref's
// per-face index, while the render component minted an array from the data value's slot
// table. Nothing coupled them. The moment `build()` declines to write groups — a stale
// attribute key after an overlay rebuild, a store miss, either refusal — while the value
// still reports two assigned slots, the component mints an array over an EMPTY layout.
//
// That state is not a degradation. It is invisibility: the renderer pushes one render-list
// entry per group (`WebGLRenderer.js:1393-1411`), so zero groups is zero entries — the mesh
// draws nothing, casts no shadow (`WebGLShadowMap.js:346`) and cannot be clicked
// (`Mesh.js:207`). Three code paths, no `else` arm, nothing thrown. To a director that is
// "my object vanished", which reads as a scene-authoring mistake rather than a render bug.
//
// So the array is derived FROM the built instance's groups, never beside them: this function
// cannot return an array whose groups do not cover the index it is drawn with.
//
// ── THE ARMS, IN ORDER, AND WHAT EACH ONE MAKES UNCONSTRUCTIBLE ───────────────────────
//
//   0. geometry === null              → NO DRAW. `getForAttach` returns null on an ordinary
//                                       cache miss and both callers branch on it AFTER their
//                                       hooks, so the natural placement calls this with a
//                                       null geometry. The answer lives in the contract
//                                       rather than in placement discipline.
//   1. the table has ≤1 entry, or the faces use ≤1 slot
//                                     → the single material. A 1-LENGTH ARRAY HAS NO
//                                       CONSTRUCTOR: handed to a stock box it would draw six
//                                       of thirty-six index elements with no error at all.
//   2. geometry.index === null        → the single material. For a non-indexed geometry
//                                       groups address the POSITION attribute, so `start`
//                                       and `count` are in a different unit and the mapping
//                                       would be silently off by 3×. An imported glTF mesh
//                                       is the everyday case, not a corner.
//   3. coverage ≠ index.count         → the single material, AND A REPORTED REASON. This is
//                                       the arm that makes the invisible mesh unconstructible
//                                       — at zero groups the coverage is zero — and the one
//                                       that catches a stock box's six cube-side groups under
//                                       a two-length array (covered 12, index.count 36).
//   4. otherwise                      → the TABLE: `slots.length` long, in table order, with
//                                       `materialIndex` never remapped.
//
// ── THE COMPACTION TRAP, NAMED BECAUSE THE WRONG LINE IS THE ATTRACTIVE ONE ───────────
//
// `assignedMaterials()` (`materialAssignment.ts:75-77`) maps the slots a mesh USES, so with
// faces on slots 0 and 3 over a table of four it returns TWO materials. Handed to a mesh
// whose groups say `materialIndex: 3`, `material[3]` is `undefined` and the renderer skips
// those groups silently. The array here is the TABLE, never the compaction — the helper is
// right there and its name reads correct, which is exactly why this says so.
//
// ── THE PAIR IS RETURNED TOGETHER, AND THAT IS THE POINT ──────────────────────────────
//
// The geometry this reads must be the instance the mesh MOUNTS, or the coverage argument is
// about a different object than the one on screen. That was true by construction and by
// nothing stronger, so the return carries both: a caller cannot source the material here and
// the geometry somewhere else without saying so in its own JSX.
//
// REF: src/app/materialGroups.ts (`coveredIndexCount` — the coverage definition);
//      src/app/materialAssignment.ts (`assignedSlots`, and the compaction named above);
//      src/app/geometryRegistry.ts (`build` — the only writer of the layout this reads);
//      src/app/material/useSlotMaterials.ts (the caller that hydrates the table);
//      issues #638, #634, #530, #533.

import type * as THREE from 'three';
import type { MaterialAssignment } from '../nodes/types';
import { assignedSlots } from './materialAssignment';
import { coveredIndexCount } from './materialGroups';

/** What a `<mesh>` draws with: the geometry it was handed, and the material for THAT geometry. */
export interface MeshDraw {
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material | THREE.Material[];
}

/**
 * The pair a mesh draws with, or `null` when there is no geometry to draw.
 *
 * `materials` is the object's slot table, already hydrated in TABLE ORDER — slot `i` is
 * `materials[i]`, with unassigned slots hydrated to the caller's fallback. A table longer
 * than the caller hydrates is bounded here rather than assumed away: the array is only as
 * long as there are materials for, so a face pointing past the end leaves coverage short and
 * arm 3 degrades loudly instead of drawing nothing.
 */
export function resolveMeshMaterial(
  geometry: THREE.BufferGeometry | null,
  assignment: MaterialAssignment<unknown>,
  materials: readonly THREE.Material[],
): MeshDraw | null {
  // A runtime refusal, not a type-level one, and the difference is measured: `vitest`
  // transpiles through esbuild and checks NO types, while `npm run typecheck` excludes
  // `*.test.*` — so both standing gates are blind to the same wrong call site. An empty
  // table would make `materials[0]` `undefined`, and a mesh with an undefined material
  // draws in three.js's default white: plausible, silent, and wrong.
  if (materials.length === 0) {
    throw new Error(
      'resolveMeshMaterial: the material table is empty — the caller must hydrate at least slot 0',
    );
  }
  if (geometry === null) return null; // arm 0
  const single: MeshDraw = { geometry, material: materials[0] };
  // Arm 1, cheapest test first and that ordering is load-bearing rather than tidy:
  // `assignedSlots` walks the whole face index, and every mesh in the app today has a
  // one-entry table, so the O(1) test keeps the per-render cost of this call at zero for
  // the entire current population.
  if (assignment.slots.length <= 1) return single;
  if (assignedSlots(assignment).length <= 1) return single;
  if (meshMaterialRefusal(geometry, assignment, materials) !== null) return single; // arms 2, 3
  return { geometry, material: materialTable(assignment, materials) }; // arm 4
}

/**
 * Why a mesh that asked for more than one material is getting one, or `null`.
 *
 * Separate from the decision for the reason the sibling derivation gives: a refusal that
 * only shows up as "one material" is indistinguishable from a mesh that genuinely has one,
 * and those are the two states this phase exists to tell apart. A lying label — a mesh that
 * should draw two materials quietly drawing one — is worse than an open gap, because it gets
 * relied on.
 *
 * The decision calls this, so the two cannot disagree about which arm fired.
 */
export function meshMaterialRefusal(
  geometry: THREE.BufferGeometry | null,
  assignment: MaterialAssignment<unknown>,
  materials: readonly THREE.Material[],
): string | null {
  // No geometry and no request are both "nothing was refused". A null geometry means
  // nothing draws at all, which its own caller already surfaces by its own route; reporting
  // it twice would name the same blank mesh in two vocabularies.
  if (geometry === null) return null;
  if (assignment.slots.length <= 1) return null;
  if (assignedSlots(assignment).length <= 1) return null;

  const index = geometry.index;
  if (index === null) {
    return 'resolveMeshMaterial: the geometry is NOT INDEXED, so its groups would address the position attribute rather than the index — this mesh draws with its first material only';
  }
  const table = materialTable(assignment, materials);
  const covered = coveredIndexCount(geometry.groups, table.length);
  if (covered !== index.count) {
    return `resolveMeshMaterial: the group layout covers ${covered} of ${index.count} index elements across ${table.length} material slots — an array over that layout would leave the rest undrawn, so this mesh draws with its first material only`;
  }
  return null;
}

/**
 * The table, bounded by what the caller hydrated — never `assignedMaterials()`'s compaction,
 * and never re-indexed. `materialIndex` in a group is a slot number; renumbering the array
 * under it would point every group at the wrong material while every count still agreed.
 */
function materialTable(
  assignment: MaterialAssignment<unknown>,
  materials: readonly THREE.Material[],
): THREE.Material[] {
  return materials.slice(0, Math.min(assignment.slots.length, materials.length));
}
