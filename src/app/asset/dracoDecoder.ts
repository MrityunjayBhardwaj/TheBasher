// #1063 — the product's Draco decoder for the native import: three's DRACOLoader worker at the
// self-hosted decoder path, called the way GLTFLoader's own Draco plugin calls it
// (`GLTFLoader.js`, `GLTFDracoMeshCompressionExtension.decodePrimitive`: `decodeDracoFile` with the
// glTF attribute ids, each attribute read in its accessor's component type, linear colour). The
// clone road decodes the same file with that same worker through drei, so both roads read one
// decoder's output.
//
// REF: src/core/import/gltfDraco.ts (the contract and the glTF side); src/viewport/
//      gltfLoaderConfig.ts (`DRACO_DECODER_PATH`); issue #1063.

import { LinearSRGBColorSpace, type BufferGeometry, type ColorSpace } from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import type { DecodeDraco, DracoArrayType } from '../../core/import/gltfDraco';
import { DRACO_DECODER_PATH } from '../../viewport/gltfLoaderConfig';

/** The call GLTFLoader makes; public in three's source, absent from `@types/three`. */
interface DracoFileDecoder {
  decodeDracoFile(
    buffer: ArrayBuffer,
    callback: (geometry: BufferGeometry) => void,
    attributeIDs: Record<string, number>,
    attributeTypes: Record<string, DracoArrayType>,
    vertexColorSpace: ColorSpace,
    onError: (err: unknown) => void,
  ): void;
}

let loader: DRACOLoader | null = null;

export const decodeDracoInBrowser: DecodeDraco = (bytes, request) => {
  loader ??= new DRACOLoader().setDecoderPath(DRACO_DECODER_PATH);
  const ids: Record<string, number> = {};
  const types: Record<string, DracoArrayType> = {};
  for (const [semantic, { id, type }] of Object.entries(request.attributes)) {
    ids[semantic] = id;
    types[semantic] = type;
  }
  // The worker takes ownership of the buffer it is handed, so it gets a copy of these bytes.
  const buffer = bytes.slice().buffer;
  return new Promise((resolve, reject) => {
    (loader as unknown as DracoFileDecoder).decodeDracoFile(
      buffer,
      (geometry) => {
        const attributes: Record<string, ArrayBufferView & ArrayLike<number>> = {};
        for (const semantic of Object.keys(ids)) {
          const attribute = geometry.getAttribute(semantic);
          if (attribute)
            attributes[semantic] = attribute.array as ArrayBufferView & ArrayLike<number>;
        }
        const index = geometry.getIndex();
        resolve({
          index: index ? Uint32Array.from(index.array as ArrayLike<number>) : null,
          attributes,
        });
        geometry.dispose();
      },
      ids,
      types,
      LinearSRGBColorSpace,
      reject,
    );
  });
};
