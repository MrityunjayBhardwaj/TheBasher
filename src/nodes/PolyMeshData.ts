// PolyMeshData — the DATA half of a stored polygon mesh (#1049): geometry that IS its data.
//
// ── WHAT THIS IS ─────────────────────────────────────────────────────────────────────────────
//
// Blender's glTF importer turns a file into an ordinary Mesh datablock saved inside the `.blend`,
// and nothing downstream can tell it was imported (measured on 5.1.1: a 130,553-vertex import
// survives deleting the source). This node is that datablock in the Object/data split. The mesh
// lives in its params, packed (see `src/app/meshGeometryData.ts` for why packed), and it evaluates
// to the same `MeshData` value a box does, so an `Object` over it draws, transforms and takes
// modifiers through the road a box takes. Any producer may write one — the glTF reader is the
// first — and nothing downstream asks which one did.
//
// Named `PolyMeshData` rather than `MeshData` because `MeshData` is already the VALUE kind every
// mesh producer emits, checked exhaustively in several places; a node type spelled the same would
// make every search for one land on the other.
//
// ── WHY THE DATA IS CHECKED AT THE DOOR ──────────────────────────────────────────────────────
//
// A malformed mesh is refused when its params are parsed, which is the op that tries to add or
// set it. It is never refused inside `evaluate`: that runs on the render walk with nothing above
// it to catch a throw, and a bad mesh there would take the viewport down rather than refuse one
// edit.
//
// ── WHY `mesh` IS NOT AN INSPECTOR SECTION ───────────────────────────────────────────────────
//
// A section promises something renders in it, and nothing edits a stored mesh's elements yet. A
// declared `mesh` section would be a titled, permanently empty card — the reason `GltfData` and
// `BakedData` declare `material` alone.
//
// ── #1117 — VERSION 2: CORNER DATA IS A NAMED LIST ───────────────────────────────────────────
//
// Version 1 kept UVs in a fixed `cornerUVs` field, so a mesh could hold one UV set and nothing
// else. Version 2 keeps every UV set and colour in `cornerLayers`. The migration moves a version-1
// `cornerUVs` string into that list as `UVMap`, byte for byte, so an old save draws exactly what it
// drew: `src/core/project/polyMeshV1Fixture.test.ts` holds a real version-1 save captured before
// this change and checks every drawn corner.
//
// REF: src/app/meshGeometryData.ts (packing, key, build), src/app/polygonLayout.ts (the data
//      check), src/nodes/BoxData.ts (the producer template); issues #1049, #1054, #1117, #628.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { MeshCornerLayerType, MeshDataValue, MeshFaceLayerType } from './types';
import { UV_MAP } from './attributes';
import { openpbrMaterialSchema } from './materialSchema';
import { materialKeyOf } from './materialKey';
import { mintMeshAttributes } from './meshAttributes';
import { meshGeometryRef, unpackMeshData } from '../app/meshGeometryData';
import { meshDataProblem } from '../app/polygonLayout';
import { refWithAttributeKey } from '../app/modifierGeometry';

/** The corner layer types a stored mesh holds, spelled once for the schema. */
const CORNER_LAYER_TYPES = ['float2', 'float4'] as const satisfies readonly MeshCornerLayerType[];

/** The face layer types a stored mesh holds (#1052). */
const FACE_LAYER_TYPES = ['int'] as const satisfies readonly MeshFaceLayerType[];

/** The packed mesh, refused at parse time unless it decodes to a well-formed mesh. */
export const PackedMeshSchema = z
  .object({
    points: z.string(),
    faceSizes: z.string(),
    cornerPoints: z.string(),
    cornerLayers: z.array(
      z.object({ name: z.string(), type: z.enum(CORNER_LAYER_TYPES), data: z.string() }),
    ),
    cornerNormals: z.string().nullable(),
    faceLayers: z.array(
      z.object({ name: z.string(), type: z.enum(FACE_LAYER_TYPES), data: z.string() }),
    ),
  })
  .superRefine((packed, ctx) => {
    let problem: string | null;
    try {
      problem = meshDataProblem(unpackMeshData(packed));
    } catch (err) {
      // An odd byte count or invalid base64 throws while decoding; it is the same refusal.
      problem = `it does not decode (${err instanceof Error ? err.message : String(err)})`;
    }
    if (problem !== null) ctx.addIssue({ code: 'custom', message: `not a mesh: ${problem}` });
  });

