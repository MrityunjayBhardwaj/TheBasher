// #1063 — Draco-compressed primitives are decoded into ordinary accessors before the native reader
// reads a single one, and the file stops being compressed as far as anything after this knows.
//
// This is what Blender's glTF importer does (`io_scene_gltf2/blender/imp/
// draco_compression_extension.py`, `decode_primitive`, called from `mesh.py` for every primitive
// that carries the extension): decode the primitive's bufferView, put the indices and each
// attribute into a NEW buffer with a new bufferView, and point the primitive's own accessors at
// them (:93-99, :130-136). Where the decoded count disagrees with the accessor's, the accessor takes
// the decoded one (:77-80, :111-116). The file itself is never rewritten — only the document the
// reader holds.
//
// Where this differs from Blender, on purpose: Blender logs and SKIPS a primitive it cannot decode
// (:64-66); the native road never imports part of a file (a whole import is native or refused), so a
// failed decode refuses the import by name and the file goes where a refused file goes.
//
// The decoder itself is injected. In the product it is three's DRACOLoader worker at the
// self-hosted `/draco/` path — the one the clone road already decodes this file with — and in unit
// tests it is `draco3d` running in Node. This module only knows the glTF side.
//
// REF: src/core/import/nativeGltfImport.ts (the reader this feeds); src/app/asset/dracoDecoder.ts
//      (the product decoder); ref/sources/blender-gltf-draco-v5.1.1; issue #1063.

import type { GltfJson } from './glb';

export const DRACO_EXTENSION = 'KHR_draco_mesh_compression';

/** The typed-array kinds a Draco attribute can be read into — DRACOLoader's `attributeTypes`. */
export type DracoArrayType =
  | 'Float32Array'
  | 'Int8Array'
  | 'Uint8Array'
  | 'Int16Array'
  | 'Uint16Array'
  | 'Uint32Array';

/** What to read out of one compressed primitive: each glTF attribute's Draco id and array kind. */
export interface DracoRequest {
  readonly attributes: Readonly<
    Record<string, { readonly id: number; readonly type: DracoArrayType }>
  >;
}

/** One decoded primitive: triangle indices, and each requested attribute's values. */
export interface DracoDecoded {
  readonly index: Uint32Array | null;
  readonly attributes: Readonly<Record<string, ArrayLike<number> & ArrayBufferView>>;
}

/** Decode one compressed primitive. Throws when the bytes cannot be decoded. */
export type DecodeDraco = (bytes: Uint8Array, request: DracoRequest) => Promise<DracoDecoded>;

/** A decode that could not complete, stated for the import notice. */
export interface DracoRefusal {
  readonly refused: string;
  readonly issue: '#1063';
}

type DracoJson = Omit<GltfJson, 'meshes'> & {
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  meshes?: {
    primitives?: {
      indices?: number;
      attributes?: Record<string, number>;
      extensions?: Record<string, unknown>;
    }[];
  }[];
};

interface DracoPrimitiveExtension {
  readonly bufferView: number;
  readonly attributes: Readonly<Record<string, number>>;
}

const ARRAY_TYPE_OF: Readonly<Record<number, DracoArrayType>> = {
  5120: 'Int8Array',
  5121: 'Uint8Array',
  5122: 'Int16Array',
  5123: 'Uint16Array',
  5125: 'Uint32Array',
  5126: 'Float32Array',
};

const COMPONENTS: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

const UNSIGNED_INT = 5125;

/** Does any primitive in the document carry Draco compression? */
export function usesDraco(json: GltfJson): boolean {
  return ((json as unknown as DracoJson).meshes ?? []).some((mesh) =>
    (mesh.primitives ?? []).some((prim) => prim.extensions?.[DRACO_EXTENSION] !== undefined),
  );
}

/**
 * Decode every Draco primitive into new buffers the document's accessors point at, and drop the
 * extension. Returns a NEW document and buffer list — the caller's are not touched — or refuses by
 * name when a primitive cannot be decoded.
 */
