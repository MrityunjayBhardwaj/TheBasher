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
// ── THREE WAYS OF MEASURING "NEAR" (#1539, #1356) ───────────────────────────────────────────────
//
// `method` picks how far a point is from a bone. `proximity` is the straight line
// (`captureWeights.ts`): quick, and right wherever the nearest bone in space is the bone the skin
// belongs to. `voxel` is the way through the mesh's own volume (`captureVoxel.ts`): an arm lying
// beside the torso is far from the spine by that measure, however close it is in space. `heat` is
// the way along the skin (`captureHeat.ts`): two fingers touching side by side are a long way
// apart by that measure, where the other two join them. All hand back the same thing, so
// everything after this node is the same for any of them.
//
// Each method reads its own settings (`dropoff` for the first, `resolution` and `falloff` for the
// second, none of its own for the third), and only the settings the chosen method reads enter the
// geometry key: turning a setting the method ignores computes nothing again.
//
// The voxel and heat methods run here, in `evaluate`, like the other: measured in Node on this
// machine for a 24,746-point character, voxel takes about half a second at 128 with 72 bones
// (2026-10-08) and heat about 0.15 s with 67 (2026-10-12). The result is kept per stored mesh
// below, so a pose edit never pays it twice.
//
// Heat is that quick there because that character is 95 small pieces. Its cost grows with the size
// of a PIECE to the power one and a half (`heatLoad`): one skin of 38,400 points and 20 bones took
// 3.9 s, and of 199,680, 54 s. A capture past `HEAT_WORK_LIMIT` is refused by name rather than
// left to freeze the app.
//
// REF: src/nodes/captureWeights.ts, src/nodes/captureVoxel.ts, src/nodes/captureHeat.ts (the
//      three rules); src/nodes/ArmatureModifier.ts (the reader); src/nodes/skinInfluences.ts;
//      ref/GROUND_TRUTH_AUTO_SKIN_WEIGHTS.md §10.2; issues #1353, #1539, #1356.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { BoneSpec, MeshGeometryData, ObjectData, ObjectValue } from './types';
import { Matrix4, Vector3 } from 'three';
import { hashString } from '../core/dag/hash';
import { modifierDataSource, slotTableThrough } from '../app/modifierDataSource';
import { refWithAttributeKey } from '../app/modifierGeometry';
import { localMatrix } from '../app/resolveWorldTransform';
import { boneWorldMatrices, placeBones } from '../viewport/boneShape';
import { captureByHeat, HEAT_WORK_LIMIT, heatLoad } from './captureHeat';
import { captureByVoxel } from './captureVoxel';
import { captureByProximity, type CaptureBone, type CapturedWeights } from './captureWeights';
import { mintMeshAttributes } from './meshAttributes';
import { SKIN_JOINTS, SKIN_WEIGHTS, skinPointLayers } from './skinInfluences';

export const CAPTURE_METHODS = ['proximity', 'voxel', 'heat'] as const;
export type CaptureMethod = (typeof CAPTURE_METHODS)[number];

export const CaptureModifierParams = z.object({
  /**
   * How a point's distance to a bone is measured: in a straight line, through the mesh's own
   * volume, or along its surface (Maya's Closest Distance, Geodesic Voxel and Heat Map bind
   * methods, `skinCluster-cmd-2025.txt:90-97`; Blender's "With Automatic Weights" is the third).
   */
  method: z.enum(CAPTURE_METHODS).default('proximity'),
  /** The most bones one point is bound to — Maya's and Houdini's Max Influences. */
  maxInfluences: z.number().int().min(1).max(16).default(4),
  /**
   * `proximity` only. How sharply a bone's hold falls with distance — Maya's Dropoff Rate, with its
   * default and its documented range (`bind-skin-options.txt:230-232`). Higher keeps each bone's
   * hold closer to it.
   */
  dropoff: z.number().min(0.1).max(100).default(4),
  /**
   * `voxel` only. Cubes along the mesh's longest side. Two parts closer together than about three
   * cubes are joined, and take each other's bones (Maya says the same of its own:
   * `bind-skin-options-2025.txt:160-164`); a finer grid costs more. Maya defaults to 256 on the GPU
   * (`geomBind.txt:37-41`); 128 here, where it runs on one thread.
   */
  resolution: z.number().int().min(16).max(256).default(128),
  /**
   * `voxel` only. 0 smooth to 1 rigid: `a` in the method's falloff (`captureVoxel.ts`), from the
   * inverse square of distance at 0 to the inverse fourth power at 1. Maya's Falloff runs the same
   * way over the same range and defaults to 0.2 (`bind-skin-options-2025.txt:151-155`); whether
   * Maya's number IS `a` is not in any source held (the 2013 paper is paywalled), so the default is
   * Maya's and the meaning is this formula's.
   */
  falloff: z.number().min(0).max(1).default(0.2),
  /**
   * Stack mute-bypass. The param CARRIES the state; `chain.bypass` below names it and the
   * evaluator honours it, handing the spine value back without running `evaluate`.
   */
  muted: z.boolean().default(false),
});
export type CaptureModifierParams = z.infer<typeof CaptureModifierParams>;

