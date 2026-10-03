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
// metres (`readFbx`), so a point's rest is where three's own skinning puts it at load, in metres.
//
// An UNSKINNED mesh stands as its own Object, its points as the file states them in the node's own
// frame, re-expressed in Y-up (`toYUp`, corner normals with them). Where the Object stands, and under
// what, is the scene's to say (`fbxScene.ts`, #1434): Blender's split, so the icosphere in the same
// file reads rotation 0 and scale 1, as it does in Blender (#1440).
//
// ── WHAT A SLOT SAMPLES (#1434) ───────────────────────────────────────────────────────────────
//
// The patch also records, on each material's `userData.fbxTextures`, every texture the file links
// to it, by the link's name — read off the file, because three's loader drops the links it cannot
// draw. Each link feeds the input Blender's importer feeds (`materialsOf`); an embedded image is
// read once and stored by the import chain exactly as the glTF road stores its images. Anything a
// slot cannot draw as Blender does is left out and named. #1435 — a base colour image with an alpha
// channel is the surface's alpha, drawn dithered, as Blender wires and draws it.
//
// REF: src/core/import/fbx.ts (`readFbx`, the rig and the unit); src/core/import/nativeGltfImport.ts
//      (`skinIntoArmatureSpace`, the same rest re-skin for glTF); src/core/import/modelImport.ts
//      (`withProjectImages`, the images); issues #1429, #1430, #1434.

import { Matrix4, Vector3, type Color, type Material, type Mesh, type Object3D } from 'three';
import type { Group, SkinnedMesh } from 'three';
import { COLOR_LAYER, MATERIAL_INDEX, uvLayerName } from '../../nodes/attributes';
import { SKIN_SET_WIDTH, skinPointLayers } from '../../nodes/skinInfluences';
import { decodeDataUri } from './glb';
import { sniffImage } from './modelImport';
import { toYUp } from './fbxScene';
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
  /**
   * #1434 — the images the slot samples, each an index into {@link FbxMeshesRead.images}: the
   * base colour (`DiffuseColor`), and the normal map (`NormalMap` or `Bump`, which Blender reads
   * as a normal map too) with its strength, `BumpFactor`.
   */
  readonly baseColorImage?: FbxSlotImage;
  readonly normalImage?: FbxSlotImage & { readonly strength: number };
}

/** #1434 — a texture of a slot: which image, and whether it is clamped at the edges. */
export interface FbxSlotImage {
  readonly image: number;
  /** Blender clamps both axes when the file clamps either (`import_fbx.py` `texture_mapping_set`). */
  readonly clamp: boolean;
}

/** #1434 — an image a slot samples, as the file's own encoded bytes. */
export interface FbxImage {
  /** The file name the FBX gives it, for notices. */
  readonly file: string;
  readonly bytes: Uint8Array;
  readonly mime: string;
  /**
   * #1435 — the image has an alpha channel: what Blender's FBX importer asks before it draws a
   * diffuse image's alpha (`image.depth == 32`). See {@link imageHasAlpha}.
   */
  readonly hasAlpha: boolean;
}

export interface FbxMeshRead {
  readonly name: string;
  /**
   * The stored mesh. For a skinned mesh its joint numbers index {@link FbxMeshRead.vertexGroupBones}
   * and its `vertexGroups` are left empty: the bone NAMES are the import chain's to spell.
   */
  readonly data: MeshGeometryData;
  /** Skinned: each vertex group's bone, as an index into the rig `readFbx` read. */
  readonly vertexGroupBones: readonly number[] | null;
  /** One per slot, in the file's order; empty when the file gives the mesh none. */
  readonly materials: readonly FbxMaterialSlot[];
}

export interface FbxMeshesRead {
  readonly meshes: readonly FbxMeshRead[];
  /** #1434 — every image a kept slot samples, once each however many slots sample it. */
  readonly images: readonly FbxImage[];
  /** What was left out, each said once, in words a director can act on. Empty when nothing was. */
  readonly notices: readonly string[];
}

/**
 * Every mesh of the loaded file, read as the header says.
 *
 * `rigIndexOf` answers which bone of the rig a skin's bone stands for (or -1): the loader nests
 * per-skin copies of a bone, and `readFbx` already knows how to find the one in the rig.
 */
export function readFbxMeshes(
  group: Group,
  rigIndexOf: (bone: Object3D) => number,
  metresPerUnit: number,
  /** Filled with each UNSKINNED mesh's node and its index in the result, for the scene to place. */
  meshOf?: Map<Object3D, number>,
): FbxMeshesRead {
  group.updateMatrixWorld(true);
  const meshes: FbxMeshRead[] = [];
  const notices: string[] = [];
  const images = new ImageTable();
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
    const skinned = (mesh as SkinnedMesh).isSkinnedMesh === true && polygons.weights.length > 0;
    const read = skinned
      ? readSkinned(mesh as SkinnedMesh, polygons, rigIndexOf, metresPerUnit)
      : readPlain(polygons);
    if ('refused' in read) {
      notices.push(`mesh "${name}" was left out: ${read.refused}`);
      return;
    }
    // After the refusal: a mesh left out must not leave its images in the project.
    const materials = materialsOf(mesh, images);
    const unheldMaps = materials.flatMap(({ unheldMaps }) => unheldMaps);
    if (unheldMaps.length > 0) {
      notices.push(
        `mesh "${name}" uses textures that were left out (${[...new Set(unheldMaps)].join('; ')}); its colours came across`,
      );
    }
    if (!skinned) meshOf?.set(mesh, meshes.length);
    meshes.push({ name, ...read, materials: materials.map(({ slot }) => slot) });
  });
  return { meshes, images: images.list, notices };
}

