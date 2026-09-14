// #1049 — the NATIVE glTF import road: the file is read into stored polygon meshes and then stops
// existing.
//
// ── WHAT THIS ROAD WRITES, AND WHAT IT DOES NOT ─────────────────────────────────────────────────
//
// One import Group, and under it one ordinary `Object` + `PolyMeshData` pair per glTF node — the
// shape Blender's importer produces (an Object over a Mesh datablock). No `GltfAsset`, no
// `GltfData`, no clone, no reference into the file: the mesh lives in the project, so deleting the
// source changes nothing. This is the only module on the road that knows what a glTF is; everything
// after `buildNativeGltfImportOps` returns is the native model.
//
// ── A WHOLE IMPORT IS NATIVE OR IT IS REFUSED, NEVER SPLIT PER CHILD ────────────────────────────
//
// The clone road still owns what the native model cannot yet hold, and a file that needs any of it
// is refused WHOLE, by name, with the issue that brings it across: skinning (#393), clips and
// nesting (#1051), several primitives on one mesh (#1052), morph targets (#1060),
// a mesh shared by several nodes (#1061), and vertex attributes or extensions the native model
// would drop (#1062). Making the importable
// children native and leaving the rest on the clone would be two owners of one import, which is the
// handover the decision on #1049 rules out. The refusals are the distance still to go, stated where
// an import meets it.
//
// ── IMAGES COME ACROSS AS THE PROJECT'S OWN FILES (#1050) ───────────────────────────────────────
//
// Every image a material samples is written into the project's image folder as the file's own
// PNG/JPEG bytes, and the material's texture refs name those files, with the sampler translated into
// three's constants by the loader's own table. Everything that can refuse — every mesh, every
// material, every image — is read before the first image is written, so a refused import leaves no
// file behind.
//
// ── THE READER IS NOT THE LOADER, AND WHERE IT FOLLOWS THE LOADER IT SAYS SO ────────────────────
//
// Strips and fans become triangles by three's own rule (`toTrianglesDrawMode`,
// `BufferGeometryUtils.js`): a fan is `(0, i, i+1)`, a strip alternates `(i, i+1, i+2)` and
// `(i+2, i+1, i)`. UVs are taken as the file stores them, which is what GLTFLoader hands the clone
// road, so the two roads sample a texture identically once textures arrive. Points are welded by
// position through the model's own `weldByPosition`, the same weld the import-time point count uses.
//
// REF: src/core/import/gltfImportChain.ts (the clone road this sits beside), src/core/import/glb.ts
//      (container + accessors), src/app/meshGeometryData.ts (packing), src/nodes/PolyMeshData.ts;
//      issues #1049, #1054, #1050, #1051, #1052, #393.

import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearMipmapNearestFilter,
  MirroredRepeatWrapping,
  NearestFilter,
  NearestMipmapLinearFilter,
  NearestMipmapNearestFilter,
  RepeatWrapping,
} from 'three';
import type {
  BakedTextureRef,
  InlineMaterialSpec,
  MeshGeometryData,
  Vec3,
} from '../../nodes/types';
import type { Op } from '../dag/types';
import {
  decodeDataUri,
  parseGltfContainer,
  readAccessor,
  resolveBuffers,
  type GltfJson,
} from './glb';
import {
  buildNodeNameMap,
  computeGltfBoundsCenter,
  defaultTRS,
  hashId,
  type GltfImportChainArgs,
} from './gltfImportChain';
import { gltfJsonMaterialToOpenpbr } from './gltfJsonMaterialToOpenpbr';
import { weldByPosition } from '../../app/pointIdentity';
import { packMeshData } from '../../app/meshGeometryData';

/** Why a file cannot be imported natively yet, and the issue that changes that. */
export interface NativeImportRefusal {
  readonly refused: string;
  readonly issue: string;
}

export interface NativeImportResult {
  readonly ops: Op[];
  readonly groupId: string;
  readonly objectIds: readonly string[];
}

/** The parts of a glTF document this road reads beyond what `GltfJson` declares. */
type NativeGltfJson = GltfJson & {
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  textures?: { source?: number; sampler?: number }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  samplers?: { wrapS?: number; wrapT?: number; magFilter?: number; minFilter?: number }[];
  meshes?: {
    primitives?: {
      material?: number;
      mode?: number;
      indices?: number;
      attributes?: Record<string, number>;
      targets?: unknown[];
      extensions?: Record<string, unknown>;
    }[];
  }[];
};

