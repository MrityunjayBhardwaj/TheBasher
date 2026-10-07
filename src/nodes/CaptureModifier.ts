// #1353 — Capture: a mesh bound to an armature's rest skeleton, as weights on the mesh.
//
// ── WEIGHTS ARE MADE HERE AND READ BY THE ARMATURE MODIFIER ─────────────────────────────────────
//
// Making weights is one operation and deforming by them is another: Houdini's capture nodes "do
// not visibly change the geometry … to actually change the geometry … use the Joint Deform SOP"
// (`houdini-kinefx-docs/kinefx--jointcaptureproximity.txt`). So this sits BELOW an Armature
// modifier in the same stack and hands it what an imported skinned mesh already carries: the
// `skin_joints` / `skin_weights` point layers and the `vertexGroups` table they index, one group
// per deforming bone, named by the bone (`armature_skinning.cc:182-184`). The Armature modifier
// joins group to bone by name and cannot tell captured weights from imported ones.
//
// ── WHAT IT READS ───────────────────────────────────────────────────────────────────────────────
//
// The same two inputs the Armature modifier takes, for the same reason: the armature OBJECT, whose
// data is the rest skeleton and whose own placement says where the bones stand in the mesh's
// space. Weights are measured there, in the space the deform will later be taken in. A bone's
// segment is the one the viewport draws (`placeBones`: head to the mean of its children's heads,
// and a made-up tail on a leaf). The pose is not read: a capture is of the rest.
//
// A bone marked as not deforming (`BoneSpec.deform === false` — a control, an IK goal, a pole) is
// skipped, as Blender skips `BONE_NO_DEFORM` (`armature_skinning.cc:87`).
//
// ── WHAT IT EMITS ───────────────────────────────────────────────────────────────────────────────
//
// The source mesh with its weights replaced: any skin the mesh already carried is dropped, the
// way binding again replaces a bind. Every other layer rides through. The geometry key is minted
// from what decides the result (the source's key, the bone segments, the settings), so two
// captures that would compute the same weights share one build.
//
// ── WHEN IT CAPTURES NOTHING, IT SAYS WHY ───────────────────────────────────────────────────────
//
// `planCapture` is the one answer: `evaluate` hands on its mesh, and the inspector prints its
// reason or its count of points no bone holds (`captureStatusOf`). A refused capture passes its
// source through unchanged, like every unwired modifier in this stack — but it is never silent
// about it, because a mesh that does not move looks the same whether nothing was captured or the
// bone was never turned.
//
// REF: src/nodes/captureWeights.ts (the rule); src/nodes/ArmatureModifier.ts (the reader);
//      src/nodes/skinInfluences.ts; ref/GROUND_TRUTH_AUTO_SKIN_WEIGHTS.md §10.2; issue #1353.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { BoneSpec, MeshGeometryData, ObjectData, ObjectValue } from './types';
import { Matrix4, Vector3 } from 'three';
import { hashString } from '../core/dag/hash';
import { modifierDataSource, slotTableThrough } from '../app/modifierDataSource';
import { refWithAttributeKey } from '../app/modifierGeometry';
import { localMatrix } from '../app/resolveWorldTransform';
import { boneWorldMatrices, placeBones } from '../viewport/boneShape';
import { captureByProximity, type CaptureBone } from './captureWeights';
import { mintMeshAttributes } from './meshAttributes';
import { SKIN_JOINTS, SKIN_WEIGHTS, skinPointLayers } from './skinInfluences';

export const CaptureModifierParams = z.object({
  /** The most bones one point is bound to — Maya's and Houdini's Max Influences. */
  maxInfluences: z.number().int().min(1).max(16).default(4),
  /**
   * How sharply a bone's hold falls with distance — Maya's Dropoff Rate, with its default and its
   * documented range (`bind-skin-options.txt:230-232`). Higher keeps each bone's hold closer to it.
   */
  dropoff: z.number().min(0.1).max(100).default(4),
  /**
   * Stack mute-bypass. The param CARRIES the state; `chain.bypass` below names it and the
   * evaluator honours it, handing the spine value back without running `evaluate`.
   */
  muted: z.boolean().default(false),
});
export type CaptureModifierParams = z.infer<typeof CaptureModifierParams>;

/** What a capture did, or the reason it did nothing. */
export type CapturePlan =
  | {
      readonly kind: 'captured';
      readonly data: MeshGeometryData;
      /** The geometry key of `data`, before its attribute component. */
      readonly key: string;
      /** How many bones were measured against (the deforming ones). */
      readonly bones: number;
      readonly points: number;
      /** How many points no bone holds: they stay at rest when the others move. */
      readonly unbound: number;
    }
  | { readonly kind: 'refused'; readonly reason: string };

