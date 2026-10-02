// #1429 — an FBX file's meshes read into stored polygon meshes, as Blender's FBX importer makes them.
//
// ── WHAT IS READ, AND FROM WHERE ──────────────────────────────────────────────────────────────
//
// three's FBXLoader triangulates every face with more than three corners and keeps four skin
// weights per vertex. Blender keeps the file's polygons and every weight, and so does a stored
// mesh. Our patch to the loader (`patches/three+0.169.0.patch`, `basher #1429`) records what the
// file states before either happens, on each geometry's `userData.fbxPolygons`: every control
// point, each face's corners, each corner's normal, UV sets and colour, each face's material, and
// every weight of every control point. This module reads that, and nothing of the triangles.
//
// A control point is a POINT: Blender makes one vertex per control point (measured, 5.1.1:
// `skinned-bar-keyed-scale-blender-default.fbx`'s icosphere has 42 vertices and 240 loops, and
// the file 42 control points and 240 polygon corners).
//
// ── WHERE A MESH STANDS ───────────────────────────────────────────────────────────────────────
//
// A SKINNED mesh hangs under its armature's Object with no transform of its own, its points in
// the armature's space at the rig's rest — what Blender makes of it (measured: `Mesh_0` and `Body`
// are children of their armature, at location 0 and scale 1, with an Armature modifier pointed at
// it), and what the glTF road does (#1218). The rig's bones are read in the scene's space in
// metres (`parseFbx`), so a point's rest is where three's own skinning puts it at load, in metres.
//
// An UNSKINNED mesh stands as its own Object, carrying its node's world placement with the file's
// unit folded into position and scale, its points as the file states them — Blender's icosphere in
// the same file reads location 0 and scale 1, and so does this (×100 on the node, ×0.01 the unit).
//
// REF: src/core/import/fbx.ts (`parseFbx`, the rig and the unit); src/core/import/nativeGltfImport.ts
//      (`skinIntoArmatureSpace`, the same rest re-skin for glTF); issues #1429, #1430.

import {
  Matrix4,
  Quaternion,
  Vector3,
  type Color,
  type Material,
  type Mesh,
  type Object3D,
} from 'three';
import type { Group, SkinnedMesh } from 'three';
import { COLOR_LAYER, MATERIAL_INDEX, uvLayerName } from '../../nodes/attributes';
import { SKIN_SET_WIDTH, skinPointLayers } from '../../nodes/skinInfluences';
import type {
  MeshCornerLayer,
  MeshFaceLayer,
  MeshGeometryData,
  MeshPointLayer,
  Vec3,
} from '../../nodes/types';

/** What the loader patch records on a geometry (see the header). */
interface FbxPolygons {
  readonly points: number[];
  readonly faceSizes: number[];
  readonly cornerPoints: number[];
  readonly normals: number[] | null;
  readonly uvs: number[][];
  readonly colors: number[] | null;
  readonly materialIndex: number[] | null;
  /** Flat triples: control point, skin bone (the loader's skeleton order), weight. */
  readonly weights: number[];
}

/**
 * A material slot, read as Blender's FBX importer reads one (`import_fbx.py:2076-2101`, 5.1.1):
 * the diffuse colour as the base colour, linear; roughness `1 − √shininess / 10`; metallic 0 — the
 * importer's default when a file states no reflection factor, and three's Phong material cannot
 * say whether one was stated.
 */
export interface FbxMaterialSlot {
  readonly name: string;
  readonly color: Vec3;
  readonly roughness: number;
}

export interface FbxMeshRead {
  readonly name: string;
  /**
   * The stored mesh. For a skinned mesh its joint numbers index {@link FbxMeshRead.vertexGroupBones}
   * and its `vertexGroups` are left empty: the bone NAMES are the import chain's to spell.
   */
  readonly data: MeshGeometryData;
  /** Skinned: each vertex group's bone, as an index into the rig `parseFbx` read. */
  readonly vertexGroupBones: readonly number[] | null;
  /** Unskinned: where the Object stands, in metres. Skinned meshes stand at the armature. */
  readonly placement: {
    readonly position: Vec3;
    readonly quaternion: [number, number, number, number];
    readonly scale: Vec3;
  } | null;
  /** One per slot, in the file's order; empty when the file gives the mesh none. */
  readonly materials: readonly FbxMaterialSlot[];
}

export interface FbxMeshesRead {
  readonly meshes: readonly FbxMeshRead[];
  /** What was left out, each said once, in words a director can act on. Empty when nothing was. */
  readonly notices: readonly string[];
}

/**
 * Every mesh of the loaded file, read as the header says.
 *
 * `rigIndexOf` answers which bone of the rig a skin's bone stands for (or -1): the loader nests
 * per-skin copies of a bone, and `parseFbx` already knows how to find the one in the rig.
 */