/** What the loader patch records for each texture the file links to a material (`basher #1434`). */
interface FbxTextureLink {
  /** The connection's name: `DiffuseColor`, `NormalMap`, `TransparencyFactor`… */
  readonly link: string;
  readonly layered: boolean;
  readonly file: string;
  /** The embedded image: bytes in a binary file, base64 in an ASCII one; null when not embedded. */
  readonly content: ArrayBuffer | string | null;
  readonly wrapU: number | null;
  readonly wrapV: number | null;
  readonly translation: number[] | null;
  readonly rotation: number[] | null;
  readonly scaling: number[] | null;
}

// #1434 — which Principled input a link feeds, by Blender's own table (`import_fbx.py:3946-3981`,
// 5.1.1). Only the inputs a slot carries are listed; every other link is named in the notice.
const BASE_COLOR_LINKS = new Set(['DiffuseColor', '3dsMax|maps|texmap_diffuse']);
const NORMAL_LINKS = new Set(['NormalMap', 'Bump', '3dsMax|maps|texmap_bump']);
const ALPHA_LINKS = new Set(['TransparentColor', 'TransparencyFactor']);

/** #1434 — the file's images, each read once, keyed by the file name the FBX gives it. */
class ImageTable {
  readonly list: FbxImage[] = [];
  private readonly byFile = new Map<string, number>();

  /** The image's index, or why it cannot be drawn. */
  add(texture: FbxTextureLink): number | string {
    const known = this.byFile.get(texture.file);
    if (known !== undefined) return known;
    const image = decodeImage(texture);
    if (typeof image === 'string') return image;
    this.list.push(image);
    this.byFile.set(texture.file, this.list.length - 1);
    return this.list.length - 1;
  }
}

/** A linked texture's embedded image, read but not stored, or why it cannot be. */
function decodeImage(texture: FbxTextureLink): FbxImage | string {
  if (texture.content === null || texture.content === '') {
    return `"${texture.file}" is not embedded in the file`;
  }
  const bytes =
    typeof texture.content === 'string'
      ? decodeDataUri(`data:;base64,${texture.content}`)
      : new Uint8Array(texture.content);
  const mime = sniffImage(bytes);
  if (mime === null) return `"${texture.file}" is not PNG, JPEG or WebP`;
  return { file: texture.file, bytes, mime, hasAlpha: imageHasAlpha(bytes, mime) };
}

/**
 * #1435 — whether an image has an alpha channel, as Blender 5.1.1 loads it (`image.depth == 32`).
 * Measured over every PNG colour type and both WebP encodings Blender writes: alpha for a PNG of
 * colour type 4 (grey + alpha) or 6 (RGBA), and for ANY PNG with a `tRNS` chunk (palette, RGB or
 * grey); none for RGB, grey or palette without one. A WebP has alpha when its `VP8X` header sets
 * the alpha flag, or its lossless `VP8L` header sets `alpha_is_used`; plain lossy `VP8 ` has none.
 * A JPEG never has alpha.
 */
export function imageHasAlpha(bytes: Uint8Array, mime: string): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (mime === 'image/png') {
    if (bytes.length < 26) return false;
    const colourType = bytes[25];
    if (colourType === 4 || colourType === 6) return true;
    // Walk the chunks to the first `IDAT`: `tRNS` must come before it.
    for (let at = 8; at + 8 <= bytes.length; ) {
      const type = tag(at + 4);
      if (type === 'tRNS') return true;
      if (type === 'IDAT' || type === 'IEND') return false;
      at += 12 + view.getUint32(at);
    }
    return false;
  }
  if (mime === 'image/webp') {
    if (bytes.length < 30) return false;
    const chunk = tag(12);
    if (chunk === 'VP8X') return (bytes[20] & 0x10) !== 0;
    // VP8L: signature byte 0x2f, then 14 + 14 bits of size and the `alpha_is_used` bit.
    if (chunk === 'VP8L') return ((view.getUint32(21, true) >>> 28) & 1) === 1;
    return false;
  }
  return false;
}

/**
 * #1434 — a texture's placement, when the file moves, turns or scales it. Blender honours it on the
 * image's mapping (`texture_mapping_set`); a slot does not carry it yet, and a map drawn unmoved
 * would be the wrong picture, so the map is left out and named.
 */
function placed(texture: FbxTextureLink): boolean {
  const off = (v: number[] | null, rest: number) => v !== null && v.some((c) => c !== rest);
  return off(texture.translation, 0) || off(texture.rotation, 0) || off(texture.scaling, 1);
}

