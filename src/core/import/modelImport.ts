// What every format's importer uses to fill the one model (#1434).
//
// An importer reads its file and writes ordinary nodes, then stops existing (dharana §0). Where two
// importers write the same thing (a Group for an empty, a parent edge, an Object's channel, a native
// material's images and pivot), they call one function here, so the two roads cannot drift apart
// over what the same thing looks like. Nothing in this file knows which format it was read from.
//
// REF: src/core/import/nativeGltfImport.ts (the glTF road), src/core/import/fbxImportChain.ts and
//      src/core/import/fbxMesh.ts (the FBX road); issues #1051, #1123, #1316, #1320, #1434.

import type {
  BakedTextureMagFilter,
  BakedTextureRef,
  InlineMaterialSpec,
  UvPlacement,
  Vec3,
} from '../../nodes/types';
import type { Op } from '../dag/types';
import { FILTER_NAME_OF_GLTF, WRAP_NAME_OF_GLTF } from '../../nodes/materialSchema';
import { CENTRE_PIVOT, ORIGIN_PIVOT, rebasePlacementPivot } from '../../app/material/uvPlacement';

// ── Images ──────────────────────────────────────────────────────────────────────────────────────

/** The image type the bytes ARE, by signature. A declared `mimeType` is a claim; this is the file. */
export function sniffImage(bytes: Uint8Array): string | null {
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
  // #1320 — `RIFF` <size> `WEBP`.
  const ascii = (at: number, word: string) =>
    [...word].every((c, i) => bytes[at + i] === c.charCodeAt(0));
  if (bytes.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  return null;
}

// ── Materials ───────────────────────────────────────────────────────────────────────────────────

/**
 * #1123 — the material's placements restated about the pivot the native material draws with.
 *
 * The converter captures `KHR_texture_transform` as the file wrote it, about the UV origin, which is
 * right for the clone road (`applyGltfUvTransform` places with `ORIGIN_PIVOT`). A native material is
 * drawn by `materialRegistry`'s `build`, which places about `CENTRE_PIVOT`, so each placement is
 * restated once here and the file's convention stops existing. An identity placement comes back
 * unchanged, so an untransformed material keys exactly as before.
 */
export function withCentrePivot(material: InlineMaterialSpec): InlineMaterialSpec {
  const rebase = (p: UvPlacement) => rebasePlacementPivot(p, ORIGIN_PIVOT, CENTRE_PIVOT);
  const perMap = material.mapUvTransforms;
  return {
    ...material,
    uvTransform: rebase(material.uvTransform),
    ...(perMap === undefined
      ? {}
      : {
          mapUvTransforms: Object.fromEntries(
            Object.entries(perMap).map(([slot, p]) => [slot, rebase(p as UvPlacement)]),
          ) as InlineMaterialSpec['mapUvTransforms'],
        }),
  };
}

/** The texture and sampler tables a captured texture ref indexes, in glTF's shape. */
export interface TextureTables {
  readonly textures?: readonly { readonly sampler?: number }[];
  readonly samplers?: readonly {
    readonly wrapS?: number;
    readonly wrapT?: number;
    readonly magFilter?: number;
    readonly minFilter?: number;
  }[];
}

/**
 * A material with every captured texture pointing at the project's copy of its image. The captured
 * refs say "inherit the clone's texture" and carry GL enums; a native material has no clone, so each
 * becomes a project ref sampled the way the file asks. `tables` holds the texture and sampler tables
 * the refs index: a glTF file's own, or the ones the FBX road states for its slots (#1434).
 */
export function withProjectImages(
  material: InlineMaterialSpec,
  tables: TextureTables,
  imageKeys: ReadonlyMap<number, string>,
): InlineMaterialSpec {
  const maps = {} as { -readonly [K in keyof InlineMaterialSpec['maps']]: BakedTextureRef | null };
  for (const slot of Object.keys(material.maps) as (keyof InlineMaterialSpec['maps'])[]) {
    const captured = material.maps[slot];
    if (captured === undefined) continue; // #1327 — an unseeded slot the file leaves empty
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
    const samplerIndex = tables.textures?.[textureIndex]?.sampler;
    const sampler = samplerIndex === undefined ? undefined : tables.samplers?.[samplerIndex];
    maps[slot] = {
      hash: key,
      store: 'project',
      colorSpace: captured.colorSpace,
      flipY: false,
      // #1316 — the file's sampler by name. glTF's wrap default is REPEAT; with no filter the
      // renderer's own defaults are written out (linear, trilinear), as they always were.
      wrapS: WRAP_NAME_OF_GLTF[sampler?.wrapS ?? 10497] ?? 'repeat',
      wrapT: WRAP_NAME_OF_GLTF[sampler?.wrapT ?? 10497] ?? 'repeat',
      magFilter: magFilterName(sampler?.magFilter),
      minFilter: FILTER_NAME_OF_GLTF[sampler?.minFilter ?? -1] ?? 'linear-mipmap-linear',
    };
  }
  return { ...material, maps };
}

/** #1316 — a magnification filter by name: only NEAREST and LINEAR are one (glTF sampler schema). */
function magFilterName(gl: number | undefined): BakedTextureMagFilter {
  const name = FILTER_NAME_OF_GLTF[gl ?? -1];
  return name === 'nearest' ? 'nearest' : 'linear';
}

// ── The scene's structure ───────────────────────────────────────────────────────────────────────

/**
 * The Group an import lands in, rotating and scaling about `pivot` (the model's own centre), placed
 * so the model's origin sits at `position`.
 */
export function importGroupOp(groupId: string, position: Vec3, pivot: Vec3): Op {
  return {
    type: 'addNode',
    nodeId: groupId,
    nodeType: 'Group',
    params: {
      position: [position[0] + pivot[0], position[1] + pivot[1], position[2] + pivot[2]],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      pivot,
    },
  };
}

/**
 * #1051 — an empty, as a Group named by the file: Blender's Empty. It has no pivot of its own; the
 * file states an empty's transform about its own origin, and the import Group's pivot already places
 * the model as a whole.
 */
export function emptyOps(emptyId: string, transform: object, name: string): Op[] {
  return [
    { type: 'addNode', nodeId: emptyId, nodeType: 'Group', params: transform },
    { type: 'setMeta', nodeId: emptyId, name },
  ];
}

/** #1051 — `child` hangs under `parent`: the hierarchy is an edge, not a field. */
export function parentEdge(child: string, parent: string): Op {
  return {
    type: 'connect',
    from: { node: child, socket: 'out' },
    to: { node: parent, socket: 'children' },
  };
}

// ── Object animation ────────────────────────────────────────────────────────────────────────────

/**
 * The id Auto-Key gives the channel driving `paramPath` on `target`. `paramPath` must be id-safe
 * already (`position`, `quaternion`, `scale`, `rotation` are), as an import writes only those.
 */
export function objectChannelId(target: string, paramPath: string): string {
  return `${target}_${paramPath}_channel`;
}

/**
 * #1051 — a keyed parameter of an Object or Group as an ordinary channel: what Auto-Key or a director
 * would have made for the same parameter, with the same node type and id, named by its param.
 * Nothing refers back to the file.
 */
export function objectChannelOp(
  target: string,
  paramPath: string,
  valueType: 'quat' | 'vec3',
  keyframes: readonly unknown[],
): Op {
  return {
    type: 'addNode',
    nodeId: objectChannelId(target, paramPath),
    nodeType: valueType === 'quat' ? 'KeyframeChannelQuat' : 'KeyframeChannelVec3',
    params: { name: paramPath, target, paramPath, keyframes },
  };
}
