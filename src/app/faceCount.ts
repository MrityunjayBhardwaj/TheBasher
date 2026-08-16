// #638 (ns-1b) — the descriptor's face count, in a LEAF.
//
// ── WHY THIS IS ITS OWN MODULE, AND NOT A FUNCTION IN `modifierGeometry.ts` ────────────
//
// It has two consumers that must not be able to reach each other:
//
//   `src/nodes/meshAttributes.ts`  mints a face-domain attribute and needs the count.
//   `src/app/geometryRegistry.ts`  gates the built geometry against the count before it
//                                  derives groups from an index (ns-1b step 4).
//
// While `faceCountOf` lived in `modifierGeometry.ts` those two could not both depend on it.
// `rebuildGeometryRef` (in `modifierGeometry.ts`) has to call `mintMeshAttributes` (in
// `meshAttributes.ts`) to re-mint an attribute component on the overlay road, while
// `meshAttributes.ts` imported `faceCountOf` back out of `modifierGeometry.ts` — a mutual
// cycle. Neither module may own the count; hence this leaf.
//
// ⚠️ The second reason is LEAF SHAPE, and it is deliberately not stated as a cycle, because
// it is not one. `geometryRegistry.ts` imports exactly three things — `three`,
// `BufferGeometryUtils`, and `type GeometryRef`. Importing the count from
// `modifierGeometry.ts` would drag four transitive modules (`evaluator`, `registry`,
// `dataSectionCapability`, `hash`) into a leaf's graph. **Measured: `modifierGeometry.ts`
// does not import `geometryRegistry` at all** — the two textual hits in that file are
// comments — so the shape cost is real and the cycle claim would have been false. Pinned by
// `tools/gates/moduleShape.ts`, so the leaf cannot quietly regrow a graph.
//
// This module imports ONE type and nothing else. That is the invariant it exists to hold.
//
// REF: src/nodes/meshAttributes.ts (the mint); src/app/geometryRegistry.ts (the gate);
//      src/app/faceCount.gate.test.ts (the count is checked against BUILT geometry);
//      issues #633, #638.

import type { GeometryDescriptor } from '../nodes/types';
// ns-2 step 12.5 — a scoped generator's count needs to know how many elements its query
// names. `scopeQuery.ts` is a LEAF with zero value imports, which is what keeps this one a
// leaf too: the property this module holds is not "one import" for its own sake, it is that
// nothing it depends on can depend back on it. `componentSelection.ts` could not have
// served, because it imports this module — a measured cycle, and the reason the language
// moved below all three of its consumers rather than into one of them.
import { scopeSelectedCount } from '../nodes/scopeQuery';

/**
 * How many FACES a descriptor tessellates to, or `null` when that is not derivable from
 * params alone.
 *
 * #633 — a face-domain attribute must carry exactly as many elements as the geometry has
 * faces, and the mint happens in a node's `evaluate()`: pure, synchronous, and with no
 * business building a `BufferGeometry`. So the count has to come from the descriptor.
 *
 * ⚠️ THIS IS A SECOND SPELLING OF THREE.JS'S TESSELLATION, and a second spelling that agrees
 * today is the whole hazard. It is made safe the only way that works: ONE function, plus
 * `faceCount.gate.test.ts`, which builds each sync-buildable descriptor through the registry
 * and asserts the built triangle count matches this — including at the clamp edges, where
 * three.js quietly raises a sphere's segments to its own minimum.
 *
 * The two `null` arms are the escape hatch and are censused exactly by that gate:
 *   `gltf`  — the buffers live in a loaded asset clone; nothing on the descriptor says how
 *             many triangles they hold.
 *   `baked` — the descriptor carries a vertex count, not a face count, and the authoritative
 *             bytes are in OPFS. Deriving faces from vertices would be a guess about
 *             indexing, which is exactly the kind of agrees-today arithmetic this comment
 *             exists to refuse.
 */