const TRIANGLES = 4;
const TRIANGLE_STRIP = 5;
const TRIANGLE_FAN = 6;

// What a stored mesh holds per vertex (#1062). Anything else in a primitive (vertex colours, a
// second UV set, skin weights) would be read past and left behind, so its file is refused instead.
const HELD_ATTRIBUTES = new Set(['POSITION', 'NORMAL', 'TEXCOORD_0']);

// The extensions a native import carries all the way to the screen: the material lobes the
// converter captures into the IR and `openpbrToThree` draws. The clone road's supported list is
// wider because three's loader decodes compression and quantization for it; this reader does not,
// so those are refused here too. A missing entry refuses a file that could have come across, which
// is the safe direction.
const HELD_EXTENSIONS = new Set([
  'KHR_materials_ior',
  'KHR_materials_clearcoat',
  'KHR_materials_transmission',
  'KHR_materials_emissive_strength',
]);

// #1050 — where a material may sample a texture and still arrive whole: the slots the IR captures
// (`IR_SLOT_SOURCES` in the converter). A texture anywhere else, such as a clearcoat texture inside
// an extension this road holds for its factors, would be read past and left behind.
const HELD_TEXTURE_SLOTS = new Set([
  'pbrMetallicRoughness.baseColorTexture',
  'pbrMetallicRoughness.metallicRoughnessTexture',
  'normalTexture',
  'occlusionTexture',
  'emissiveTexture',
]);

// A glTF sampler's GL enums as three.js constants, by GLTFLoader's own tables and defaults
// (`GLTFLoader.js:2198-2211`, `:3229-3232`, three r169), so a native texture samples as the clone
// road's does. An absent or unknown value takes the loader's default.
const THREE_FILTER_OF: Readonly<Record<number, number>> = {
  9728: NearestFilter,
  9729: LinearFilter,
  9984: NearestMipmapNearestFilter,
  9985: LinearMipmapNearestFilter,
  9986: NearestMipmapLinearFilter,
  9987: LinearMipmapLinearFilter,
};
const THREE_WRAP_OF: Readonly<Record<number, number>> = {
  33071: ClampToEdgeWrapping,
  33648: MirroredRepeatWrapping,
  10497: RepeatWrapping,
};

/** The file-level reasons an import cannot be native yet, checked before any bytes are read. */
function fileRefusal(json: NativeGltfJson): NativeImportRefusal | null {
  if ((json.extensionsRequired?.length ?? 0) > 0) {
    return {
      refused: `it requires extensions this reader does not implement (${json.extensionsRequired!.join(', ')})`,
      issue: '#1063',
    };
  }
  if ((json.skins?.length ?? 0) > 0) {
    return {
      refused: 'it is skinned, and skinning as a deform relation is not native yet',
      issue: '#393',
    };
  }
  if ((json.animations?.length ?? 0) > 0) {
    return {
      refused: 'it carries animation clips, which become Object channels later',
      issue: '#1051',
    };
  }
  // `KHR_texture_transform` is not held: the converter captures its placement, but the native material
  // pivots a placement about the texture centre where glTF pivots about the UV origin
  // (`materialRegistry.ts`, `build`), so a transformed texture would draw shifted.
  const unheld = (json.extensionsUsed ?? []).filter((ext) => !HELD_EXTENSIONS.has(ext));
  if (unheld.length > 0) {
    return {
      refused: `it uses ${unheld.join(', ')}, which a native import would drop`,
      issue: '#1062',
    };
  }
  for (let i = 0; i < json.nodes.length; i++) {
    const node = json.nodes[i];
    if ((node.children?.length ?? 0) > 0) {
      return {
        refused: `node ${i} has children, and a hierarchy is not written as parent edges yet`,
        issue: '#1051',
      };
    }
    if (typeof node.mesh !== 'number') {
      return {
        refused: `node ${i} has no mesh (an empty), and empties arrive with the hierarchy`,
        issue: '#1051',
      };
    }
  }
  // After the hierarchy, so a nested file is refused for its nesting first. Every node has a mesh
  // by here.
  const nodeOfMesh = new Map<number, number>();
  for (let i = 0; i < json.nodes.length; i++) {
    const mesh = json.nodes[i].mesh as number;
    const first = nodeOfMesh.get(mesh);
    if (first !== undefined) {
      return {
        refused: `nodes ${first} and ${i} share mesh ${mesh}, which would be stored as two separate copies`,
        issue: '#1061',
      };
    }
    nodeOfMesh.set(mesh, i);
  }
  return null;
}

