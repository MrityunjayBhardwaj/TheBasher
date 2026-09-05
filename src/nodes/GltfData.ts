// GltfData — the DATA half of the object↔data split for an imported glTF child
// (#389, the LAST fused kind). It owns what the child IS — which asset, which child
// inside it, and the materials captured at import — and deliberately no pose. An
// `Object` supplies that, exactly as it does for every other kind.
//
// ── NOT YET REGISTERED, AND THAT IS THE WHOLE SHAPE OF THIS ISSUE ────────────────────
//
// This file lands ahead of its registration on purpose. The moment `GltfData` enters
// the node registry, `splitKinds.registry.gate` requires a conformance descriptor for
// it, and `splitKinds.roads` R9 requires that descriptor's `migratesFromVersion` to be
// BELOW `PROJECT_FORMAT_VERSION` — i.e. a migration that has already shipped. There is
// no honest value for a kind whose split has migrated nothing, so the coexisting
// slice-1 ladder every earlier kind walked (`SphereData`: "nothing migrates in
// C1-Slice-1") is no longer expressible. The conformance machinery hardened after those
// kinds went in, and it now requires a kind to arrive FULLY SPLIT: node + format bump +
// migration + producer flip + the retirement of `GltfChild`, in one change.
//
// So this is the foundation commit: the node and the draw rule, inert and green, with
// the flip behind them. Registering it early would not be a smaller step — it would be
// the same step with a dishonest descriptor in front of it.
//
// ── WHY `MeshData` IS THE RIGHT CONTRACT ─────────────────────────────────────────────
//
// Measured, not assumed. An `Object → Array → GltfData` chain over an imported cube
// builds and draws in its AUTHORED material (`#ff0000`), not the `#808080` fallback the
// renderer produces when a material is narrowed and discarded. That fallback is the
// `BakedData` failure mode, and it does not apply here: the geometry half is a recipe
// the registry can resolve since #367, so the value never has to carry buffers.
//
// ── WHY THE POSE FLAGS LIVE HERE AND NOT ON THE OBJECT ───────────────────────────────
//
// `overridden` is the manual band's win signal: `manual → baked channel → clip → base`
// (resolveGltfChildTransform.ts). It exists because the importer SEEDS a child's TRS
// with its captured base pose, so value-equality cannot tell "the director dragged this
// bone back to base" from "this IS base" — only an explicit flag can, and dropping it
// would let the clip resurface under an author's own edit.
//
// It sits on the DATA half because it is a fact about this object's relationship to the
// asset it was imported from, which is precisely what this node describes. The
// alternative — putting it on `Object` — would give every box, camera and light three
// dead booleans to carry a glTF-only concern, which is the parallel vocabulary this
// epic exists to remove. The pose itself stays on the Object, universal and unchanged.
//
// REF: src/nodes/SphereData.ts (the node template); src/nodes/GltfChild.ts (the fused
//      kind this splits); src/app/resolveGltfChildTransform.ts (the precedence rule);
//      src/app/geometryRegistry.ts (`drawnByAssetClone` — why the Object does not draw);
//      docs/OBJECT-DATA-SPLIT-DESIGN.md §3.1; issues #389, #383, #367.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { GeometryRef, MeshDataValue } from './types';
import { openpbrMaterialSchema } from './materialSchema';
import { materialKeyOf } from './materialKey';

export const GltfDataParams = z.object({
  /** The owning GltfAsset's assetRef — carried verbatim from the fused `GltfChild`. */
  assetRef: z.string().min(1),
  /** The sanitised name key — the SAME key `nodeNameMap` and every clip track use. */
  childName: z.string(),
  /**
   * The child's PRIMARY (lowest-slot) material, captured from the glTF at import.
   *
   * A single spec rather than the array, because that is what `MeshDataValue.material`
   * carries and what the conformance roads compare against under an unchanged path. The
   * rest of the table lives in {@link GltfDataParams.materialSlots}, mirroring exactly
   * how `SetMaterialOp` and `MaterialOverrideOp` already spell a multi-slot mesh
   * (`materialSlots: [source.material, wired]`) — `dataSlotsOnly` reads
   * `materialSlots ?? [material]`, so slot 0 appearing in both places is the
   * established shape, not a duplication introduced here.
   */
  material: openpbrMaterialSchema(),
  /**
   * The FULL captured slot table, in glTF primitive order — present only for a child
   * with more than one primitive. Absent means "one slot, and it is `material`", which
   * is what `dataSlotsOnly` already assumes; writing a one-entry array instead would be
   * a format difference dressed as a default (the same trap `Object.slotOverrides`
   * documents).
   *
   * Nullable entries: a primitive with no material at all is a real glTF state, and
   * `MeshDataValue.materialSlots` is typed to say so rather than synthesising a grey.
   */
  materialSlots: z.array(openpbrMaterialSchema().nullable()).optional(),
  /**
   * The manual-override dirty signal, per TRS component — see the header. `true` means
   * "the director moved this component", so the manual band wins over any active clip.
   * Default all-false: a freshly imported child carries only its captured base.
   */
  overridden: z
    .object({
      position: z.boolean(),
      rotation: z.boolean(),
      scale: z.boolean(),
    })
    .default({ position: false, rotation: false, scale: false }),
});
export type GltfDataParams = z.infer<typeof GltfDataParams>;

export const GltfDataNode: NodeDefinition<GltfDataParams, MeshDataValue> = {
  type: 'GltfData',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: GltfDataParams,
  inputs: {},
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  // Data owns what the child IS, never where it sits: no 'transform'/'constraint' section.
  inspectorSections: ['mesh', 'material'],
  // ⚠️ ONLY `material` is homed, and the omissions are deliberate rather than unfinished.
  //
  // A home names the section that RENDERS a param. `material` renders, exactly as it does
  // on every other data node. The other four do not: `assetRef` and `childName` are the
  // child's ADDRESS (the fused kind homes neither, for the same reason), `materialSlots` is
  // a captured readout, and `overridden` is an internal dirty flag the gizmo write path
  // sets alongside a value — homing it would put three checkboxes in front of a director
  // for a signal they never author.
  //
  // Routing them "for completeness" is the specific trap this split has already paid for
  // once: a declaration written so a field would not look empty, believed afterwards by
  // machinery that reads fields and not the comment beside them. The param-reach gate asks
  // for a CLASSIFICATION of who reads each param, which is a different question from where
  // one renders, and it gets answered at registration where the gate can check the answer.
  home: {
    material: 'material',
  },
  evaluate(params): MeshDataValue {
    // The SAME key `resolveEvaluatedMesh:176` already mints for a glTF child. Spelled
    // once there and once here is one spelling too many, and it is deliberate for this
    // commit only: the producer flip deletes that site, leaving this the sole minter.
    // Two spellings of one cache key is how false sharing gets in, so it does not
    // survive past C3.
    const geometry: GeometryRef = {
      key: `gltf|${params.assetRef}|${params.childName}`,
      descriptor: { kind: 'gltf', assetRef: params.assetRef, childName: params.childName },
    };
    return {
      kind: 'MeshData',
      geometry,
      material: params.material,
      // #536 — minted here for the same reason every other producer mints it after its
      // fold: identity follows the resolved material, not the authored param.
      materialKey: materialKeyOf(params.material),
      ...(params.materialSlots === undefined ? {} : { materialSlots: params.materialSlots }),
      // #633 — null, and NOT "not yet". A glTF child's buffers live in a loaded asset
      // clone this value never sees, so there is no attribute set to derive an identity
      // from. That is the same answer `BakedData` gives, for the same reason.
      attributeKey: null,
    };
  },
};