export function readFbxMeshes(
  group: Group,
  rigIndexOf: (bone: Object3D) => number,
  metresPerUnit: number,
): FbxMeshesRead {
  group.updateMatrixWorld(true);
  const meshes: FbxMeshRead[] = [];
  const notices: string[] = [];
  group.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const polygons = mesh.geometry.userData.fbxPolygons as FbxPolygons | undefined;
    const name = mesh.name || mesh.geometry.name || `Mesh_${meshes.length}`;
    if (!polygons) {
      notices.push(`mesh "${name}" was not read: the loader recorded no polygons for it`);
      return;
    }
    if (Object.keys(mesh.geometry.morphAttributes).length > 0) {
      notices.push(`mesh "${name}" has shape keys, which were left out`);
    }
    const materials = materialsOf(mesh);
    const unheldMaps = materials.flatMap(({ unheldMaps }) => unheldMaps);
    if (unheldMaps.length > 0) {
      notices.push(
        `mesh "${name}" uses textures (${[...new Set(unheldMaps)].join(', ')}), which were left out; its colours came across`,
      );
    }
    const skinned = (mesh as SkinnedMesh).isSkinnedMesh === true && polygons.weights.length > 0;
    const read = skinned
      ? readSkinned(mesh as SkinnedMesh, polygons, rigIndexOf, metresPerUnit)
      : readPlain(mesh, polygons, metresPerUnit);
    if ('refused' in read) {
      notices.push(`mesh "${name}" was left out: ${read.refused}`);
      return;
    }
    meshes.push({ name, ...read, materials: materials.map(({ slot }) => slot) });
  });
  return { meshes, notices };
}

/** The mesh's slots, with the names of any texture maps the first slice does not carry. */
function materialsOf(mesh: Mesh): { slot: FbxMaterialSlot; unheldMaps: string[] }[] {
  const list = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Material[];
  // The loader's own stand-in when the file gives a mesh no material: not a slot of the file.
  if (list.length === 1 && list[0].name === '__DEFAULT') return [];
  return list.map((material) => {
    const m = material as Material & {
      color?: Color;
      shininess?: number;
    } & Record<string, unknown>;
    const shininess = Math.max(m.shininess ?? 20, 0);
    const unheldMaps = Object.keys(m).filter(
      (key) => /map$/i.test(key) && m[key] !== null && m[key] !== undefined,
    );
    return {
      slot: {
        name: material.name,
        // three reads the file's diffuse colour as sRGB and converts it (`FBXLoader.js:542-547`);
        // Blender takes the same numbers as the linear base colour (`import_fbx.py:2076`), so the
        // conversion is undone to get the file's numbers back. Measured: the fixture's red reads
        // 0.8 in Blender, and 0.604 off three's material.
        color: fileColour(m.color),
        roughness: Math.min(1, Math.max(0, 1 - Math.sqrt(shininess) / 10)),
      },
      unheldMaps,
    };
  });
}

/** A loader colour back to the numbers the file wrote (see `materialsOf`); white when it has none. */
function fileColour(color: Color | undefined): Vec3 {
  if (color === undefined) return [1, 1, 1];
  const { r, g, b } = color.clone().convertLinearToSRGB();
  return [r, g, b];
}

/** The corner and face layers every mesh carries, as the patch recorded them. */
function cornerAndFaceLayers(polygons: FbxPolygons): {
  cornerLayers: MeshCornerLayer[];
  faceLayers: MeshFaceLayer[];
} {
  const cornerLayers: MeshCornerLayer[] = polygons.uvs.map((uv, n) => ({
    name: uvLayerName(n),
    type: 'float2',
    data: Float32Array.from(uv),
  }));
  if (polygons.colors !== null) {
    const rgb = polygons.colors;
    const rgba = new Float32Array((rgb.length / 3) * 4);
    for (let c = 0; c * 3 < rgb.length; c++) {
      rgba.set([rgb[c * 3], rgb[c * 3 + 1], rgb[c * 3 + 2], 1], c * 4);
    }
    cornerLayers.push({ name: COLOR_LAYER, type: 'float4', data: rgba });
  }
  const faceLayers: MeshFaceLayer[] = [];
  const index = polygons.materialIndex;
  if (index !== null && new Set(index).size > 1) {
    faceLayers.push({ name: MATERIAL_INDEX, type: 'int', data: Int32Array.from(index) });
  }
  return { cornerLayers, faceLayers };
}

function readPlain(
  mesh: Mesh,
  polygons: FbxPolygons,
  metresPerUnit: number,
): Omit<FbxMeshRead, 'name' | 'materials'> {
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  mesh.matrixWorld.decompose(position, quaternion, scale);
  return {
    data: {
      points: Float32Array.from(polygons.points),
      faceSizes: Uint32Array.from(polygons.faceSizes),
      cornerPoints: Uint32Array.from(polygons.cornerPoints),
      cornerNormals: polygons.normals === null ? null : Float32Array.from(polygons.normals),
      ...cornerAndFaceLayers(polygons),
      pointLayers: [],
      vertexGroups: [],
    },
    vertexGroupBones: null,
    placement: {
      position: position.multiplyScalar(metresPerUnit).toArray(),
      quaternion: quaternion.toArray() as [number, number, number, number],
      scale: scale.multiplyScalar(metresPerUnit).toArray(),
    },
  };
}