export const PolyMeshDataParams = z.object({
  mesh: PackedMeshSchema,
  /**
   * The mesh's material, or `null` when it has none. Required and nullable, as on `GltfData`:
   * a producer that dropped a material fails to parse instead of passing as "no material".
   * On a mesh with several slots this is slot 0, and the table below is what draws.
   */
  material: openpbrMaterialSchema().nullable(),
  /**
   * #1052 — the full slot table, present only when the mesh has more than one slot, in the shape
   * `GltfData` and `SetMaterialOp` already write: absent means "one slot, and it is `material`",
   * which is what `dataSlotsOnly` assumes. The mesh's `material_index` face layer says which slot
   * each face uses. Nullable entries, because a glTF primitive with no material is a real state.
   *
   * A face naming a slot past the table is not refused here: a registered param schema stays a
   * plain object, which the schema censuses depend on. The draw handles it instead — its group
   * layout then covers less than the index, and `resolveMeshMaterial` draws the first material
   * and says why.
   */
  materialSlots: z.array(openpbrMaterialSchema().nullable()).optional(),
});
export type PolyMeshDataParams = z.infer<typeof PolyMeshDataParams>;

/**
 * Version 1 → 2 (#1117): a fixed `cornerUVs` string becomes the `UVMap` entry of `cornerLayers`,
 * byte for byte, and `null` becomes no layer. Every other param rides through untouched, and the
 * retired key is dropped by name rather than by a spread that happens to omit it. A mesh already in
 * the version-2 shape, or params with no mesh at all, are returned as they are.
 */
export function migrateCornerUVsToLayers(params: unknown): unknown {
  const p = (params ?? {}) as Record<string, unknown>;
  const mesh = p.mesh;
  if (mesh === null || typeof mesh !== 'object' || Array.isArray(mesh) || !('cornerUVs' in mesh)) {
    return p;
  }
  const { cornerUVs, ...rest } = mesh as Record<string, unknown>;
  const cornerLayers =
    typeof cornerUVs === 'string' ? [{ name: UV_MAP, type: 'float2', data: cornerUVs }] : [];
  return { ...p, mesh: { ...rest, cornerLayers } };
}

/**
 * Version 2 → 3 (#1052): a stored mesh gains a list of face layers, and every mesh saved before it
 * has none. An empty list draws exactly what the missing field did — every face on the one slot.
 * A mesh already carrying the list, or params with no mesh, are returned as they are.
 */
export function migrateAddFaceLayers(params: unknown): unknown {
  const p = (params ?? {}) as Record<string, unknown>;
  const mesh = p.mesh;
  if (mesh === null || typeof mesh !== 'object' || Array.isArray(mesh) || 'faceLayers' in mesh) {
    return p;
  }
  return { ...p, mesh: { ...(mesh as Record<string, unknown>), faceLayers: [] } };
}

export const PolyMeshDataNode: NodeDefinition<PolyMeshDataParams, MeshDataValue> = {
  type: 'PolyMeshData',
  // #1117 — BUMPED 1 → 2 by `cornerUVs` moving into `cornerLayers`. Without the bump the schema
  // would refuse an old save's mesh on the way in, and the migration below would never run.
  // #1052 — BUMPED 2 → 3 by `faceLayers`, for the same reason: an old save's mesh has no such
  // field, and the schema would refuse it before a migration could add one.
  version: 3,
  migrations: {
    1: migrateCornerUVsToLayers,
    2: migrateAddFaceLayers,
  },
  pure: true,
  cost: 'cheap',
  paramSchema: PolyMeshDataParams,
  inputs: {},
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  inspectorSections: ['material'],
  home: {
    material: 'material',
  },
  evaluate(params): MeshDataValue {
    // The attribute set is minted from the stored mesh's own face count and folded into the
    // geometry key, exactly as a box does it (#638): the per-face slot layout lives on the built
    // geometry instance, so two meshes with different layouts must not share one.
    const ref = meshGeometryRef(params.mesh);
    const attributeKey = mintMeshAttributes(ref.descriptor, 'evaluate');
    return {
      kind: 'MeshData',
      geometry: refWithAttributeKey(ref, attributeKey),
      material: params.material,
      // Null exactly when `material` is, for the reason `GltfData` gives: `materialKeyOf(null)`
      // is a perfectly good key for a material that does not exist.
      materialKey: params.material === null ? null : materialKeyOf(params.material),
      attributeKey,
      ...(params.materialSlots === undefined ? {} : { materialSlots: params.materialSlots }),
    };
  },
};