/** What decides a capture's weights: every param but the mute. */
export type CaptureSettings = Omit<CaptureModifierParams, 'muted'>;

/**
 * `given` with the schema's own defaults for whatever it leaves out (or holds as `undefined`) —
 * THE one place a missing setting gets its value, for a caller that holds params no schema has
 * filled (a bind request, a node's raw params).
 */
export function captureSettingsOf(given: Partial<CaptureSettings>): CaptureSettings {
  return CaptureModifierParams.omit({ muted: true }).parse(given);
}

/** The settings `method` reads, in a fixed order: what its results depend on besides the mesh. */
function settingsRead(settings: CaptureSettings): readonly (string | number)[] {
  if (settings.method === 'voxel') {
    return ['voxel', settings.maxInfluences, settings.resolution, settings.falloff];
  }
  if (settings.method === 'heat') return ['heat', settings.maxInfluences];
  return ['proximity', settings.maxInfluences, settings.dropoff];
}

/** What a capture did, or the reason it did nothing. */
export type CapturePlan =
  | {
      readonly kind: 'captured';
      readonly method: CaptureMethod;
      readonly data: MeshGeometryData;
      /** The geometry key of `data`, before its attribute component. */
      readonly key: string;
      /** How many bones were measured against (the deforming ones). */
      readonly bones: number;
      readonly points: number;
      /** How many points no bone holds: they stay at rest when the others move. */
      readonly unbound: number;
      /**
       * How many points no bone reached by the method's own measure (`voxel`: through the volume;
       * `heat`: over the surface), bound by straight-line distance instead. 0 by proximity.
       */
      readonly unreached: number;
      /**
       * `voxel`: the bones in no filled part of the volume, which nothing is measured from.
       * `heat`: the bones that end up holding no point.
       */
      readonly outside: readonly string[];
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
  params: CaptureSettings,
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
      ...settingsRead(params),
      JSON.stringify(bones.map((b) => [b.name, b.head, b.tail])),
    ].join('|'),
  )}`;
  const hit = lastPlan.get(mesh.data);
  if (hit?.key === key) return hit.plan;

  if (params.method === 'heat') {
    // Asked before the capture, and kept like one: the asking is itself a pass over the mesh.
    const load = heatLoad(mesh.data, bones.length);
    if (load !== null && load.work > HEAT_WORK_LIMIT) {
      const plan: CapturePlan = {
        kind: 'refused',
        reason: `the mesh's largest piece has ${load.largest} points, and heat is worked out across a whole piece for each of the ${bones.length} bones: on a piece that size the app would stand frozen. Use the voxel method, which does not grow that way.`,
      };
      lastPlan.set(mesh.data, { key, plan });
      return plan;
    }
  }
  const captured: CapturedWeights | null =
    params.method === 'voxel'
      ? captureByVoxel(mesh.data, bones, params)
      : params.method === 'heat'
        ? captureByHeat(mesh.data, bones, params)
        : captureByProximity(mesh.data.points, bones, params);
  if (captured === null) {
    return {
      kind: 'refused',
      reason:
        params.method === 'heat'
          ? 'the mesh has no faces, or no size, so it has no surface for heat to spread over: use the proximity method.'
          : 'the mesh has no faces, or no size, so it has no inside to measure through: use the proximity method.',
    };
  }
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
    method: params.method,
    data,
    key,
    bones: bones.length,
    points: mesh.data.points.length / 3,
    unbound: captured.unbound,
    unreached: captured.unreached,
    outside: captured.outside,
  };
  lastPlan.set(mesh.data, { key, plan });
  return plan;
}

export const CaptureModifierNode: NodeDefinition<CaptureModifierParams, ObjectData> = {
  type: 'CaptureModifier',
  version: 1,
  pure: true,
  // By proximity it is tens of milliseconds; by voxel, half a second for a 72-bone character at
  // 128 and several at 256; by heat, a sixth of a second for the same character and seconds for
  // one skin of tens of thousands of points. Nothing reads `cost` today — the label is for whoever
  // does.
  cost: 'medium',
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
    method: 'modifier',
    maxInfluences: 'modifier',
    dropoff: 'modifier',
    resolution: 'modifier',
    falloff: 'modifier',
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