/** The mesh's slots, with the texture links a slot does not carry, each with its reason. */
function materialsOf(
  mesh: Mesh,
  images: ImageTable,
): { slot: FbxMaterialSlot; unheldMaps: string[] }[] {
  const list = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Material[];
  // The loader's own stand-in when the file gives a mesh no material: not a slot of the file.
  if (list.length === 1 && list[0].name === '__DEFAULT') return [];
  return list.map((material) => {
    const m = material as Material & {
      color?: Color;
      shininess?: number;
      bumpScale?: number;
    };
    const shininess = Math.max(m.shininess ?? 20, 0);
    const links = (m.userData.fbxTextures ?? []) as FbxTextureLink[];
    const unheldMaps: string[] = [];
    const take = (texture: FbxTextureLink): FbxSlotImage | null => {
      const why = texture.layered
        ? 'a layered texture'
        : placed(texture)
          ? `"${texture.file}" is moved, turned or scaled on the surface`
          : null;
      const image = why === null ? images.add(texture) : why;
      if (typeof image === 'string') {
        unheldMaps.push(`${texture.link}: ${image}`);
        return null;
      }
      return { image, clamp: texture.wrapU === 1 || texture.wrapV === 1 };
    };
    let baseColorImage: FbxSlotImage | null = null;
    let normalImage: FbxSlotImage | null = null;
    const alphaLinks: FbxTextureLink[] = [];
    // A second image for an input it already has: Blender's loop keeps the last one, this the
    // first, so the other is named rather than silently disagreeing.
    const second = (texture: FbxTextureLink) =>
      unheldMaps.push(`${texture.link}: "${texture.file}" is a second image for the same input`);
    for (const texture of links) {
      if (BASE_COLOR_LINKS.has(texture.link)) {
        if (baseColorImage === null) baseColorImage = take(texture);
        else second(texture);
      } else if (NORMAL_LINKS.has(texture.link)) {
        if (normalImage === null) normalImage = take(texture);
        else second(texture);
      } else if (ALPHA_LINKS.has(texture.link)) {
        alphaLinks.push(texture);
      } else {
        unheldMaps.push(`${texture.link}: a slot carries no image there yet`);
      }
    }
    // #1435 — the alpha, by Blender's order (`import_fbx.py`, 5.1.1): a base colour image with an
    // alpha channel feeds the surface's alpha and overrides any transparency link (the
    // `image.depth == 32` pass, `copy_from`), and the slot draws it (`slotMaterial`). Otherwise a
    // transparency link's image does, through its Alpha output — which is 1, so nothing to draw,
    // when that image has no alpha channel (the base colour image's own case included). The one
    // case left is an image with alpha that is not the base colour's (#1439); it is read to ask,
    // and not stored.
    if (baseColorImage === null || !images.list[baseColorImage.image].hasAlpha) {
      for (const texture of alphaLinks) {
        const image = decodeImage(texture);
        if (typeof image === 'string') unheldMaps.push(`${texture.link}: ${image}`);
        else if (image.hasAlpha) {
          unheldMaps.push(
            `${texture.link}: "${texture.file}" gives the surface its alpha, and only the base colour image's alpha is drawn yet (#1439)`,
          );
        }
      }
    }
    return {
      slot: {
        name: material.name,
        // three reads the file's diffuse colour as sRGB and converts it (`FBXLoader.js:542-547`);
        // Blender takes the same numbers as the linear base colour (`import_fbx.py:2076`), so the
        // conversion is undone to get the file's numbers back. Measured: the fixture's red reads
        // 0.8 in Blender, and 0.604 off three's material.
        color: fileColour(m.color),
        roughness: Math.min(1, Math.max(0, 1 - Math.sqrt(shininess) / 10)),
        ...(baseColorImage === null ? {} : { baseColorImage }),
        // `BumpFactor`, which three reads as `bumpScale` and Blender as the normal map's strength
        // (`import_fbx.py:2104`); 1 when the file states none, in both.
        ...(normalImage === null
          ? {}
          : { normalImage: { ...normalImage, strength: m.bumpScale ?? 1 } }),
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

/** The file's triples (points or directions) in Y-up, `A · p` (`fbxScene.ts`). */
function yUpTriples(values: readonly number[]): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i + 2 < values.length; i += 3) {
    out.set(toYUp(values[i], values[i + 1], values[i + 2]), i);
  }
  return out;
}

function readPlain(polygons: FbxPolygons): Omit<FbxMeshRead, 'name' | 'materials'> {
  return {
    data: {
      points: yUpTriples(polygons.points),
      faceSizes: Uint32Array.from(polygons.faceSizes),
      cornerPoints: Uint32Array.from(polygons.cornerPoints),
      cornerNormals: polygons.normals === null ? null : yUpTriples(polygons.normals),
      ...cornerAndFaceLayers(polygons),
      pointLayers: [],
      vertexGroups: [],
    },
    vertexGroupBones: null,
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
  };
}
