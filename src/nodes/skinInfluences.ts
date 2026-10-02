// #1430 — a point's bone influences, read and written in ONE place.
//
// ── WHAT IS STORED ────────────────────────────────────────────────────────────────────────────
//
// A skinned mesh carries its influences as point layers in SETS of four: `skin_joints` and
// `skin_weights` hold the first four, and a mesh with a point bound to more than four bones carries
// `skin_joints_1` / `skin_weights_1` beside them, then `_2`, and so on — the shape glTF uses
// (`JOINTS_0`, `JOINTS_1`, …), so a mesh with four or fewer influences stores exactly what it did
// before there were further sets. Blender keeps every influence a file states, in both its glTF and
// its FBX importer (`io_scene_gltf2/blender/imp/mesh.py:93-96`; vertex groups are unbounded per
// vertex), and so does a stored mesh.
//
// ── WHY ONE READER ────────────────────────────────────────────────────────────────────────────
//
// The width used to be the literal 4 in five places: the importer's read, its weld and its re-skin,
// the Armature modifier's sum, the draw's buffers and the stored mesh's own validation. Each of them
// now asks here for a point's lanes and is told how many there are, so a mesh's influence count is a
// property of the mesh and not of the code reading it.
//
// REF: src/nodes/attributes.ts (`SKIN_JOINTS`, `SKIN_WEIGHTS`); src/nodes/armatureDeform.ts;
//      src/app/skinnedDraw.ts; src/app/polygonLayout.ts (`pointLayerProblem`);
//      src/core/import/nativeGltfImport.ts; issues #1430, #1196.

// A LEAF: one type import and no value import, so the stored mesh's validation
// (`polygonLayout.ts`, itself pinned as a leaf by `faceCountLeaf.gate.test.ts`) can ask it for a
// set's names without gaining a road back into the attribute store. The two names live here for
// that reason; `attributes.ts` re-exports them beside the note on what they hold.
import type { MeshGeometryData, MeshPointLayer } from './types';

export const SKIN_JOINTS = 'skin_joints';
export const SKIN_WEIGHTS = 'skin_weights';

/** Influences per stored set: the width of an `int4` / `float4` point layer. */
export const SKIN_SET_WIDTH = 4;

/** The joint layer of set `n`: `skin_joints`, then `skin_joints_1`, `skin_joints_2`, … */
export function skinJointsLayerName(set: number): string {
  return set === 0 ? SKIN_JOINTS : `${SKIN_JOINTS}_${set}`;
}

/** The weight layer of set `n`: `skin_weights`, then `skin_weights_1`, `skin_weights_2`, … */
export function skinWeightsLayerName(set: number): string {
  return set === 0 ? SKIN_WEIGHTS : `${SKIN_WEIGHTS}_${set}`;
}

/**
 * Every point's influences as lanes: point `p` owns `joints[p * width + lane]` and
 * `weights[p * width + lane]` for `lane` in `0 … width - 1`. A lane with weight 0 is an empty lane.
 */
export interface SkinLanes {
  /** Lanes per point: {@link SKIN_SET_WIDTH} times the number of sets. */
  readonly width: number;
  readonly joints: Int32Array;
  readonly weights: Float32Array;
}

/** How many influence sets `mesh` carries, counted from set 0 with no gap; 0 when it has no skin. */
export function skinSetCount(mesh: Pick<MeshGeometryData, 'pointLayers'>): number {
  let sets = 0;
  while (
    mesh.pointLayers.some((l) => l.name === skinJointsLayerName(sets) && l.type === 'int4') &&
    mesh.pointLayers.some((l) => l.name === skinWeightsLayerName(sets) && l.type === 'float4')
  ) {
    sets++;
  }
  return sets;
}

const lanesOf = new WeakMap<readonly MeshPointLayer[], SkinLanes | null>();

/**
 * The influences of every point of `mesh`, or `null` when it has no skin.
 *
 * A mesh with one set gets its two layers back as they are stored, so nothing is copied for the
 * meshes that existed before further sets did. More sets are laid side by side per point, once per
 * layer list (a stored mesh is immutable by contract).
 */
export function skinLanes(mesh: Pick<MeshGeometryData, 'pointLayers'>): SkinLanes | null {
  const hit = lanesOf.get(mesh.pointLayers);
  if (hit !== undefined) return hit;
  const sets = skinSetCount(mesh);
  let lanes: SkinLanes | null = null;
  if (sets > 0) {
    const layer = (name: string): MeshPointLayer => mesh.pointLayers.find((l) => l.name === name)!;
    const first = {
      joints: layer(skinJointsLayerName(0)).data as Int32Array,
      weights: layer(skinWeightsLayerName(0)).data as Float32Array,
    };
    if (sets === 1) {
      lanes = { width: SKIN_SET_WIDTH, ...first };
    } else {
      const points = first.joints.length / SKIN_SET_WIDTH;
      const width = SKIN_SET_WIDTH * sets;
      const joints = new Int32Array(points * width);
      const weights = new Float32Array(points * width);
      for (let s = 0; s < sets; s++) {
        const j = layer(skinJointsLayerName(s)).data;
        const w = layer(skinWeightsLayerName(s)).data;
        for (let p = 0; p < points; p++) {
          for (let k = 0; k < SKIN_SET_WIDTH; k++) {
            joints[p * width + s * SKIN_SET_WIDTH + k] = j[p * SKIN_SET_WIDTH + k];
            weights[p * width + s * SKIN_SET_WIDTH + k] = w[p * SKIN_SET_WIDTH + k];
          }
        }
      }
      lanes = { width, joints, weights };
    }
  }
  lanesOf.set(mesh.pointLayers, lanes);
  return lanes;
}

/**
 * The point layers that store `lanes`: one joint layer and one weight layer per set, in set order.
 * `lanes.width` must be a whole number of sets.
 */
export function skinPointLayers(lanes: SkinLanes): MeshPointLayer[] {
  if (lanes.width % SKIN_SET_WIDTH !== 0 || lanes.width === 0) {
    throw new Error(
      `skinPointLayers: ${lanes.width} lanes per point is not a whole number of sets of ${SKIN_SET_WIDTH}`,
    );
  }
  const sets = lanes.width / SKIN_SET_WIDTH;
  if (sets === 1) {
    return [
      { name: skinJointsLayerName(0), type: 'int4', data: lanes.joints },
      { name: skinWeightsLayerName(0), type: 'float4', data: lanes.weights },
    ];
  }
  const points = lanes.joints.length / lanes.width;
  const layers: MeshPointLayer[] = [];
  for (let s = 0; s < sets; s++) {
    const joints = new Int32Array(points * SKIN_SET_WIDTH);
    const weights = new Float32Array(points * SKIN_SET_WIDTH);
    for (let p = 0; p < points; p++) {
      for (let k = 0; k < SKIN_SET_WIDTH; k++) {
        joints[p * SKIN_SET_WIDTH + k] = lanes.joints[p * lanes.width + s * SKIN_SET_WIDTH + k];
        weights[p * SKIN_SET_WIDTH + k] = lanes.weights[p * lanes.width + s * SKIN_SET_WIDTH + k];
      }
    }
    layers.push(
      { name: skinJointsLayerName(s), type: 'int4', data: joints },
      { name: skinWeightsLayerName(s), type: 'float4', data: weights },
    );
  }
  return layers;
}
