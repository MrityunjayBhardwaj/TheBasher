// #638 (ns-1b step 2) — a per-face material index becomes a three.js group layout.
//
// ── THE MAPPING, STATED ONCE SO IT CAN BE CHECKED ─────────────────────────────────────
//
// #770 — A FACE IS A POLYGON, SO THE MAPPING IS NO LONGER A MULTIPLICATION. Face-domain
// element `f` occupies index elements `[3·start[f], 3·(start[f] + arity[f]))`, where `arity`
// says how many triangles each polygon fans to and `start` is its prefix sum. A maximal run of
// consecutive faces `[a, b)` sharing slot `s` becomes one group spanning every triangle those
// faces own. Therefore `Σ group.count === index.count === 3 × Σ arity`.
//
// It read `[3t, 3t+3)` until this phase, and that was the same statement while every face was
// a triangle. It stops being true at the first quad, and it stops being true QUIETLY: a box
// would still cover 36 of 36 with six groups of six, because a box is all quads and the
// constant happens to be right there. The sphere is where it separates.
//
// ── WHY THIS IS A STEP WITH ITS OWN FALSIFICATION, NOT ARITHMETIC ASSUMED CORRECT ─────
//
// Two different things were both honestly called "a box's faces", and they differed by 2×:
//
//   the attribute domain `face` = TRIANGLES  → 12 for a box
//   `BoxGeometry.groups`        = CUBE SIDES → 6 for a box, two triangles each
//
// #770 resolved that ambiguity by naming the polygon as the face — the two readings became
// one, and a box's answer is 6 on both. **The error class did not go away with it; it moved.**
// What can now be wrong is the ARITY: an implementation that assumes every polygon is a quad
// is right on a box by accident and wrong on a sphere, whose pole rows are triangles.
//
// So the discriminating fixture had to move too. It was a box with face 0 alone on slot 1,
// asserting the boundary at 3 rather than 6 — and #770 makes `[{0,6,1},{6,30,0}]` the CORRECT
// answer for that box, so the instrument inverts rather than merely breaking. The replacement
// is a mixed-arity SPHERE with pole polygon 0 alone on slot 1, where the same shape holds:
//
//   correct     [{0,3,1},{3,237,0}]   covers 240 of 240
//   constant-2  [{0,6,1},{6,234,0}]   covers 240 of 240   ← same coverage, wrong boundary
//
// Coverage cannot separate them and the BOUNDARY can, which is why the assertion is on the
// boundary and never on coverage — the same reason the box fixture was minted, one
// granularity along.
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
 * The group layout for a per-POLYGON material index over an indexed mesh, or `null` when the
 * derivation declines — with the reason in {@link groupsRefusal}.
 *
 * Runs are coalesced: consecutive faces on the same slot become ONE group, because a group per
 * triangle is a draw call per triangle. The layout is in face order, never sorted by slot —
 * reordering would make groups address triangles they do not cover.
 *
 * `arity` is the triangles each polygon fans to, in build order, and it is a PARAMETER rather
 * than something derived here on purpose: this module imports nothing at all, which is what
 * made it safe to widen the registry's import set to reach it, and deriving an arity means
 * reading a descriptor. The caller already holds one.
 */
export function groupsFromMaterialIndex(
  indices: ArrayLike<number>,
  indexCount: number | null,
  arity: readonly number[],
): MaterialGroup[] | null {
  if (groupsRefusal(indices, indexCount, arity) !== null) return null;

  const groups: MaterialGroup[] = [];
  let runStart = 0;
  // Triangles consumed by faces before `runStart` — the run's own start, carried rather than
  // recomputed, so a group's start and its predecessor's end are one number by construction.
  let trianglesBefore = 0;
  let trianglesInRun = 0;
  for (let f = 0; f < indices.length; f++) {
    trianglesInRun += arity[f];
    const ended = f + 1 === indices.length || indices[f + 1] !== indices[runStart];
    if (!ended) continue;
    groups.push({
      start: trianglesBefore * 3,
      count: trianglesInRun * 3,
      materialIndex: indices[runStart],
    });
    trianglesBefore += trianglesInRun;
    trianglesInRun = 0;
    runStart = f + 1;
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
  arity: readonly number[],
): string | null {
  if (indexCount === null) {
    return 'materialGroups: geometry is NOT INDEXED — groups would address the position attribute, not the index, so the per-face arithmetic does not apply';
  }
  if (indices.length === 0) {
    return 'materialGroups: the face-domain index is empty, so there is no assignment to lay out';
  }
  // #770 — THE ASSIGNMENT AND THE LAYOUT ARE COUNTED SEPARATELY FROM THE GEOMETRY, because
  // they are three things now and were two before. An index of the right LENGTH over a layout
  // that materialises to the wrong number of triangles is a state the old single comparison
  // could not express, and it is the one a half-flipped consumer produces.
  if (indices.length !== arity.length) {
    return `materialGroups: the face-domain index carries ${indices.length} faces but the polygon layout has ${arity.length} — they describe different meshes`;
  }
  let triangles = 0;
  for (const a of arity) triangles += a;
  if (triangles * 3 !== indexCount) {
    return `materialGroups: the polygon layout's ${arity.length} faces materialise to ${triangles} triangles (${triangles * 3} index entries) but the geometry carries ${indexCount} — they describe different meshes`;
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