/** The index buffer as vertex numbers, or `null` when the accessor is not an index accessor. */
function readIndices(
  json: NativeGltfJson,
  buffers: Uint8Array[],
  accessorIndex: number,
): Uint32Array | null {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor || accessor.type !== 'SCALAR') return null;
  const bytes =
    accessor.componentType === 5121
      ? 1
      : accessor.componentType === 5123
        ? 2
        : accessor.componentType === 5125
          ? 4
          : 0;
  if (bytes === 0) return null;
  const view = json.bufferViews?.[accessor.bufferView];
  const bin = view ? buffers[view.buffer] : undefined;
  if (!view || !bin) return null;
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  if (offset + accessor.count * bytes > bin.byteLength) return null;
  const dv = new DataView(bin.buffer, bin.byteOffset + offset, accessor.count * bytes);
  const out = new Uint32Array(accessor.count);
  for (let i = 0; i < accessor.count; i++) {
    out[i] =
      bytes === 1
        ? dv.getUint8(i)
        : bytes === 2
          ? dv.getUint16(i * 2, true)
          : dv.getUint32(i * 4, true);
  }
  return out;
}

/** Is the accessor's view interleaved? `readAccessor` reads contiguous elements and would misread one. */
function interleaved(json: NativeGltfJson, accessorIndex: number, elementBytes: number): boolean {
  const accessor = json.accessors?.[accessorIndex];
  const view = accessor ? json.bufferViews?.[accessor.bufferView] : undefined;
  const stride = (view as { byteStride?: number } | undefined)?.byteStride;
  return typeof stride === 'number' && stride !== elementBytes;
}

/** Vertex numbers in draw order → triangle corners, by three's `toTrianglesDrawMode` rule. */
export function triangulate(order: Uint32Array, mode: number): Uint32Array | null {
  if (mode === TRIANGLES) return order.length % 3 === 0 ? order : null;
  if (mode !== TRIANGLE_STRIP && mode !== TRIANGLE_FAN) return null;
  const triangles = Math.max(0, order.length - 2);
  const out = new Uint32Array(triangles * 3);
  for (let i = 0; i < triangles; i++) {
    if (mode === TRIANGLE_FAN) {
      out.set([order[0], order[i + 1], order[i + 2]], i * 3);
    } else if (i % 2 === 0) {
      out.set([order[i], order[i + 1], order[i + 2]], i * 3);
    } else {
      out.set([order[i + 2], order[i + 1], order[i]], i * 3);
    }
  }
  return out;
}

