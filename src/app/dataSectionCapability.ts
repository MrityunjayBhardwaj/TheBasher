// dataSectionCapability — for a data kind and a data-dependent inspector section,
// can that kind host the section AT ALL, and if not, is that permanent or unbuilt?
//
// WHY THIS EXISTS (#498)
// `ObjectNode` declares `inspectorSections: ['transform','constraint','driver','modifier']`
// unconditionally, and nothing filters it by the data underneath. Three of those four are
// correct that way — the Object owns the pose, so 'transform' (and therefore 'constraint'
// and 'driver') applies whatever the data is. 'modifier' is the odd one: a modifier
// reshapes what a thing is MADE OF, and a camera is not made of anything. Measured on the
// default project, `n_camera`, `n_light` and `n_box` all reported `modifierSection=true`
// with two add buttons, and clicking "+ Array" on the camera SUCCEEDED — an `ArrayModifier`
// was minted and spliced into `CameraData → ArrayModifier → Object.data`, inert but real
// and persistable.
//
// WHY A SECOND PREDICATE, WHEN `canModifyGeometry` ALREADY EXISTS
// They answer different questions, and the difference is the whole content of this file:
//
//   canModifyGeometry(state, id)  — can this source be reshaped RIGHT NOW?
//   dataSectionCapability(kind,s) — could a source of this KIND ever host section `s`?
//
// `canModifyGeometry` returns false identically for a curve, a light and a camera, so it
// cannot tell "never" from "not yet". That distinction is not a nicety — it is measured.
// Blender 5.1.1 accepts 0 modifier types on a camera and 0 on a light, but 28 on a curve
// (`ref/GROUND_TRUTH_BLENDER_MODIFIER_DATA.md` §9). So a curve's empty stack is a REAL GAP
// in Basher (#349) and a camera's is a category error. Collapsing them to one state would
// harden the curve gap into a design decision, which is the specific failure this issue was
// filed to avoid.
//
// They must not contradict each other, and that is CHECKED rather than trusted: the gate in
// `dataSectionCapability.test.ts` asserts that wherever `modifierDataSource` returns a
// source, this table says 'supported', over every member of `ObjectData`. Two predicates
// that answer different questions are not a second source of truth; two that could disagree
// about the SAME question would be, which is why the consistency assertion is here and not
// left to review.
//
// WHAT GROUNDS THE ANSWER, AND WHAT DOES NOT
// The reference grounds the ACCEPT and not the OFFER, measured live on Blender 5.1.1 rather
// than assumed: `obj.modifiers.new('ARRAY')` returns a modifier on a mesh and on a curve,
// and returns `None` — silently, no exception — on a camera, a light and an empty. But every
// poll reachable from Python returns true for all five, including `DATA_PT_modifiers.poll()`
// on an Empty. So Blender does NOT refuse by hiding the affordance, and it is not a model
// for what the panel should SHOW. What licenses the offer half here is Basher's own rule
// that a management surface must offer exactly what its dispatcher accepts (#377, [[V108]])
// — the same rule that deleted this file's predecessor, a hardcoded `SUPPORTED_BASE_TYPES`
// set that had drifted in both directions at once.
//
// WHY IT IS KEYED ON THE VALUE KIND AND NOT THE NODE TYPE
// #377's list named `BoxMesh` (retired) and omitted `Object` (live), so it called every real
// cube unsupported while advertising a relic. Keying on the evaluated value's `kind` is what
// stopped that, and `modifierDataSource` is closed by a `never` for the same reason. This
// table is keyed the same way and closed the same way: a new `ObjectData` member is a
// COMPILE ERROR here, at the one site that has to decide what the new kind can host.
//
// REF: src/app/modifierDataSource.ts (`modifierDataSource` — the can-it-now half);
//      src/app/objectDataBand.ts (the shape this follows: a named, never-closed classifier);
//      src/nodes/ObjectNode.ts (the unconditional declaration this exists to qualify);
//      ref/GROUND_TRUTH_BLENDER_MODIFIER_DATA.md §9. Issues #498, #349, #394.

import type { ObjectData } from '../nodes/types';

/** The kind tag of every member of the `ObjectData` union. */
export type ObjectDataKind = ObjectData['kind'];

/**
 * The inspector sections whose applicability depends on the DATA under an Object,
 * rather than on the Object itself.
 *
 * Deliberately NOT `SectionId`. Of the four sections `ObjectNode` declares, only
 * 'modifier' is data-dependent — 'transform', 'constraint' and 'driver' are properties
 * of the Object, which owns the pose no matter what it points at, and they are correctly
 * unconditional.
 *
 * #394 S3d WIDENED IT WITH 'material', which this file predicted it would. The two are not
 * symmetric and the difference is worth stating: 'modifier' is declared unconditionally by
 * `ObjectNode` and needs this table to qualify it, whereas 'material' is declared by the
 * DATA nodes themselves — a `CameraData` simply never lists it, so the SECTION already
 * hides itself. What the table adds for 'material' is the ACCEPT half: the material lane's
 * `target` socket takes any `ObjectData`, so `buildAddMaterialOpOps` would otherwise mint
 * a real, persistable, permanently inert operator over a camera exactly as "+ Array" once
 * did (#498). One table, asked by both halves, is what keeps offer == accept ([[V108]]).
 */
export type DataDependentSection = 'modifier' | 'material';

/** The section applies to this kind, and the machinery to honour it exists. */
export interface CapabilitySupported {
  readonly state: 'supported';
}

/**
 * The section legitimately applies to this kind in the reference, but Basher has not
 * built it. The affordance stays visible and says so — hiding it would turn a tracked
 * gap into an implicit claim that the gap is intentional. Must name the issue.
 */
