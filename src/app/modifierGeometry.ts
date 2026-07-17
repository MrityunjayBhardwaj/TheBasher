// modifierGeometry — the shared geometry-handle projection for the SOP / modifier
// half of [[V58]] (epic #201, #209). A geometry modifier is a `Mesh → Mesh`
// wrapper sub-chain node (the §2.2 model that did NOT fit constraints but DOES fit
// geometry ops, because a modifier needs only the mesh VALUE, never world
// position). It rewrites the source mesh's geometry into a NEW `GeometryRef`
// handle the registry rebuilds on demand (geometryRegistry.build → 'array' case).
//
// THE ONE PLACE that turns a mesh VALUE into a source `GeometryRef` + the ONE
// place that wraps a source ref in an `array` descriptor. Two consumers walk the
// chain on DIFFERENT roads — the DAG evaluator (`ArrayModifier.evaluate`, which
// has the resolved source VALUE) and the pure read-side walk
// (`resolveEvaluatedMesh`, which recurses on the source NODE). Both build the
// array key through `arrayGeometryRef`, so the rendered geometry and the resolved
// geometry share one deterministic key (H40 one-band, no drift) — asserted by the
// boundary-pair e2e + a key-equality unit test.
//
// v1 scope: box/sphere sources (the registry builds them SYNC). A glTF/baked
// source returns null here (its geometry is async — asset clone / OPFS — outside
// the sync registry); modifiers over those are a clean follow-up.
//
// REF: src/app/resolveEvaluatedMesh.ts (the recursive array branch);
//      src/app/geometryRegistry.ts (build 'array'); src/nodes/ArrayModifier.ts;
//      docs/OPERATORS-AND-LIGHTING-DESIGN.md §5 / §2.2; vyapti V58.

import type {
  GeometryRef,
  InlineMaterialSpec,
  MeshTransform,
  MirrorAxis,
  SceneChild,
  Vec3,
} from '../nodes/types';

const IDENTITY_SCALE: Vec3 = [1, 1, 1];
const ORIGIN: Vec3 = [0, 0, 0];

/**
 * The ONE place a box `size` becomes a box `GeometryRef` (deterministic key +
 * descriptor). Shared by the fused `BoxMesh` source projection (below) AND the
 * `BoxData` node of the object↔data split (#361), so both roads hand the registry
 * the identical key → one cached build, byte-identical geometry (H40, no drift).
 */
export function boxGeometryRef(size: Vec3): GeometryRef {
  return {
    key: `box|${size[0]},${size[1]},${size[2]}`,
    kind: 'box',
    descriptor: { kind: 'box', size },
  };
}

/**
 * Project a resolved mesh VALUE into the source `GeometryRef` a modifier consumes.
 * Box/Sphere build the SAME deterministic key `resolveEvaluatedMesh` builds (so
 * the array key matches on both roads). BakedMesh / ModifiedMesh already carry a
 * handle — pass it through (chained modifiers). Returns null for a non-leaf-mesh
 * value (Transform/Group/glTF/Scatter/Character) — out of v1 scope.
 */
export function sourceGeometryRef(value: SceneChild): GeometryRef | null {
  switch (value.kind) {
    case 'BoxMesh':
      return boxGeometryRef(value.size);
    case 'SphereMesh':
      return {
        key: `sphere|${value.radius}|${value.widthSegments}|${value.heightSegments}`,
        kind: 'sphere',
        descriptor: {
          kind: 'sphere',
          radius: value.radius,
          widthSegments: value.widthSegments,
          heightSegments: value.heightSegments,
        },
      };
    case 'BakedMesh':
    case 'ModifiedMesh':
      return value.geometry;
    default:
      return null; // non-leaf-mesh source — out of v1 modifier scope
  }
}

/**
 * The TRS a modifier inherits from its source value so the modified geometry sits
 * exactly where the source mesh was. Box/Sphere/Baked/Modified all carry the full
 * TRS band; a non-leaf source falls back to identity (it won't be modified in v1).
 */
export function sourceTransform(value: SceneChild): MeshTransform {
  switch (value.kind) {
    case 'BoxMesh':
    case 'SphereMesh':
    case 'BakedMesh':
    case 'ModifiedMesh':
      return {
        position: value.position,
        rotation: value.rotation,
        scale: value.scale ?? IDENTITY_SCALE, // C-1 (V10/H14) hydrate guard
      };
    default:
      return { position: ORIGIN, rotation: ORIGIN, scale: IDENTITY_SCALE };
  }
}

/** The inline material a modifier inherits from its source value, or null. */
export function sourceMaterial(value: SceneChild): InlineMaterialSpec | null {
  if (value.kind === 'BoxMesh' || value.kind === 'SphereMesh') return value.material;
  if (value.kind === 'ModifiedMesh') return value.material;
  return null;
}

/**
 * Wrap a source `GeometryRef` in an `array` descriptor: `count` copies of the
 * source, each translated by `i*offset` in the source's LOCAL space, merged. The
 * key folds the source key + params so identical inputs share a registry-cached
 * build (and two different params never false-share, §48). count is clamped ≥1.
 */
export function arrayGeometryRef(source: GeometryRef, count: number, offset: Vec3): GeometryRef {
  const n = Math.max(1, Math.floor(count));
  return {
    key: `array|${source.key}|${n}|${offset[0]},${offset[1]},${offset[2]}`,
    kind: 'array',
    descriptor: { kind: 'array', source, count: n, offset },
  };
}

/**
 * Wrap a source `GeometryRef` in a `mirror` descriptor: reflect the source across
 * the plane through the LOCAL origin whose normal is `axis`, then merge the
 * reflection back with the original (Blender's Mirror → a symmetric whole, 2× the
 * vertices). The key folds the source key + axis so identical inputs share a
 * registry-cached build and two axes never false-share (§48). The ONE place a
 * source ref becomes a mirror descriptor — both the evaluate road
 * (`MirrorModifier.evaluate`) and the read-side walk (`resolveEvaluatedMesh`) call
 * it → one deterministic key on both roads (H40, no drift).
 */
export function mirrorGeometryRef(
  source: GeometryRef,
  axis: MirrorAxis,
  offset: number,
): GeometryRef {
  return {
    key: `mirror|${source.key}|${axis}|${offset}`,
    kind: 'mirror',
    descriptor: { kind: 'mirror', source, axis, offset },
  };
}