/** Read one glTF mesh into a stored polygon mesh, or say why it cannot be. */
export function readGltfMesh(
  json: NativeGltfJson,
  buffers: Uint8Array[],
  meshIndex: number,
): MeshGeometryData | NativeImportRefusal {
  const primitives = json.meshes?.[meshIndex]?.primitives ?? [];
  if (primitives.length !== 1) {
    return {
      refused: `mesh ${meshIndex} has ${primitives.length} primitives, and one mesh with a slot per primitive is not written yet`,
      issue: '#1052',
    };
  }
  const prim = primitives[0];
  const mode = prim.mode ?? TRIANGLES;
  if (mode !== TRIANGLES && mode !== TRIANGLE_STRIP && mode !== TRIANGLE_FAN) {
    return {
      refused: `mesh ${meshIndex} draws lines or points, which are not a polygon mesh`,
      issue: '#1063',
    };
  }
  if (prim.extensions?.KHR_draco_mesh_compression !== undefined) {
    return {
      refused: `mesh ${meshIndex} is Draco-compressed, which this reader does not decode`,
      issue: '#1063',
    };
  }
  if ((prim.targets?.length ?? 0) > 0) {
    return {
      refused: `mesh ${meshIndex} has morph targets, which the native model does not hold yet`,
      issue: '#1060',
    };
  }
  const unheldAttributes = Object.keys(prim.attributes ?? {}).filter(
    (name) => !HELD_ATTRIBUTES.has(name),
  );
  if (unheldAttributes.length > 0) {
    return {
      refused: `mesh ${meshIndex} carries ${unheldAttributes.join(', ')}, which the stored mesh does not hold yet`,
      issue: '#1062',
    };
  }
  const positionAccessor = prim.attributes?.POSITION;
  if (typeof positionAccessor !== 'number' || json.accessors?.[positionAccessor]?.type !== 'VEC3') {
    return { refused: `mesh ${meshIndex} has no VEC3 POSITION`, issue: '#1063' };
  }
  const uvAccessor = prim.attributes?.TEXCOORD_0;
  const normalAccessor = prim.attributes?.NORMAL;
  for (const [accessorIndex, elementBytes] of [
    [positionAccessor, 12],
    [uvAccessor, 8],
    [normalAccessor, 12],
  ] as const) {
    if (typeof accessorIndex === 'number' && interleaved(json, accessorIndex, elementBytes)) {
      return {
        refused: `mesh ${meshIndex} stores interleaved vertex data, which this reader does not split`,
        issue: '#1063',
      };
    }
  }

  const positions = readAccessor(json, buffers, positionAccessor);
  const vertices = positions.length / 3;
  const order =
    typeof prim.indices === 'number'
      ? readIndices(json, buffers, prim.indices)
      : Uint32Array.from({ length: vertices }, (_, i) => i);
  if (order === null)
    return { refused: `mesh ${meshIndex} has an unreadable index accessor`, issue: '#1063' };
  const corners = triangulate(order, mode);
  if (corners === null)
    return { refused: `mesh ${meshIndex} does not form whole triangles`, issue: '#1063' };
  for (const v of corners) {
    if (v >= vertices)
      return { refused: `mesh ${meshIndex} indexes vertex ${v} of ${vertices}`, issue: '#1063' };
  }

  // The weld: split vertices at one position are one point. `map[v]` is vertex v's point.
  const scratch = new BufferGeometry();
  scratch.setAttribute('position', new BufferAttribute(positions, 3));
  const weld = weldByPosition(scratch);
  scratch.dispose();
  const points = new Float32Array(weld.points * 3);
  const seen = new Uint8Array(weld.points);
  for (let v = 0; v < vertices; v++) {
    const p = weld.map[v];
    if (seen[p] === 0) {
      seen[p] = 1;
      points.set(positions.subarray(v * 3, v * 3 + 3), p * 3);
    }
  }

  const gather = (accessorIndex: number | undefined, width: number): Float32Array | null => {
    if (typeof accessorIndex !== 'number') return null;
    const values = readAccessor(json, buffers, accessorIndex);
    if (values.length !== vertices * width) return null;
    const out = new Float32Array(corners.length * width);
    for (let c = 0; c < corners.length; c++) {
      out.set(values.subarray(corners[c] * width, corners[c] * width + width), c * width);
    }
    return out;
  };

  return {
    points,
    faceSizes: new Uint32Array(corners.length / 3).fill(3),
    cornerPoints: Uint32Array.from(corners, (v) => weld.map[v]),
    cornerUVs: gather(uvAccessor, 2),
    cornerNormals: gather(normalAccessor, 3),
  };
}

/** #1050 — the native road's own arguments: the shared ones, plus where its images go. */
export interface NativeGltfImportArgs extends GltfImportChainArgs {
  /**
   * Store an image's encoded bytes in the project and return the key its texture ref names.
   * Required, so there is no road on which a textured file arrives with nowhere to put its pixels.
   */
  readonly storeImage: (bytes: Uint8Array, mime: string) => Promise<string>;
}

interface TextureSite {
  /** Where the reference sits in the material, as a dotted path. */
  readonly path: string;
  readonly info: { readonly index: number } & Readonly<Record<string, unknown>>;
}

/** Every texture reference in a material, found by shape wherever it nests. */
function textureSites(value: unknown, path = '', out: TextureSite[] = []): TextureSite[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
  const o = value as Record<string, unknown>;
  if (path !== '' && typeof o.index === 'number') {
    out.push({ path, info: o as TextureSite['info'] });
  }
  for (const [key, child] of Object.entries(o)) {
    textureSites(child, path === '' ? key : `${path}.${key}`, out);
  }
  return out;
}

function materialOf(json: NativeGltfJson, materialIndex: number): unknown {
  return (json.materials as unknown[] | undefined)?.[materialIndex] ?? {};
}