export interface CapabilityNotYet {
  readonly state: 'not-yet';
  readonly reason: string;
  readonly issue: number;
}

/**
 * The section cannot apply to this kind, and no future work changes that. Must carry the
 * reference measurement that establishes it, so a later reader can check the claim rather
 * than inherit it.
 */
export interface CapabilityNever {
  readonly state: 'never';
  readonly reason: string;
}

export type SectionCapability = CapabilitySupported | CapabilityNotYet | CapabilityNever;

/**
 * Can a source of this data kind host this section?
 *
 * Total over `ObjectDataKind` by construction — the `Record` type forces an entry for
 * every member, so a new `ObjectData` kind fails to compile until it is classified.
 * That is the point: the defensive-looking `default:` arm is the bug ([[V109]]).
 */
const MODIFIER_CAPABILITY: Record<ObjectDataKind, SectionCapability> = {
  // The three mesh faces. `modifierDataSource` returns a geometry handle + an inherited
  // material for exactly these, and the gate asserts that correspondence both ways.
  MeshData: { state: 'supported' },
  BakedData: { state: 'supported' },
  // The chain case — a modifier over a modifier's output. This is why the stack composes
  // at all, so it must be 'supported' rather than an afterthought.
  ModifiedData: { state: 'supported' },

  CurveData: {
    state: 'not-yet',
    reason:
      'Blender 5.1.1 accepts 28 modifier types on a curve, so this is a real gap in Basher ' +
      'rather than a category error. The stack stays visible and says "not supported yet" ' +
      'so the gap keeps reading as a gap.',
    issue: 349,
  },

  LightData: {
    state: 'never',
    reason:
      'A modifier reshapes what a thing is made of, and a light is not made of anything. ' +
      'Measured: Blender 5.1.1 accepts 0 modifier types on a light, and obj.modifiers.new() ' +
      'returns None there.',
  },
  CameraData: {
    state: 'never',
    reason:
      'Same as a light — nothing to reshape. Measured: Blender 5.1.1 accepts 0 modifier ' +
      'types on a camera, and obj.modifiers.new() returns None there.',
  },
};

/**
 * Can a source of this data kind WEAR a material? (#394 S3d.)
 *
 * GROUNDED IN THE REFERENCE, PROPERTY BY PROPERTY, because the answer here is a datablock
 * fact rather than a poll result — which is what makes it stronger evidence than the
 * modifier table's ([[H230]]: a reference can ground the accept and be silent on the
 * offer; here it grounds both, because the property either exists on the datablock or it
 * does not). Read off the Blender 5.1 Python API reference:
 *
 *   bpy.types.Mesh.materials    — declared (`IDMaterials[Material]`)
 *   bpy.types.Curve.materials   — declared, the SAME collection type
 *   bpy.types.Light             — no `materials` property at all
 *   bpy.types.Camera            — no `materials` property at all
 *
 * So the three-state answer is forced by the reference rather than chosen, exactly as it
 * was for modifiers, and it lands on the same partition: the mesh faces carry materials, a
 * curve legitimately does and Basher has not built it, a light and a camera never will.
 */
const MATERIAL_CAPABILITY: Record<ObjectDataKind, SectionCapability> = {
  // The three mesh faces. Each carries a `material` on its value and declares the
  // 'material' section, so the lane's operators have something to compose over.
  MeshData: { state: 'supported' },
  BakedData: { state: 'supported' },
  // The chain case, and it is load-bearing rather than an afterthought: a material
  // operator over a geometry modifier's output is the interleaved lane #526 exists for.
  ModifiedData: { state: 'supported' },

  CurveData: {
    state: 'not-yet',
    reason:
      'bpy.types.Curve declares the same `materials` collection bpy.types.Mesh does, so a ' +
      'curve legitimately wears a material in the reference. CurveDataValue carries no ' +
      'material field and CurveData declares no material section, so this is a real gap in ' +
      'Basher rather than a category error — the same shape as #349 one section over.',
    issue: 528,
  },

  LightData: {
    state: 'never',
    reason:
      'A material describes how a surface responds to light, and a light is not a surface. ' +
      'Measured: bpy.types.Light declares no `materials` property at all — not an empty ' +
      'collection, absent.',
  },
  CameraData: {
    state: 'never',
    reason:
      'Same as a light — nothing to shade. Measured: bpy.types.Camera declares no ' +
      '`materials` property at all.',
  },
};

const CAPABILITY: Record<DataDependentSection, Record<ObjectDataKind, SectionCapability>> = {
  modifier: MODIFIER_CAPABILITY,
  material: MATERIAL_CAPABILITY,
};

/**
 * Can a source of `kind` host `section`?
 *
 * Pure and allocation-free — it returns the table's own entry, so a caller may compare
 * results with `Object.is` and memoize on them.
 */
export function dataSectionCapability(
  kind: ObjectDataKind,
  section: DataDependentSection,
): SectionCapability {
  return CAPABILITY[section][kind];
}

/**
 * Should the section be OFFERED for this kind at all?
 *
 * 'not-yet' offers (with an honest banner and no working add buttons); 'never' does not.
 * Split out as its own function because the two call sites — whether to show the section
 * and whether to enable its actions — must not each re-derive the mapping from state to
 * decision. One phrasing, two readers ([[V108]]).
 */
export function sectionAppliesToData(kind: ObjectDataKind, section: DataDependentSection): boolean {
  return dataSectionCapability(kind, section).state !== 'never';
}

/** Every data-dependent section, for gates that must sweep the whole table. */
export const DATA_DEPENDENT_SECTIONS = Object.keys(CAPABILITY) as DataDependentSection[];

/** Every `ObjectData` kind the table classifies, for the same reason. */
export const OBJECT_DATA_KINDS = Object.keys(MODIFIER_CAPABILITY) as ObjectDataKind[];