/**
 * A skinned mesh at the rig's rest, in metres in the scene's space: each point moved by the blend of
 * its bones' `world · inverse` as three skins it at load, through the bind, and then out of the
 * mesh's space — every weight the file gives it, not three's four.
 */
function readSkinned(
  mesh: SkinnedMesh,
  polygons: FbxPolygons,
  rigIndexOf: (bone: Object3D) => number,
  metresPerUnit: number,
): Omit<FbxMeshRead, 'name' | 'materials'> | { refused: string } {
  const { bones, boneInverses } = mesh.skeleton;
  // Vertex groups: one per bone a weight names, in the order the file lists the skin's bones (its
  // clusters) — the order Blender makes them in (measured: the panel fixture's groups read Root,
  // B1 … B5 there, while the rig's node order puts B1 and B4 last).
  const rigOfSkinBone = bones.map((bone) => rigIndexOf(bone));
  const weightsOf = new Map<number, [number, number][]>();
  const named = new Set<number>();
  for (let i = 0; i < polygons.weights.length; i += 3) {
    const [point, skinBone, weight] = polygons.weights.slice(i, i + 3);
    if (!(weight > 0)) continue;
    const rig = rigOfSkinBone[skinBone] ?? -1;
    if (rig < 0) {
      return { refused: 'it is weighted to a bone outside the skeleton this file was read with' };
    }
    named.add(rig);
    weightsOf.set(point, [...(weightsOf.get(point) ?? []), [rig, weight]]);
  }
  const vertexGroupBones = [...new Set(rigOfSkinBone)].filter((rig) => named.has(rig));
  const groupOf = new Map(vertexGroupBones.map((rig, g) => [rig, g]));

  const pointCount = polygons.points.length / 3;
  let widest = 0;
  for (const list of weightsOf.values()) widest = Math.max(widest, list.length);
  const width = Math.max(1, Math.ceil(widest / SKIN_SET_WIDTH)) * SKIN_SET_WIDTH;
  const joints = new Int32Array(pointCount * width);
  const weights = new Float32Array(pointCount * width);

  // three's skinning, with every weight: world = M · B⁻¹ · Σ w (bone · inverse) / Σ w · B · v.
  const toBind = mesh.bindMatrix;
  const fromBind = mesh.matrixWorld.clone().multiply(mesh.bindMatrixInverse);
  const unit = new Matrix4().makeScale(metresPerUnit, metresPerUnit, metresPerUnit);
  const skinMatrix = bones.map((bone, j) =>
    bone.matrixWorld.clone().multiply(boneInverses[j] ?? new Matrix4()),
  );
  const perPoint: Matrix4[] = [];
  const points = new Float32Array(polygons.points.length);
  const v = new Vector3();
  for (let p = 0; p < pointCount; p++) {
    const list = weightsOf.get(p) ?? [];
    const blend = new Matrix4().makeScale(0, 0, 0);
    blend.elements[15] = 0;
    let sum = 0;
    list.forEach(([rig, weight], lane) => {
      joints[p * width + lane] = groupOf.get(rig)!;
      weights[p * width + lane] = weight;
      const skinBone = rigOfSkinBone.indexOf(rig);
      const e = skinMatrix[skinBone].elements;
      for (let k = 0; k < 16; k++) blend.elements[k] += weight * e[k];
      sum += weight;
    });
    // A point with no weight stays where the file puts it, as the Armature modifier leaves it.
    const placed =
      sum > 0
        ? (() => {
            for (let k = 0; k < 16; k++) blend.elements[k] /= sum;
            return unit.clone().multiply(fromBind).multiply(blend).multiply(toBind);
          })()
        : unit.clone().multiply(mesh.matrixWorld);
    perPoint.push(placed);
    v.fromArray(polygons.points, p * 3)
      .applyMatrix4(placed)
      .toArray(points, p * 3);
  }

  let cornerNormals: Float32Array | null = null;
  if (polygons.normals !== null) {
    cornerNormals = new Float32Array(polygons.normals.length);
    const n = new Vector3();
    for (let c = 0; c * 3 < cornerNormals.length; c++) {
      n.fromArray(polygons.normals, c * 3)
        .transformDirection(perPoint[polygons.cornerPoints[c]])
        .toArray(cornerNormals, c * 3);
    }
  }
  const pointLayers: MeshPointLayer[] = skinPointLayers({ width, joints, weights });
  return {
    data: {
      points,
      faceSizes: Uint32Array.from(polygons.faceSizes),
      cornerPoints: Uint32Array.from(polygons.cornerPoints),
      cornerNormals,
      ...cornerAndFaceLayers(polygons),
      pointLayers,
      vertexGroups: [],
    },
    vertexGroupBones,
    placement: null,
  };
}
