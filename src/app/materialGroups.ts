// #638 (ns-1b step 2) — a per-face material index becomes a three.js group layout.
//
// ── THE MAPPING, STATED ONCE SO IT CAN BE CHECKED ─────────────────────────────────────
//
// For an INDEXED triangle mesh, face-domain element `t` occupies index elements `[3t, 3t+3)`.
// A maximal run of consecutive faces `[a, b)` sharing slot `s` becomes
// `addGroup(3a, 3(b − a), s)`. Therefore `Σ group.count === index.count === 3 × faceCount`.
//
// ── WHY THIS IS A STEP WITH ITS OWN FALSIFICATION, NOT ARITHMETIC ASSUMED CORRECT ─────
//
// Two different things are both honestly called "a box's faces", and they differ by 2×:
//
//   the attribute domain `face` = TRIANGLES  → 12 for a box
//   `BoxGeometry.groups`        = CUBE SIDES → 6 for a box, two triangles each
//
// The fixture ns-1 minted splits a box 6/6, which lands EXACTLY on a cube-side boundary —
// sides 0,1,2 against sides 3,4,5. An implementation that resolved at cube-side granularity
// would render three sides of each material and look correct on that fixture, in pixels and
// in draw-call count, while being wrong by a factor of two everywhere else. The standing
// discriminator has a numerical coincidence in it that hides a whole error class, which is
// why this phase mints a NON-ALIGNED fixture and asserts on the group BOUNDARY rather than
// on coverage: a cube-side layout for face-0-alone yields `[{0,6,1},{6,30,0}]`, which covers
// 36 of 36 and is still wrong.
//
// ── WHY A NON-INDEXED GEOMETRY IS REFUSED BY NAME ─────────────────────────────────────
//
// It is a different address space, not a harder case: for non-indexed geometry three.js
// groups address the POSITION attribute directly rather than the index. Silently applying
// the indexed arithmetic there would produce a group layout addressing the wrong buffer, at
// the wrong scale, with no error — so the derivation declines and says which condition it
// hit. An imported glTF mesh is the everyday non-indexed case, not a corner.
//
// REF: src/app/faceCount.ts (the count these are checked against);
//      src/nodes/attributes.ts (`MATERIAL_INDEX`, the face domain);
//      src/test-utils/twoMaterialMesh.ts (both fixtures — aligned and non-aligned);
//      issues #638, #634.

/** One three.js draw group: `[start, start + count)` index elements drawn with `materialIndex`. */
export interface MaterialGroup {
  readonly start: number;
  readonly count: number;
  readonly materialIndex: number;
}

/**
 * The group layout for a per-face material index over an indexed triangle mesh, or `null`
 * when the derivation declines — with the reason in {@link groupsRefusal}.
 *
 * Runs are coalesced: consecutive faces on the same slot become ONE group, because a group
 * per triangle is a draw call per triangle. The layout is in face order, never sorted by
 * slot — reordering would make groups address triangles they do not cover.
 */
export function groupsFromMaterialIndex(
  indices: ArrayLike<number>,
  indexCount: number | null,
): MaterialGroup[] | null {
  if (groupsRefusal(indices, indexCount) !== null) return null;

  const groups: MaterialGroup[] = [];
  let runStart = 0;
  for (let t = 1; t <= indices.length; t++) {
    const ended = t === indices.length || indices[t] !== indices[runStart];
    if (!ended) continue;
    groups.push({
      start: runStart * 3,
      count: (t - runStart) * 3,
      materialIndex: indices[runStart],
    });
    runStart = t;
  }
  return groups;
}

/**
 * Why the group derivation declines for this pair, or `null` when it proceeds.
 *
 * Separate from the derivation so a caller can report the reason rather than only observe a
 * `null`. A derivation that declines silently is indistinguishable from a mesh that
 * genuinely has one material — the two states this phase exists to tell apart.
 */
export function groupsRefusal(
  indices: ArrayLike<number>,
  indexCount: number | null,
): string | null {
  if (indexCount === null) {
    return 'materialGroups: geometry is NOT INDEXED — groups would address the position attribute, not the index, so the per-face arithmetic does not apply';
  }
  if (indices.length === 0) {
    return 'materialGroups: the face-domain index is empty, so there is no assignment to lay out';
  }
  if (indices.length * 3 !== indexCount) {
    return `materialGroups: the face-domain index carries ${indices.length} faces (${indices.length * 3} index entries) but the geometry carries ${indexCount} — they describe different meshes`;
  }
  return null;
}

/**
 * The index elements a layout covers, counting ONLY groups whose slot resolves to a present
 * material — the coverage property the phase is scored by.
 *
 * The *"resolves to a present material"* qualifier is the whole point and not a refinement.
 * Without it, a stock box's six built-in groups sum to 36 against an `index.count` of 36, so
 * a naive equality passes on exactly the failure it exists to catch: an array minted over
 * the stock six, which draws twelve of thirty-six triangles.
 */
export function coveredIndexCount(
  groups: readonly { readonly count: number; readonly materialIndex?: number }[],
  resolvedSlots: number,
): number {
  let covered = 0;
  for (const g of groups) {
    // three.js declares `materialIndex` OPTIONAL on a built geometry's groups, and an absent
    // one is not a zero: the renderer looks up `material[undefined]`, gets `undefined`, and
    // skips that group exactly as it skips an out-of-range slot. Both are the same fact —
    // this group resolves to no material — so both count as uncovered. Typing the parameter
    // structurally is what lets this be asked of a live `BufferGeometry.groups` rather than
    // only of the derivation's own output, which is the whole point of the property.
    if (g.materialIndex !== undefined && g.materialIndex < resolvedSlots) covered += g.count;
  }
  return covered;
}