/** Why a material's textures cannot come across whole, or null. */
function materialRefusal(json: NativeGltfJson, materialIndex: number): NativeImportRefusal | null {
  for (const { path, info } of textureSites(materialOf(json, materialIndex))) {
    const where = `material ${materialIndex} ${path}`;
    if (!HELD_TEXTURE_SLOTS.has(path)) {
      return { refused: `${where} is a texture the native material does not hold`, issue: '#1062' };
    }
    if ((info.texCoord ?? 0) !== 0) {
      return {
        refused: `${where} samples UV set ${String(info.texCoord)}, and a native mesh holds one`,
        issue: '#1062',
      };
    }
    const extensions = Object.keys((info.extensions as object | undefined) ?? {});
    if (extensions.length > 0) {
      return {
        refused: `${where} uses ${extensions.join(', ')}, which a native import would drop`,
        issue: '#1062',
      };
    }
    if (path === 'normalTexture' && (info.scale ?? 1) !== 1) {
      return {
        refused: `${where} scales its normals by ${String(info.scale)}, which the native material does not hold`,
        issue: '#1062',
      };
    }
    if (path === 'occlusionTexture' && (info.strength ?? 1) !== 1) {
      return {
        refused: `${where} has occlusion strength ${String(info.strength)}, which the native material does not hold`,
        issue: '#1062',
      };
    }
  }
  return null;
}

interface ReadImage {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

/** The image type the bytes ARE, by signature. A declared `mimeType` is a claim; this is the file. */
function sniffImage(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

/** The image a texture samples, as the file's own encoded bytes, or why it cannot be read. */
async function readTextureImage(
  json: NativeGltfJson,
  buffers: Uint8Array[],
  textureIndex: number,
  resolveBuffer: GltfImportChainArgs['resolveBuffer'],
): Promise<ReadImage | NativeImportRefusal> {
  const texture = json.textures?.[textureIndex];
  if (typeof texture?.source !== 'number') {
    return {
      refused: `texture ${textureIndex} has no image of its own (a source inside an extension is not decoded)`,
      issue: '#1063',
    };
  }
  const image = json.images?.[texture.source];
  let bytes: Uint8Array | null = null;
  if (typeof image?.bufferView === 'number') {
    const view = json.bufferViews?.[image.bufferView];
    const bin = view ? buffers[view.buffer] : undefined;
    const offset = view?.byteOffset ?? 0;
    if (view && bin && offset + view.byteLength <= bin.byteLength) {
      bytes = bin.subarray(offset, offset + view.byteLength);
    }
  } else if (typeof image?.uri === 'string') {
    if (image.uri.startsWith('data:')) bytes = decodeDataUri(image.uri);
    else if (resolveBuffer) bytes = await resolveBuffer(image.uri);
  }
  if (bytes === null) {
    return { refused: `image ${texture.source} could not be read`, issue: '#1063' };
  }
  const mime = sniffImage(bytes);
  if (mime === null) {
    return { refused: `image ${texture.source} is neither PNG nor JPEG`, issue: '#1063' };
  }
  return { bytes, mime };
}

/**
 * A material with every captured texture pointing at the project's copy of its image. The captured
 * refs say "inherit the clone's texture" and carry GL enums; a native material has no clone, so each
 * becomes a project ref sampled the way the file asks.
 */
function withProjectImages(
  material: InlineMaterialSpec,
  json: NativeGltfJson,
  imageKeys: ReadonlyMap<number, string>,
): InlineMaterialSpec {
  const maps = {} as { -readonly [K in keyof InlineMaterialSpec['maps']]: BakedTextureRef | null };
  for (const slot of Object.keys(material.maps) as (keyof InlineMaterialSpec['maps'])[]) {
    const captured = material.maps[slot];
    if (captured === null) {
      maps[slot] = null;
      continue;
    }
    const textureIndex = captured.gltfTexture;
    const key = textureIndex === undefined ? undefined : imageKeys.get(textureIndex);
    if (textureIndex === undefined || key === undefined) {
      throw new Error(
        `nativeGltfImport: the ${slot} map was captured but its image was never stored`,
      );
    }
    const samplerIndex = json.textures?.[textureIndex]?.sampler;
    const sampler = samplerIndex === undefined ? undefined : json.samplers?.[samplerIndex];
    maps[slot] = {
      hash: key,
      store: 'project',
      colorSpace: captured.colorSpace,
      flipY: false,
      wrapS: THREE_WRAP_OF[sampler?.wrapS ?? -1] ?? RepeatWrapping,
      wrapT: THREE_WRAP_OF[sampler?.wrapT ?? -1] ?? RepeatWrapping,
      magFilter: THREE_FILTER_OF[sampler?.magFilter ?? -1] ?? LinearFilter,
      minFilter: THREE_FILTER_OF[sampler?.minFilter ?? -1] ?? LinearMipmapLinearFilter,
    };
  }
  return { ...material, maps };
}

/**
 * Build the native import's ops, or refuse the whole file by name.
 *
 * Deterministic: ids are content-addressed off the asset ref and each node's sanitised name, so
 * re-importing a file yields the same op stream.
 */
export async function buildNativeGltfImportOps(
  args: NativeGltfImportArgs,
): Promise<NativeImportResult | NativeImportRefusal> {
  const { json: parsed, bin } = parseGltfContainer(args.buffer);
  const json = parsed as NativeGltfJson;
  const refusal = fileRefusal(json);
  if (refusal !== null) return refusal;
  const buffers = await resolveBuffers(json, bin, args.resolveBuffer);
  const { keyByGltfNodeIndex } = buildNodeNameMap(json, args.assetRef);

  const groupId = hashId('nativeGrp', args.assetRef);
  const position: Vec3 = args.position ?? [0, 0, 0];
  // The same pivot the clone road bakes into its import Group, so both roads place a model alike.
  const pivot = computeGltfBoundsCenter(json);
  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: groupId,
      nodeType: 'Group',
      params: {
        position: [position[0] + pivot[0], position[1] + pivot[1], position[2] + pivot[2]],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        pivot,
      },
    },
  ];
  const objectIds: string[] = [];
  const materialTables = { textures: json.textures as never, samplers: json.samplers };