export function faceCountOf(descriptor: GeometryDescriptor): number | null {
  switch (descriptor.kind) {
    case 'box':
      // Six quads, two triangles each — independent of size, and independent of the
      // segment counts the descriptor does not carry.
      return 12;
    case 'sphere': {
      // three.js clamps to its own minimum before tessellating, so this clamps first too;
      // the poles contribute one triangle per column instead of two, hence (h - 1).
      const w = Math.max(3, Math.floor(descriptor.widthSegments));
      const h = Math.max(2, Math.floor(descriptor.heightSegments));
      return 2 * w * (h - 1);
    }
    // ── ns-2 step 12.5 — THE SCOPED ARMS ────────────────────────────────────────────
    //
    // A SCOPED GENERATOR PRESERVES ITS WHOLE INPUT AND GENERATES FROM THE SUBSET (plan
    // §2.2). So the count is `source + subset x (copies generated)`, and it degenerates to
    // the unscoped product exactly when the subset is the whole input — which is why the
    // unscoped arm is not a special case below, it is `subset === source`.
    //
    // For MIRROR the rule is GROUNDED: Houdini's Mirror SOP documents *Keep Original* —
    // "Preserves the input geometry" — while *Group* is "Primitives to mirror". For ARRAY
    // it is OURS, extended from Mirror by consistency: copy 0 sits at the identity offset
    // and is the preserved input; copies 1..n-1 are generated from the subset. Copy and
    // Transform's page does not decide it, and `subset x count` reads its wording just as
    // well — the row that makes the choice visible rather than assumed is `count = 1`
    // yielding the whole source, which is why it is an exit criterion and not a comment.
    //
    // 🔴 THIS AND THE BUILDER MUST MOVE TOGETHER. They are one claim spelled twice — the
    // arithmetic here, the merge in `geometryRegistry.ts` — and `build()` consults
    // `faceCountMismatch` before deriving a group layout, so a scoped build whose count
    // was left unamended warns and returns the geometry with its MATERIAL GROUPS DROPPED.
    // Parity (`faceCount.gate.test.ts`) catches ONE of them drifting; it is green when
    // NEITHER honours the field, which is why the literal `24` lives beside it in
    // `scopedGeneratorBuild.gate.test.ts`.
    case 'array': {
      const source = faceCountOf(descriptor.source.descriptor);
      if (source === null) return null;
      const copies = Math.max(1, Math.floor(descriptor.count));
      const subset = subsetCountOf(descriptor.scope, source);
      return source + subset * (copies - 1);
    }
    case 'mirror': {
      const source = faceCountOf(descriptor.source.descriptor);
      if (source === null) return null;
      return source + subsetCountOf(descriptor.scope, source);
    }
    case 'gltf':
    case 'baked':
      return null;
    default: {
      const unreachable: never = descriptor;
      throw new Error(`faceCountOf: undeclared descriptor kind ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * How many of a source's `total` elements a generator's scope names — `total` when it is
 * unscoped.
 *
 * The unscoped answer is the SAME expression rather than a branch around it, so the two
 * cases cannot drift: an unscoped generator is one whose subset is everything, which is
 * exactly what makes `source + subset x (count - 1)` collapse back to `source x count`.
 */
function subsetCountOf(scope: string | undefined, total: number): number {
  return scope === undefined ? total : scopeSelectedCount(scope, total);
}

/**
 * Why a built geometry disagrees with its descriptor's face count, or `null` when they
 * agree — the refusal ns-1b step 4 consults before deriving groups from an index.
 *
 * A triangle-indexed geometry carries `3 × faceCount` index entries. When it does not, the
 * per-face attribute and the geometry are describing different meshes, and a group layout
 * derived from the index would be silently wrong — covering some other mesh's triangles.
 * Refusing BY NAME is the difference between a message that says which two numbers
 * disagreed and a mesh that renders one material for reasons nobody can reconstruct.
 *
 * Returns `null` — meaning "no objection" — for a descriptor with no derivable count
 * (`gltf` / `baked`), because there is nothing to disagree with, and for a geometry with no
 * index, which is a different condition with a different answer and is not this gate's to
 * refuse.
 */
export function faceCountMismatch(
  descriptor: GeometryDescriptor,
  indexCount: number | null,
): string | null {
  const faces = faceCountOf(descriptor);
  if (faces === null || indexCount === null) return null;
  const expected = faces * 3;
  if (indexCount === expected) return null;
  return `faceCount: descriptor '${descriptor.kind}' derives ${faces} faces (${expected} index entries) but the built geometry carries ${indexCount}`;
}

/**
 * Why a built geometry has no triangles at all, or `null` when it has some (ns-2 D6b).
 *
 * ── WHY THE TRIGGER IS THE BUILT INDEX AND NOT A `null` FROM THE MERGE ────────────────
 *
 * The plan's first revision guarded a different state: *"if `mergeGeometries` returns
 * `null`…"*. Measured, it does not. `merge([full, empty])` returns a valid geometry with
 * index 36 and 48 dead positions; `merge([empty])` returns one with index 0. A valid
 * geometry that draws nothing is quieter than a `null` would have been — the renderer
 * attaches it, nothing errors, and the object is simply not there. So the refusal is
 * written against the state that exists.
 *
 * ⚠️ AND ITS REACHABLE POPULATION IS EMPTY TODAY, WHICH IS SAID HERE RATHER THAN IMPLIED.
 * Under §2.2's rule a scoped generator preserves its WHOLE input, so a scope selecting
 * nothing yields the source unchanged — 12 faces for a box, never 0. No descriptor this
 * phase can construct drives a build to an empty index, and the gate says so with a
 * census. It is kept for two reasons, both stated: it is the detector for a semantic
 * change that makes copy 0 a subset too (the rival reading of Copy and Transform's
 * wording), and an empty draw is the quietest failure this road can produce. Because
 * nothing reaches it, the gate proves the INSTRUMENT works by calling it directly —
 * a guard whose subject never arrives reads as "no objection" forever ([[H360]]).
 *
 * Says nothing for a NON-indexed geometry: that is a different condition with a different
 * answer, and it is the one that makes coverage undefined rather than violated — the same
 * separation {@link faceCountMismatch} already draws.
 */
export function zeroIndexRefusal(
  descriptor: GeometryDescriptor,
  indexCount: number | null,
): string | null {
  if (indexCount === null || indexCount > 0) return null;
  return `faceCount: descriptor '${descriptor.kind}' built a geometry with an EMPTY index (${indexCount} entries) — it would attach and draw nothing`;
}

/**
 * Why a face-domain attribute does not fit a descriptor, or `null` when it does.
 *
 * Separate from {@link faceCountMismatch} because the two catch different mistakes at
 * different moments: this one compares an ATTRIBUTE's element count against the descriptor
 * at mint time; that one compares the BUILT geometry against the descriptor at build time.
 * A single function taking both would let a caller pass one and default the other, which is
 * how a gate silently stops checking half of what it names.
 *
 * ⚠️ NO PRODUCTION CALLER TODAY, AND THAT IS SAID HERE RATHER THAN LEFT TO BE DISCOVERED
 * (#654). Every mint site in this repo derives its element count from {@link faceCountOf} on
 * the same descriptor, so a mint-time disagreement has no constructor — the guard would be
 * comparing a number against itself. The disagreement that IS reachable arrives later, when a
 * handle carries an attribute key its rebuilt or merged geometry no longer fits, and that one
 * is caught by {@link faceCountMismatch} in the registry, against the geometry three.js
 * actually built.
 *
 * So this is the arm for a producer that carries a count from somewhere else — an importer,
 * or a stored set read back against a descriptor — and it stays here, tested, for the moment
 * one exists. What it must NOT be read as is a live check on the mint: a named guard that
 * never runs is worse than an open gap, because a reader who finds it stops looking.
 */
export function faceAttributeMismatch(
  descriptor: GeometryDescriptor,
  attributeCount: number,
): string | null {
  const faces = faceCountOf(descriptor);
  if (faces === null) return null;
  if (attributeCount === faces) return null;
  return `faceCount: descriptor '${descriptor.kind}' derives ${faces} faces but the face-domain attribute carries ${attributeCount}`;
}