export async function decodeDracoPrimitives<J extends GltfJson>(
  source: J,
  sourceBuffers: readonly Uint8Array[],
  decode: DecodeDraco,
): Promise<{ json: J; buffers: Uint8Array[] } | DracoRefusal> {
  const json = structuredClone(source) as unknown as DracoJson;
  const buffers = [...sourceBuffers];
  json.accessors ??= [];
  json.bufferViews ??= [];

  /** Append bytes as a new buffer and view; returns the view's index. */
  const addView = (data: ArrayBufferView): number => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    buffers.push(bytes);
    json.bufferViews!.push({ buffer: buffers.length - 1, byteLength: bytes.byteLength });
    return json.bufferViews!.length - 1;
  };

  for (const [m, mesh] of (json.meshes ?? []).entries()) {
    for (const [p, prim] of (mesh.primitives ?? []).entries()) {
      const ext = prim.extensions?.[DRACO_EXTENSION] as DracoPrimitiveExtension | undefined;
      if (ext === undefined) continue;
      const where = `mesh ${m} primitive ${p}`;
      const refuse = (why: string): DracoRefusal => ({
        refused: `${where} is Draco-compressed and ${why}`,
        issue: '#1063',
      });

      const view = json.bufferViews[ext.bufferView];
      const bin = view === undefined ? undefined : buffers[view.buffer];
      if (view === undefined || bin === undefined)
        return refuse('its compressed bytes are missing');
      const bytes = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);

      const request: Record<string, { id: number; type: DracoArrayType }> = {};
      for (const [semantic, id] of Object.entries(ext.attributes)) {
        const accessor = json.accessors[prim.attributes?.[semantic] ?? -1];
        if (accessor === undefined)
          return refuse(`names ${semantic}, which the primitive does not carry`);
        const type = ARRAY_TYPE_OF[accessor.componentType];
        if (type === undefined)
          return refuse(`${semantic} has component type ${accessor.componentType}`);
        request[semantic] = { id, type };
      }

      let decoded: DracoDecoded;
      try {
        decoded = await decode(bytes, { attributes: request });
      } catch (err) {
        return refuse(`could not be decoded (${err instanceof Error ? err.message : String(err)})`);
      }

      if (decoded.index !== null) {
        const indexView = addView(decoded.index);
        const index = {
          bufferView: indexView,
          componentType: UNSIGNED_INT,
          count: decoded.index.length,
          type: 'SCALAR' as const,
        };
        if (typeof prim.indices === 'number' && json.accessors[prim.indices] !== undefined) {
          // The file's own accessor, re-pointed: indices are read as 32-bit whatever it declared.
          Object.assign(json.accessors[prim.indices], index, { byteOffset: 0 });
        } else {
          json.accessors.push(index);
          prim.indices = json.accessors.length - 1;
        }
      }
      for (const semantic of Object.keys(request)) {
        const values = decoded.attributes[semantic];
        if (values === undefined) return refuse(`its decode returned no ${semantic}`);
        const accessor = json.accessors[prim.attributes![semantic]];
        accessor.bufferView = addView(values);
        accessor.byteOffset = 0;
        accessor.count = values.length / (COMPONENTS[accessor.type] ?? 1);
      }

      delete prim.extensions![DRACO_EXTENSION];
      if (Object.keys(prim.extensions!).length === 0) delete prim.extensions;
    }
  }

  const drop = (list: string[] | undefined) => list?.filter((e) => e !== DRACO_EXTENSION);
  json.extensionsUsed = drop(json.extensionsUsed);
  json.extensionsRequired = drop(json.extensionsRequired);
  if (json.extensionsUsed?.length === 0) delete json.extensionsUsed;
  if (json.extensionsRequired?.length === 0) delete json.extensionsRequired;
  return { json: json as unknown as J, buffers };
}
