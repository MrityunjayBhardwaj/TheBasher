// #393 (step 2) — the Armature modifier: a mesh deformed by an armature Object's pose.
//
// ── THE DEFORM IS AN OPERATOR ON THE MESH, POINTING AT THE ARMATURE ─────────────────────────────
//
// Blender carries "this mesh is deformed by that armature" as a modifier in the mesh's own stack
// whose parameter is the armature Object, and the parent link carries only transform inheritance
// (measured, Blender 5.1.1: modifier kept and parent cleared still deforms, 0.522015; modifier
// deleted and parent kept deforms 0.000000). So this is an ordinary data-lane modifier whose
// second input is the armature Object — never the parenting, and there is no second, implicit
// road by which a mesh becomes skinned (Blender's legacy PARSKEL is one, and is not copied).
//
// ── WHAT IT READS ───────────────────────────────────────────────────────────────────────────────
//
// From the mesh: its skin — `skin_joints` / `skin_weights` point layers and the `vertexGroups`
// table the joint numbers index. From the armature Object: its skeleton (the rest, Blender's
// `arm_mat`), its pose (#1203, #1224), and its own placement. Each group joins a bone BY
// NAME, once, here; an unmatched group contributes nothing.
//
// ── WHAT IT EMITS, AND WHY TIME IS NOT AN INPUT ─────────────────────────────────────────────────
//
// The rest mesh, unchanged, with the deform beside it as data (`skin`). Time enters only when a
// reader samples it — `sampleSkinDeform(skin, mesh, seconds)` — so the node cooks once per graph
// change, never per frame: no node keys geometry per frame, and two nodes already retreated from
// time-as-an-edge for exactly this cost (`PosedSkeleton.ts`, `RetargetClip.ts`). Until a geometry
// operation downstream of a deform exists (#1198), what the mesh answers to a query is its rest.
//
// ── WHERE IT DIFFERS FROM BLENDER, SAID ONCE ────────────────────────────────────────────────────
//
// The armature's placement is its Object's own transform, read as relative to the mesh. That is
// exact when the armature hangs under the mesh's Object, as every import stands it; an armature
// Object placed elsewhere is measured from its own parent, because world placement is resolved by
// the scene, not inside a node. And the placement is read at evaluation, so a channel keyed on the
// armature Object's transform does not reach the deform.
//
// REF: src/nodes/armatureDeform.ts (the math); src/nodes/types.ts (`SkinDeformValue`);
//      ref/sources/blender-armature-deform/{MOD_armature.cc,armature_deform.cc}; issues #393,
//      #1203, #1198.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { ObjectData, ObjectValue } from './types';
import { modifierDataSource, slotTableThrough } from '../app/modifierDataSource';
import { localMatrix } from '../app/resolveWorldTransform';
import { armaturePoseOf } from './bonePose';
import { boneOfGroups } from './armatureDeform';

export const ArmatureModifierParams = z.object({
  /**
   * Stack mute-bypass. The param CARRIES the state; `chain.bypass` below names it and the
   * evaluator honours it, handing the spine value back without running `evaluate`.
   */
  muted: z.boolean().default(false),
});
export type ArmatureModifierParams = z.infer<typeof ArmatureModifierParams>;

export const ArmatureModifierNode: NodeDefinition<ArmatureModifierParams, ObjectData> = {
  type: 'ArmatureModifier',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: ArmatureModifierParams,
  inputs: {
    target: { type: 'ObjectData', cardinality: 'single' },
    // The armature Object, as Blender's modifier takes its `object`: the pose arrives with it.
    armature: { type: 'SceneObject', cardinality: 'single' },
  },
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  chain: {
    input: 'target',
    // Blender's modifier can be limited to one vertex group; that is a scope this could have and
    // does not yet.
    scope: { kind: 'unscoped', why: 'declined' },
    bypass: { kind: 'passthrough', param: 'muted' },
    section: 'modifier',
  },
  inspectorSections: ['modifier'],
  home: {
    muted: 'modifier',
  },
  evaluate(_params, inputs) {
    const src = inputs.target as ObjectData | undefined;
    if (!src) return src as unknown as ObjectData;
    const source = modifierDataSource(src);
    // Non-mesh data has no points to move. Pass through, as every modifier in this stack does.
    if (!source) return src;
    const armature = inputs.armature as ObjectValue | undefined;
    const mesh = source.geometry.descriptor;
    // Only a stored mesh carries a skin, and only a skeleton can deform one; anything else is
    // handed back as it came, the transparency an unwired modifier already has.
    if (mesh.kind !== 'mesh' || armature?.kind !== 'Object' || armature.data?.kind !== 'Skeleton') {
      return src;
    }
    const bones = armature.data.bones;
    return {
      kind: 'ModifiedData',
      geometry: source.geometry,
      material: source.material,
      ...slotTableThrough(source, source.geometry),
      skin: {
        kind: 'SkinDeform',
        bones,
        pose: armaturePoseOf(armature),
        boneOfGroup: boneOfGroups(mesh.data.vertexGroups, bones),
        armatureMatrix: localMatrix(armature).toArray(),
      },
    };
  },
};