/** The deforming bones of `bones` as rest segments in the mesh's space. */
export function captureBonesOf(bones: readonly BoneSpec[], armatureMatrix: Matrix4): CaptureBone[] {
  const rest = boneWorldMatrices(bones);
  const frames = placeBones(
    bones.map((b, i) => ({ name: b.name, parent: b.parent, matrix: rest[i] })),
    rest,
  );
  const seen = new Set<string>();
  const out: CaptureBone[] = [];
  const at = new Vector3();
  frames.forEach((frame, i) => {
    // A group joins the FIRST bone of its name (`boneOfGroups`), so a later bone of the same name
    // could never be reached by the weights measured against it.
    if (bones[i].deform === false || seen.has(frame.name)) return;
    seen.add(frame.name);
    const head = at.fromArray(frame.head).applyMatrix4(armatureMatrix).toArray();
    const tail = at.fromArray(frame.tail).applyMatrix4(armatureMatrix).toArray();
    out.push({ name: frame.name, head, tail });
  });
  return out;
}

// One capture per stored mesh: a pose edit re-evaluates this node (the armature Object's value
// changes with its pose) while nothing a capture reads has moved.
const lastPlan = new WeakMap<
  MeshGeometryData,
  { readonly key: string; readonly plan: CapturePlan }
>();

/**
 * What capturing `src` by `armature` gives: the mesh with its weights, or why there is none.
 * The one answer `evaluate` and the inspector both read.
 */
export function planCapture(
  src: ObjectData | undefined,
  armature: ObjectValue | undefined,
  params: Pick<CaptureModifierParams, 'maxInfluences' | 'dropoff'>,
): CapturePlan {
  if (!src) return { kind: 'refused', reason: 'no mesh is connected below it.' };
  const source = modifierDataSource(src);
  if (!source) return { kind: 'refused', reason: `${src.kind} has no points to bind.` };
  if (src.kind === 'ModifiedData' && src.skin !== undefined) {
    return {
      kind: 'refused',
      reason:
        'an Armature modifier below it already deforms the mesh, and cannot read weights made above it: move Capture below the Armature modifier.',
    };
  }
  const mesh = source.geometry.descriptor;
  if (mesh.kind !== 'mesh') {
    return {
      kind: 'refused',
      reason: `the mesh is a "${mesh.kind}", and only a stored mesh has points that hold weights.`,
    };
  }
  if (armature?.kind !== 'Object' || armature.data?.kind !== 'Skeleton') {
    return {
      kind: 'refused',
      reason: 'no armature is connected: pick the armature whose bones bind this mesh.',
    };
  }
  const bones = captureBonesOf(armature.data.bones, localMatrix(armature));
  if (bones.length === 0) {
    return {
      kind: 'refused',
      reason:
        armature.data.bones.length === 0
          ? 'the armature has no bones.'
          : `none of the armature's ${armature.data.bones.length} bones deforms: switch "deform" on for the bones that move skin (Edit mode).`,
    };
  }

  const key = `mesh|${hashString(
    [
      'capture',
      source.geometry.key,
      params.maxInfluences,
      params.dropoff,
      JSON.stringify(bones.map((b) => [b.name, b.head, b.tail])),
    ].join('|'),
  )}`;
  const hit = lastPlan.get(mesh.data);
  if (hit?.key === key) return hit.plan;

  const captured = captureByProximity(mesh.data.points, bones, params);
  const data: MeshGeometryData = {
    ...mesh.data,
    pointLayers: [
      ...mesh.data.pointLayers.filter(
        (l) => !l.name.startsWith(SKIN_JOINTS) && !l.name.startsWith(SKIN_WEIGHTS),
      ),
      ...skinPointLayers(captured.lanes),
    ],
    vertexGroups: captured.vertexGroups,
  };
  const plan: CapturePlan = {
    kind: 'captured',
    data,
    key,
    bones: bones.length,
    points: mesh.data.points.length / 3,
    unbound: captured.unbound,
  };
  lastPlan.set(mesh.data, { key, plan });
  return plan;
}

export const CaptureModifierNode: NodeDefinition<CaptureModifierParams, ObjectData> = {
  type: 'CaptureModifier',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: CaptureModifierParams,
  inputs: {
    target: { type: 'ObjectData', cardinality: 'single' },
    // The armature Object, as the Armature modifier takes it: its skeleton and where it stands.
    armature: { type: 'SceneObject', cardinality: 'single' },
  },
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  chain: {
    input: 'target',
    // Houdini's capture takes a point group; that is a scope this could have and does not yet.
    scope: { kind: 'unscoped', why: 'declined' },
    bypass: { kind: 'passthrough', param: 'muted' },
    section: 'modifier',
  },
  inspectorSections: ['modifier'],
  home: {
    maxInfluences: 'modifier',
    dropoff: 'modifier',
    muted: 'modifier',
  },
  evaluate(params, inputs) {
    const src = inputs.target as ObjectData | undefined;
    const plan = planCapture(src, inputs.armature as ObjectValue | undefined, params);
    // Refused: the source as it came, the transparency an unwired modifier already has. The reason
    // is `planCapture`'s, and the inspector prints it.
    if (plan.kind === 'refused') return src as unknown as ObjectData;
    const source = modifierDataSource(src!)!;
    const stored = { key: plan.key, descriptor: { kind: 'mesh' as const, data: plan.data } };
    const geometry = refWithAttributeKey(stored, mintMeshAttributes(stored.descriptor, 'evaluate'));
    return {
      kind: 'ModifiedData',
      geometry,
      material: source.material,
      ...slotTableThrough(source, geometry),
    };
  },
};
