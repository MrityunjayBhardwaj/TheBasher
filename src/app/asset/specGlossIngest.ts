// specGlossIngest — the app-layer orchestrator for spec/gloss → metal-rough
// conversion at ingest (#214, V53). Wraps the pure core converter
// (specGlossToMetalRough.ts) with the BROWSER parts it can't do: decoding +
// re-encoding image bytes for the combined `specularGlossinessTexture` per-pixel
// pass (createImageBitmap + OffscreenCanvas — unavailable in pure core / node).
//
// WHY here (V8): the factor + diffuseTexture remap is pure JSON (core); only the
// COMBINED-texture pixel conversion needs canvas IO, which is app-layer. This
// module is the single seam ingestGltfFolder calls: parse the entry `.gltf` →
// factor-convert (core) → bake an MR texture per combined-texture material →
// re-serialize. Both OPFS readers (render's GLTFLoader, capture's
// buildGltfImportOps) then see one converted source (render == capture, V37/H40).
//
// THE BAKED MR TEXTURE rides as a NEW glTF SIBLING (a normal image/texture entry
// in the rewritten JSON + a PNG file written next to the `.gltf`), NOT the
// hash-keyed baked-texture store — so render loads it via the ordinary sibling
// resolver, capture records it as an ordinary imported-texture descriptor, and
// it round-trips through the `.basher` bundle's whole-`user-imports/<folder>`
// embed for free (no H77/H98 dual-key concern). The MR texture is LINEAR data →
// PNG (lossless), never JPEG.
//
// GRACEFUL DEGRADATION (V38): if a combined material's image can't be decoded
// (compressed KTX2, a bufferView image with no uri, a missing sibling), the pass
// SKIPS that material's MR texture and leaves the factor-only conversion
// (already in the doc) — the import stays faithful, just without the MR detail
// map. It never throws the whole import.
//
// REF: #214; src/core/import/specGlossToMetalRough.ts (the pure core);
//      src/app/asset/opfsGltfResolver.ts (opfsSiblingPath — sibling resolution);
//      src/app/sceneBundle.ts (the whole-folder embed the new sibling rides).

import {
  hasSpecGlossMaterials,
  convertSpecGlossDocument,
  specGlossPixelsToMetalRough,
  type GltfDoc,
  type CombinedTextureMaterial,
} from '../../core/import/specGlossToMetalRough';
import { opfsSiblingPath } from './opfsGltfResolver';
import type { IngestFile } from './importCommon';

export interface SpecGlossIngestResult {
  /** The converted entry `.gltf` bytes (verbatim input when not converted). */
  entryBytes: Uint8Array;
  /** True iff the entry carried spec/gloss and was rewritten. */
  converted: boolean;
  /** New sibling files to write alongside the entry (baked MR textures). */
  extraFiles: { relativePath: string; bytes: Uint8Array }[];
}

const NOT_CONVERTED = (entry: IngestFile): SpecGlossIngestResult => ({
  entryBytes: entry.bytes,
  converted: false,
  extraFiles: [],
});

/** Decoded raw RGBA pixels of an image. */
interface DecodedImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Decode image bytes → RGBA pixels, optionally resampled to (w,h) via canvas
 *  drawImage (the free bilinear resample). Returns null when the environment has
 *  no canvas (defensive — the caller degrades to factor-only). */
async function decodeImageToRgba(
  bytes: Uint8Array,
  mime: string,
  resampleTo?: { width: number; height: number },
): Promise<DecodedImage | null> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    return null;
  }
  // Detach a fresh ArrayBuffer-backed copy (Uint8Array.buffer is ArrayBufferLike,
  // which may be a SharedArrayBuffer; Blob wants a plain BlobPart) — the same
  // copy discipline AssetDropZone/importGltf use at the OPFS read seam.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const bitmap = await createImageBitmap(new Blob([copy], { type: mime }));
  const width = resampleTo?.width ?? bitmap.width;
  const height = resampleTo?.height ?? bitmap.height;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return null;
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const img = ctx.getImageData(0, 0, width, height);
  return { data: img.data, width, height };
}

