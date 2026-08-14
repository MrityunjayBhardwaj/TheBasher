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
    case 'array': {
      const source = faceCountOf(descriptor.source.descriptor);
      return source === null ? null : source * Math.max(1, Math.floor(descriptor.count));
    }
    case 'mirror': {
      const source = faceCountOf(descriptor.source.descriptor);
      return source === null ? null : source * 2;
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