  // #1050 — everything that can refuse is read before anything is stored: every mesh, every
  // material, every image. A refused import leaves no file behind in the project.
  const meshes: MeshGeometryData[] = [];
  const textures = new Set<number>();
  for (let i = 0; i < json.nodes.length; i++) {
    const node = json.nodes[i];
    const data = readGltfMesh(json, buffers, node.mesh as number);
    if ('refused' in data) return data;
    meshes.push(data);
    const materialIndex = json.meshes![node.mesh as number].primitives![0].material;
    if (typeof materialIndex !== 'number') continue;
    const unheld = materialRefusal(json, materialIndex);
    if (unheld !== null) return unheld;
    for (const { info } of textureSites(materialOf(json, materialIndex))) textures.add(info.index);
  }
  const images = new Map<number, ReadImage>();
  for (const texture of [...textures].sort((a, b) => a - b)) {
    const image = await readTextureImage(json, buffers, texture, args.resolveBuffer);
    if ('refused' in image) return image;
    images.set(texture, image);
  }
  const imageKeys = new Map<number, string>();
  for (const [texture, image] of images) {
    imageKeys.set(texture, await args.storeImage(image.bytes, image.mime));
  }

  for (let i = 0; i < json.nodes.length; i++) {
    const node = json.nodes[i];
    const data = meshes[i];
    const prim = json.meshes![node.mesh as number].primitives![0];
    const key = keyByGltfNodeIndex[i];
    const dataId = hashId('nativeMesh', args.assetRef, key);
    const objectId = hashId('nativeObject', args.assetRef, key);
    const material = withProjectImages(
      gltfJsonMaterialToOpenpbr(
        typeof prim.material === 'number' ? (json.materials?.[prim.material] ?? {}) : {},
        materialTables,
        { vertexColors: prim.attributes?.COLOR_0 !== undefined },
      ),
      json,
      imageKeys,
    );
    const trs = defaultTRS(node);
    ops.push(
      {
        type: 'addNode',
        nodeId: dataId,
        nodeType: 'PolyMeshData',
        params: { mesh: packMeshData(data), material },
      },
      {
        type: 'addNode',
        nodeId: objectId,
        nodeType: 'Object',
        params: { position: trs.position, rotation: trs.rotation, scale: trs.scale },
      },
      {
        type: 'connect',
        from: { node: dataId, socket: 'out' },
        to: { node: objectId, socket: 'data' },
      },
      {
        type: 'connect',
        from: { node: objectId, socket: 'out' },
        to: { node: groupId, socket: 'children' },
      },
    );
    objectIds.push(objectId);
  }

  ops.push({
    type: 'connect',
    from: { node: groupId, socket: 'out' },
    to: { node: args.sceneNodeId, socket: 'children' },
  });
  return { ops, groupId, objectIds };
}