/** Encode RGBA pixels → PNG bytes (lossless — the MR texture is linear data). */
async function encodeRgbaToPng(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('specGlossIngest: no 2d context to encode MR texture');
  // Copy into an ArrayBuffer-backed view (ImageData wants Uint8ClampedArray<
  // ArrayBuffer>, not the param's generic ArrayBufferLike).
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

/** MIME type from a glTF image entry / URI extension (for createImageBitmap). */
function imageMime(uri: string | undefined, declared: string | undefined): string {
  if (declared) return declared;
  const lower = (uri ?? '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

/** Resolve a glTF texture index → its source image bytes + mime. data: URIs are
 *  decoded inline; external URIs are looked up in the ingest file set via the
 *  SAME sibling resolution the renderer uses. null when unresolvable. */
function resolveTextureBytes(
  doc: GltfDoc,
  textureIndex: number,
  entryPath: string,
  fileMap: Map<string, Uint8Array>,
): { bytes: Uint8Array; mime: string } | null {
  const tex = doc.textures?.[textureIndex];
  if (!tex || typeof tex.source !== 'number') return null;
  const img = doc.images?.[tex.source];
  const uri = img?.uri;
  if (typeof uri !== 'string') return null; // bufferView image (.glb path) — not handled
  if (uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    if (comma < 0) return null;
    const raw = atob(uri.slice(comma + 1));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return { bytes, mime: imageMime(uri, img?.mimeType) };
  }
  const bytes = fileMap.get(opfsSiblingPath(entryPath, uri));
  if (!bytes) return null;
  return { bytes, mime: imageMime(uri, img?.mimeType) };
}

/**
 * Bake a metallic-roughness texture for one combined-texture material and wire
 * it into the document. Returns the new sibling file to write, or null when the
 * source image can't be decoded (the material keeps its factor-only conversion).
 */
async function bakeCombinedTexture(
  doc: GltfDoc,
  mat: CombinedTextureMaterial,
  entryPath: string,
  fileMap: Map<string, Uint8Array>,
): Promise<{ relativePath: string; bytes: Uint8Array } | null> {
  const specSource = resolveTextureBytes(doc, mat.specGlossTextureIndex, entryPath, fileMap);
  if (!specSource) return null;
  const spec = await decodeImageToRgba(specSource.bytes, specSource.mime);
  if (!spec) return null;

  // Resample the diffuse texture (if any) to the spec map's dimensions so the
  // per-texel metallic solve reads aligned pixels; else use diffuseFactor.
  let diffuse: Uint8ClampedArray | null = null;
  if (typeof mat.diffuseTextureIndex === 'number') {
    const diffSource = resolveTextureBytes(doc, mat.diffuseTextureIndex, entryPath, fileMap);
    if (diffSource) {
      const decoded = await decodeImageToRgba(diffSource.bytes, diffSource.mime, {
        width: spec.width,
        height: spec.height,
      });
      diffuse = decoded?.data ?? null;
    }
  }

  // JPEG carries no alpha → glossiness comes from the factor; PNG/webp carry the
  // glossiness in alpha (the spec/gloss convention).
  const glossFromAlpha = specSource.mime !== 'image/jpeg';
  const mr = specGlossPixelsToMetalRough(
    spec.data,
    diffuse,
    [mat.diffuseFactor[0], mat.diffuseFactor[1], mat.diffuseFactor[2]],
    mat.glossinessFactor,
    glossFromAlpha,
  );
  const pngBytes = await encodeRgbaToPng(mr, spec.width, spec.height);

  // Append a NEW image + texture for the baked MR map. Reuse the spec texture's
  // sampler (same wrap/filter as the source map). URI relative to the .gltf dir.
  const uri = `basher-mr-${mat.materialIndex}.png`;
  doc.images = doc.images ?? [];
  doc.textures = doc.textures ?? [];
  doc.images.push({ uri, mimeType: 'image/png' });
  const newImageIndex = doc.images.length - 1;
  const specTexture = doc.textures[mat.specGlossTextureIndex];
  doc.textures.push({
    source: newImageIndex,
    ...(typeof specTexture?.sampler === 'number' ? { sampler: specTexture.sampler } : {}),
  });
  const newTextureIndex = doc.textures.length - 1;

  // Point the material's metallicRoughnessTexture at the baked map. The full
  // value lives in the texture now, so the factors become 1× (metal-rough
  // multiplies factor × texture); leave roughnessFactor 1 too.
  const pbr = (doc.materials![mat.materialIndex].pbrMetallicRoughness ??= {});
  pbr.metallicRoughnessTexture = { index: newTextureIndex };
  pbr.metallicFactor = 1;
  pbr.roughnessFactor = 1;

  return { relativePath: opfsSiblingPath(entryPath, uri), bytes: pngBytes };
}

/**
 * Convert a `.gltf` ingest entry's spec/gloss materials → metal-rough, baking an
 * MR texture for each combined `specularGlossinessTexture` material. A no-op
 * (returns the entry bytes verbatim, converted:false) when the entry isn't valid
 * JSON or carries no spec/gloss. `.glb` is NOT handled here (binary re-pack
 * deferred — the caller gates on the `.gltf` extension).
 */
export async function convertSpecGlossGltfFiles(
  entry: IngestFile,
  files: readonly IngestFile[],
): Promise<SpecGlossIngestResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8').decode(entry.bytes));
  } catch {
    return NOT_CONVERTED(entry);
  }
  if (parsed === null || typeof parsed !== 'object' || !hasSpecGlossMaterials(parsed as GltfDoc)) {
    return NOT_CONVERTED(entry);
  }

  const { doc, combinedTextureMaterials } = convertSpecGlossDocument(parsed as GltfDoc);

  const extraFiles: { relativePath: string; bytes: Uint8Array }[] = [];
  if (combinedTextureMaterials.length > 0) {
    const fileMap = new Map(files.map((f) => [f.relativePath, f.bytes] as const));
    for (const mat of combinedTextureMaterials) {
      try {
        const baked = await bakeCombinedTexture(doc, mat, entry.relativePath, fileMap);
        if (baked) extraFiles.push(baked);
      } catch {
        // Degrade to the factor-only conversion already in `doc` (V38). The
        // import stays faithful; only the MR detail map for this material drops.
      }
    }
  }

  return {
    entryBytes: new TextEncoder().encode(JSON.stringify(doc)),
    converted: true,
    extraFiles,
  };
}
