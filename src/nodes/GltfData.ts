// GltfData — the DATA half of the object↔data split for an imported glTF child
// (#389, the LAST fused kind). It owns what the child IS — which asset, which child
// inside it, and the materials captured at import — and deliberately no pose. An
// `Object` supplies that, exactly as it does for every other kind.
//
// ── WHY THIS ARRIVED FULLY SPLIT, IN ONE CHANGE ──────────────────────────────────────
//
// This file first landed AHEAD of its registration, and the reason is worth keeping
// because it shaped the whole issue. The moment `GltfData` enters the node registry,
// `splitKinds.registry.gate` requires a conformance descriptor for it, and
// `splitKinds.roads` R9 requires that descriptor's `migratesFromVersion` to be BELOW
// `PROJECT_FORMAT_VERSION` — i.e. a migration that has already shipped. There is no
// honest value for a kind whose split has migrated nothing, so the coexisting slice-1
// ladder every earlier kind walked (`SphereData`: "nothing migrates in C1-Slice-1") was
// not expressible here. The conformance machinery hardened after those kinds went in,
// and it now requires a kind to arrive FULLY SPLIT: node + format bump + migration +
// producer flip + the retirement of `GltfChild`, together.
//
// It is now registered and live: it produces the value an imported child renders from,
// and `GltfChild` is deleted. The paragraph above is kept as the reason the commit has
// the shape it does, NOT as a description of this file's current state.
//
// ── WHY `MeshData` IS THE RIGHT CONTRACT ─────────────────────────────────────────────
//
// Measured, not assumed. An `Object → Array → GltfData` chain over an imported cube
// builds and draws in its AUTHORED material (`#ff0000`), not the `#808080` fallback the
// renderer produces when a material is narrowed and discarded. That fallback is the
// `BakedData` failure mode, and it does not apply here: the geometry half is a recipe
// the registry can resolve since #367, so the value never has to carry buffers.
//
// ── WHY THE POSE FLAGS DO **NOT** LIVE HERE ──────────────────────────────────────────
//
// `overridden` is the manual band's win signal: `manual → baked channel → clip → base`
// (resolveGltfChildTransform.ts). It exists because the importer SEEDS a child's TRS
// with its captured base pose, so value-equality cannot tell "the director dragged this
// bone back to base" from "this IS base" — only an explicit flag can, and dropping it
// would let the clip resurface under an author's own edit. That much is unchanged.
//
// An earlier draft of this file put the flags HERE, arguing they are a fact about the
// child's relationship to its source asset. That argument was reversed on grounding, and
// the reason is worth keeping because it is not obvious:
//
//   · Blender records an override on the ID that OWNS the overridden property —
//     `IDOverrideLibraryProperty.rna_path` is "RNA path leading to that property, from
//     owning ID", and the container hangs off `ID.override_library`, one per ID. After
//     this split the pose is the OBJECT's property, so the record is the Object's.
//   · Blender answers the identical object↔data question one value over the same way:
//     `material_slots[n].link ∈ {DATA, OBJECT}` puts the discriminant on the Object and
//     defaults to the data.
//   · Basher already ships exactly that shape — `Object.slotOverrides` (#645), whose own
//     comment cites `link == DATA`.
//
// The objection that drove the first draft — "putting it on `Object` gives every box,
// camera and light three dead booleans" — is void for the shape actually used. It is
// `.optional()` and sparse, so a box carries NOTHING, not three `false`s, and there is a
// passing assertion that the key is absent from a plain Object's value
// (`objectSlotOverrides.test.ts` makes the same claim for its sibling).
//
// The decisive constraint is mechanical rather than aesthetic: the panel's override
// decorator resolves the descriptor from ONE node's type and reads the authored bit from
// THAT SAME node's params (`NPanel.overrideInfoFor`), for a param path that must be one
// of that node's own rows. With the bit here and the TRS on the Object, neither key
// works — this node has no TRS rows, and the Object has no bit. Splitting them would
// need a hop that call site does not have.
//
// REF: src/nodes/SphereData.ts (the node template);
//      src/app/resolveGltfChildTransform.ts (the precedence rule);
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
   * The child's PRIMARY (lowest-slot) material, captured from the glTF at import, or
   * `null` when the child has none.
   *
   * NULLABLE AND NOT OPTIONAL, and the difference is the whole point. A bone, an empty
   * and a pre-#178 save all genuinely have no captured material — the fused `GltfChild`
   * said so by OMITTING its `materials` array, and the renderer read that omission as
   * "keep the clone's embedded material" (V10/H14). That answer has to survive the
   * split, and `MeshDataValue.material` is already typed `InlineMaterialSpec | null` to
   * carry it. Making the key required and its value nullable is what keeps the absence
   * LOUD: a migration that failed to carry a material writes nothing and fails to parse,
   * where an optional key would let it pass as "no material" and render the fallback
   * grey — the `BakedData` failure mode, arrived at from the other side.
   *
   * A single spec rather than the array, because that is what `MeshDataValue.material`
   * carries and what the conformance roads compare against under an unchanged path. The
   * rest of the table lives in {@link GltfDataParams.materialSlots}, mirroring exactly
   * how `SetMaterialOp` and `MaterialOverrideOp` already spell a multi-slot mesh
   * (`materialSlots: [source.material, wired]`) — `dataSlotsOnly` reads
   * `materialSlots ?? [material]`, so slot 0 appearing in both places is the
   * established shape, not a duplication introduced here.
   */
  material: openpbrMaterialSchema().nullable(),
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
  //
  // 'material' ALONE, and 'mesh' is deliberately absent — the same list `BakedData`
  // declares, for the same reason. A section is a promise that something renders in it,
  // and the reachability gate asks the inspector's own table whether anything does. The
  // box and the sphere lead with 'mesh' because their geometry is AUTHORED there (`size`,
  // `radius`). A glTF child's geometry is not authored at all: it is whatever the asset
  // contains, and its two identifying params are an ADDRESS rather than a control. So a
  // declared 'mesh' here would be a titled, permanently empty card — the #458 defect,
  // which is exactly what the gate reds on.
  inspectorSections: ['material'],
  // ⚠️ ONLY `material` is homed, and the omissions are deliberate rather than unfinished.
  //
  // A home names the section that RENDERS a param. `material` renders, exactly as it does
  // on every other data node. The other four do not: `assetRef` and `childName` are the
  // child's ADDRESS (the fused kind homes neither, for the same reason), and `materialSlots` is
  // a captured readout.
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
      // fold: identity follows the resolved material, not the authored param. NULL
      // EXACTLY WHEN `material` IS, which the value's own doc states as an invariant:
      // `materialKeyOf(null)` answers the string `'n'`, a perfectly good key for a
      // material that does not exist, and two materialless children sharing it would
      // read as "these draw one material" to every downstream identity consumer.
      materialKey: params.material === null ? null : materialKeyOf(params.material),
      ...(params.materialSlots === undefined ? {} : { materialSlots: params.materialSlots }),
      // #633 — null, and NOT "not yet". A glTF child's buffers live in a loaded asset
      // clone this value never sees, so there is no attribute set to derive an identity
      // from. That is the same answer `BakedData` gives, for the same reason.
      attributeKey: null,
    };
  },
};
