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
// Since #1053 it no longer produces geometry. Every new import is native or refused, so a
// `GltfData` exists only in a save the load converter kept unconverted, and it evaluates to
// no data (its Object is an Empty). The params stay: the saved document keeps them as saved,
// and the converter reads them on every load. The paragraph above is kept as the reason the
// node has the shape it does, NOT as a description of what it does now.
//
// ── WHY THE POSE FLAGS DO **NOT** LIVE HERE ──────────────────────────────────────────
//
// `overridden` is the manual band's win signal: `manual → baked channel → clip → base`
// (resolveGltfChildTransform.ts (gone in #1053; at 7e1356c7)). It exists because the importer SEEDS a child's TRS
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
//      app/resolveGltfChildTransform.ts (gone in #1053; at 7e1356c7) (the precedence rule);
//      src/nodes/ObjectNode.ts (`data: null` is an Empty — what a kept import is);
//      docs/OBJECT-DATA-SPLIT-DESIGN.md §3.1; issues #389, #383, #367.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import { openpbrMaterialSchema } from './materialSchema';

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
  /**
   * HOW MANY FACES THIS CHILD HAS, captured from the glTF JSON at import (#1023) — the
   * first element fact an imported mesh states about itself.
   *
   * OPTIONAL, and absent means WE NEVER CAPTURED IT rather than "no faces". Three
   * populations have no readout and all three must keep answering as they do today: every
   * save written before #1023, every child that is not a mesh at all (a bone, an empty),
   * and every child whose primitives are not all triangles. A reader that treats the
   * missing key as `0` turns "we cannot say" into a confident wrong answer, which is the
   * same collapse `MaterialAssignment` exists to prevent for an unanswered material slot.
   *
   * Optional rather than required-and-nullable, unlike {@link GltfDataParams.material}:
   * that key is required so a migration which drops a material FAILS TO PARSE, because a
   * silently materialless child renders the grey fallback and looks plausible. Nothing
   * renders from a face count, so a dropped one degrades to today's `null` answer rather
   * than to a wrong picture — the loudness that argument buys is not needed here.
   */
  faceCount: z.number().int().nonnegative().optional(),
  /**
   * HOW MANY TOPOLOGICAL POINTS the imported child holds, welded at import (#1040).
   *
   * Optional and non-negative on the same reasoning as {@link GltfDataParams.faceCount}
   * above: nothing RENDERS from a point count, so a migration that drops it degrades to the
   * pre-capture `outside-the-descriptor` answer rather than to a wrong picture, and the
   * loudness a required-and-nullable key would buy is not needed.
   *
   * Its absent population is one member WIDER than the face count's, and deliberately: a
   * multi-primitive child gets no point count, because the read door holds only its first
   * primitive's buffer while a weld across all of them would describe no buffer at all.
   */
  pointCount: z.number().int().nonnegative().optional(),
});
export type GltfDataParams = z.infer<typeof GltfDataParams>;

export const GltfDataNode: NodeDefinition<GltfDataParams, null> = {
  type: 'GltfData',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: GltfDataParams,
  inputs: {},
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  // Data owns what the child IS, never where it sits: no 'transform'/'constraint' section.
  //
  // 'material' is still declared although a kept import draws nothing (#1053): the load
  // converter carries `material` and `materialSlots` when the import converts, so an edit made
  // here is kept, it is just not seen until then.
  inspectorSections: ['material'],
  home: {
    material: 'material',
  },
  // #1053 — a kept import evaluates to NO data, so its Object is an Empty (`ObjectNode`:
  // `data: null` is an Empty): it keeps its name, transform and parent and draws nothing.
  // Every new import is native or refused, so this node only survives in a save the load
  // converter kept unconverted, and the file's geometry was never read into the model.
  // A `gltf` geometry kind here would answer every question for a mesh nothing draws;
  // the absence of data is the true answer (decided on #1053, 2026-09-30).
  evaluate(): null {
    return null;
  },
};
