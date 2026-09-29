// A Draco decoder for unit tests: `draco3d` (Google's decoder, the same library three ships under
// `/draco/`) running in Node, driven the way three's DRACOLoader worker drives it
// (`three/examples/jsm/loaders/DRACOLoader.js`: `decodeGeometry`, `decodeIndex`, `decodeAttribute`,
// `getDracoDataType`). The product decodes through that worker instead (`src/app/asset/
// dracoDecoder.ts`); both read the file's own bytes with the same decoder.
//
// REF: src/core/import/gltfDraco.ts (the `DecodeDraco` contract); issue #1063.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import draco3d from 'draco3d';
import type { DecodeDraco, DracoArrayType } from '../core/import/gltfDraco';

type DecoderModule = Awaited<ReturnType<typeof draco3d.createDecoderModule>>;

let modulePromise: Promise<DecoderModule> | null = null;

const CTOR: Record<
  DracoArrayType,
  {
    new (
      buffer: ArrayBufferLike,
      offset: number,
      length: number,
    ): ArrayBufferView & ArrayLike<number> & { slice(): ArrayBufferView & ArrayLike<number> };
    BYTES_PER_ELEMENT: number;
  }
> = {
  Float32Array,
  Int8Array,
  Uint8Array,
  Int16Array,
  Uint16Array,
  Uint32Array,
};

function dataTypeOf(draco: DecoderModule, type: DracoArrayType): number {
  switch (type) {
    case 'Float32Array':
      return draco.DT_FLOAT32;
    case 'Int8Array':
      return draco.DT_INT8;
    case 'Int16Array':
      return draco.DT_INT16;
    case 'Uint8Array':
      return draco.DT_UINT8;
    case 'Uint16Array':
      return draco.DT_UINT16;
    case 'Uint32Array':
      return draco.DT_UINT32;
  }
}

/** The decoder's wasm, as the fresh ArrayBuffer the module option takes. */
function wasmBytes(): ArrayBuffer {
  const file = readFileSync(createRequire(import.meta.url).resolve('draco3d/draco_decoder.wasm'));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
}

export const decodeDracoInNode: DecodeDraco = async (bytes, request) => {
  // The wasm is handed over as bytes: under happy-dom `window` exists, so the loader would
  // otherwise take itself for a browser and fetch the file from the page's URL.
  modulePromise ??= draco3d.createDecoderModule({
    wasmBinary: wasmBytes(),
  });
  const draco = await modulePromise;
  const decoder = new draco.Decoder();
  const mesh = new draco.Mesh();
  try {
    const input = new draco.DecoderBuffer();
    input.Init(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes.byteLength);
    const status = decoder.DecodeBufferToMesh(input, mesh);
    draco.destroy(input);
    if (!status.ok() || mesh.ptr === 0) throw new Error(`Decoding failed: ${status.error_msg()}`);

    const numIndices = mesh.num_faces() * 3;
    const indexPtr = draco._malloc(numIndices * 4);
    decoder.GetTrianglesUInt32Array(mesh, numIndices * 4, indexPtr);
    const index = new Uint32Array(draco.HEAPF32.buffer, indexPtr, numIndices).slice();
    draco._free(indexPtr);

    const attributes: Record<string, ArrayBufferView & ArrayLike<number>> = {};
    for (const [semantic, { id, type }] of Object.entries(request.attributes)) {
      const attribute = decoder.GetAttributeByUniqueId(mesh, id);
      const Ctor = CTOR[type];
      const numValues = mesh.num_points() * attribute.num_components();
      const byteLength = numValues * Ctor.BYTES_PER_ELEMENT;
      const ptr = draco._malloc(byteLength);
      decoder.GetAttributeDataArrayForAllPoints(
        mesh,
        attribute,
        dataTypeOf(draco, type),
        byteLength,
        ptr,
      );
      attributes[semantic] = new Ctor(draco.HEAPF32.buffer, ptr, numValues).slice();
      draco._free(ptr);
    }
    return { index, attributes };
  } finally {
    draco.destroy(mesh);
    draco.destroy(decoder);
  }
};
