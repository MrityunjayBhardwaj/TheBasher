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
// GLB (#216): a `.glb` is self-contained (one binary file), so there is no
// sibling to write — the conversion runs `parseGlb` → `convertSpecGlossDocument`
// (the SAME pure factor + diffuseTexture conversion) → bakes each combined
// texture by reading its source image from the BIN bufferView (the realistic GLB
// case) → embeds the baked MR map as a `data:` URI image → `repackGlb` rewrites
// the container. Both OPFS readers then see metal-rough (render == capture). The
// `.gltf` and `.glb` paths share the decode→bake→encode math (`bakeMetalRoughPng`)
// and the JSON wiring (`wireBakedMrTexture`); only image RESOLUTION (sibling file
// vs BIN bufferView) and MR EMBEDDING (sibling PNG vs data URI) differ.
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
  specGlossPixelsToMetalRoughAndBase,
  type GltfDoc,
  type CombinedTextureMaterial,
} from '../../core/import/specGlossToMetalRough';
import { parseGlb, repackGlb } from '../../core/import/glb';
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

/** Raw image bytes + mime for one of a combined material's source textures. */
interface ImageSource {
  bytes: Uint8Array;
  mime: string;
}

/** Peak metallic above which the combined-texture material is treated as a metal
 *  and gets a baked base-color map (#218). Below it the material is dielectric →
 *  base ≈ diffuse, so the original diffuse texture is kept (no re-encode, no extra
 *  texture). 0.05 = 5% metallic, comfortably above solve noise for a dielectric. */
const METAL_BASE_BAKE_THRESHOLD = 0.05;

/** The encoded combined-texture maps: the metallic-roughness PNG (always) and,
 *  for a coloured-specular metal, the reconstructed base-color PNG (#218). */
interface BakedCombinedMaps {
  mrPng: Uint8Array;
  /** null for a dielectric (keep the diffuse texture as base color). */
  basePng: Uint8Array | null;
}

/**
 * The container-agnostic bake: decode the combined specularGlossinessTexture (+
 * the optional diffuse texture, resampled to its dimensions), run the per-texel
 * Khronos conversion, and encode the metallic-roughness PNG (always) plus — when
 * the material has metal content (#218) — the reconstructed base-color PNG.
 * Returns null when the spec image can't be decoded (the caller degrades to the
 * factor-only conversion, V38). Shared by the `.gltf` and `.glb` paths — only
 * how `specSource`/`diffuseSource` are RESOLVED differs (sibling file vs BIN
 * bufferView).
 */
async function bakeMetalRoughPng(
  specSource: ImageSource,
  diffuseSource: ImageSource | null,
  mat: CombinedTextureMaterial,
): Promise<BakedCombinedMaps | null> {
  const spec = await decodeImageToRgba(specSource.bytes, specSource.mime);
  if (!spec) return null;

  // Resample the diffuse texture (if any) to the spec map's dimensions so the
  // per-texel metallic solve reads aligned pixels; else use diffuseFactor.
  let diffuse: Uint8ClampedArray | null = null;
  if (diffuseSource) {
    const decoded = await decodeImageToRgba(diffuseSource.bytes, diffuseSource.mime, {
      width: spec.width,
      height: spec.height,
    });
    diffuse = decoded?.data ?? null;
  }

  // JPEG carries no alpha → glossiness comes from the factor; PNG/webp carry the
  // glossiness in alpha (the spec/gloss convention).
  const glossFromAlpha = specSource.mime !== 'image/jpeg';
  const { mr, base, maxMetallic } = specGlossPixelsToMetalRoughAndBase(
    spec.data,
    diffuse,
    [mat.diffuseFactor[0], mat.diffuseFactor[1], mat.diffuseFactor[2]],
    mat.glossinessFactor,
    glossFromAlpha,
  );
  const mrPng = await encodeRgbaToPng(mr, spec.width, spec.height);
  const basePng =
    maxMetallic > METAL_BASE_BAKE_THRESHOLD
      ? await encodeRgbaToPng(base, spec.width, spec.height)
      : null;
  return { mrPng, basePng };
}

/** Append an image + texture for a baked map (reusing the combined-texture's
 *  sampler) and return the new glTF texture index. `uri` is a sibling filename
 *  for `.gltf` or a `data:` URI for `.glb`. */
function pushBakedTexture(doc: GltfDoc, mat: CombinedTextureMaterial, uri: string): number {
  doc.images = doc.images ?? [];
  doc.textures = doc.textures ?? [];
  doc.images.push({ uri, mimeType: 'image/png' });
  const newImageIndex = doc.images.length - 1;
  const specTexture = doc.textures[mat.specGlossTextureIndex];
  doc.textures.push({
    source: newImageIndex,
    ...(typeof specTexture?.sampler === 'number' ? { sampler: specTexture.sampler } : {}),
  });
  return doc.textures.length - 1;
}

/**
 * Wire the baked combined-texture maps into the document: the metallicRoughnessTexture
 * (always; factors → 1× since the value now lives in the texture) and, for a
 * coloured-specular metal (#218), the reconstructed baseColorTexture (which
 * SUPERSEDES the diffuse→baseColorTexture rename and neutralises the RGB factor,
 * keeping alpha as opacity). Shared by both container paths.
 */
function wireBakedMrTexture(
  doc: GltfDoc,
  mat: CombinedTextureMaterial,
  mrUri: string,
  baseUri: string | null,
): void {
  const pbr = (doc.materials![mat.materialIndex].pbrMetallicRoughness ??= {});
  pbr.metallicRoughnessTexture = { index: pushBakedTexture(doc, mat, mrUri) };
  pbr.metallicFactor = 1;
  pbr.roughnessFactor = 1;
  if (baseUri) {
    pbr.baseColorTexture = { index: pushBakedTexture(doc, mat, baseUri) };
    const f = pbr.baseColorFactor;
    const alpha = Array.isArray(f) && typeof f[3] === 'number' ? f[3] : 1;
    pbr.baseColorFactor = [1, 1, 1, alpha];
  }
}

/**
 * Bake a metallic-roughness texture for one combined-texture material in a
 * `.gltf` folder and wire it into the document. Returns the new sibling file to
 * write, or null when the source image can't be decoded (the material keeps its
 * factor-only conversion).
 */
async function bakeCombinedTextureGltf(
  doc: GltfDoc,
  mat: CombinedTextureMaterial,
  entryPath: string,
  fileMap: Map<string, Uint8Array>,
): Promise<{ relativePath: string; bytes: Uint8Array }[]> {
  const specSource = resolveTextureBytes(doc, mat.specGlossTextureIndex, entryPath, fileMap);
  if (!specSource) return [];
  const diffuseSource =
    typeof mat.diffuseTextureIndex === 'number'
      ? resolveTextureBytes(doc, mat.diffuseTextureIndex, entryPath, fileMap)
      : null;

  const baked = await bakeMetalRoughPng(specSource, diffuseSource, mat);
  if (!baked) return [];

  // The baked maps ride as sibling files (relative to the .gltf dir). The base
  // map is present only for a coloured-specular metal (#218).
  const files: { relativePath: string; bytes: Uint8Array }[] = [];
  const mrUri = `basher-mr-${mat.materialIndex}.png`;
  files.push({ relativePath: opfsSiblingPath(entryPath, mrUri), bytes: baked.mrPng });
  let baseUri: string | null = null;
  if (baked.basePng) {
    baseUri = `basher-base-${mat.materialIndex}.png`;
    files.push({ relativePath: opfsSiblingPath(entryPath, baseUri), bytes: baked.basePng });
  }
  wireBakedMrTexture(doc, mat, mrUri, baseUri);
  return files;
}

/**
 * Convert a `.gltf` ingest entry's spec/gloss materials → metal-rough, baking an
 * MR texture for each combined `specularGlossinessTexture` material. A no-op
 * (returns the entry bytes verbatim, converted:false) when the entry isn't valid
 * JSON or carries no spec/gloss. The `.glb` case is handled by
 * `convertSpecGlossGlb`; `convertSpecGlossEntry` dispatches between them.
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
        const baked = await bakeCombinedTextureGltf(doc, mat, entry.relativePath, fileMap);
        extraFiles.push(...baked);
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

/** A glTF image / bufferView, narrowed to the fields the GLB combined-texture
 *  resolver reads from the parsed document (the rest passes through). */
interface GlbImageView {
  uri?: string;
  mimeType?: string;
  bufferView?: number;
}
interface GlbBufferViewView {
  buffer?: number;
  byteOffset?: number;
  byteLength: number;
}

/** Base64-encode bytes (chunked to avoid String.fromCharCode arg-count limits)
 *  for embedding a baked PNG as a `data:` URI image in the GLB JSON chunk. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Resolve a glTF texture index → its source image bytes + mime, for a GLB. The
 * image is either a `data:` URI (decoded inline) or — the realistic GLB case — a
 * `bufferView` slice of the embedded BIN chunk. Returns null when unresolvable
 * (the caller degrades to the factor-only conversion).
 */
function resolveGlbTextureBytes(
  doc: GltfDoc,
  textureIndex: number,
  bin: Uint8Array,
): ImageSource | null {
  const tex = doc.textures?.[textureIndex];
  if (!tex || typeof tex.source !== 'number') return null;
  const img = doc.images?.[tex.source] as GlbImageView | undefined;
  if (!img) return null;
  if (typeof img.uri === 'string') {
    if (!img.uri.startsWith('data:')) return null; // external sibling: GLB is self-contained
    const comma = img.uri.indexOf(',');
    if (comma < 0) return null;
    const raw = atob(img.uri.slice(comma + 1));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return { bytes, mime: imageMime(img.uri, img.mimeType) };
  }
  if (typeof img.bufferView !== 'number') return null;
  const bufferViews = (doc as { bufferViews?: GlbBufferViewView[] }).bufferViews;
  const bv = bufferViews?.[img.bufferView];
  if (!bv) return null;
  const start = bv.byteOffset ?? 0;
  const end = start + bv.byteLength;
  if (end > bin.byteLength) return null;
  // A bufferView image MUST declare its mimeType (glTF 2.0 §3.9.1 — there is no
  // URI extension to fall back on).
  return { bytes: bin.subarray(start, end), mime: imageMime(undefined, img.mimeType) };
}

/**
 * Convert a `.glb` ingest entry's spec/gloss materials → metal-rough by
 * repacking the binary container (#216). Parses the GLB, runs the SAME pure
 * factor + diffuseTexture conversion, bakes each combined `specularGlossinessTexture`
 * (reading its source image from the BIN bufferView) and embeds the result as a
 * `data:` URI image, then repacks. A no-op when the bytes aren't a valid GLB or
 * carry no spec/gloss. `.glb` is self-contained → no sibling `extraFiles`.
 */
export async function convertSpecGlossGlb(entry: IngestFile): Promise<SpecGlossIngestResult> {
  let json: unknown;
  let bin: Uint8Array;
  try {
    // parseGlb wants a standalone ArrayBuffer; copy into a fresh one so an
    // offset-backed / SharedArrayBuffer-backed view can't trip the DataView reads
    // (the same copy discipline decodeImageToRgba uses at the OPFS read seam).
    const copy = new Uint8Array(entry.bytes.byteLength);
    copy.set(entry.bytes);
    const parsed = parseGlb(copy.buffer);
    json = parsed.json;
    bin = parsed.bin;
  } catch {
    return NOT_CONVERTED(entry); // not a valid GLB (or truncated) — leave verbatim
  }
  if (json === null || typeof json !== 'object' || !hasSpecGlossMaterials(json as GltfDoc)) {
    return NOT_CONVERTED(entry);
  }

  const { doc, combinedTextureMaterials } = convertSpecGlossDocument(json as GltfDoc);

  for (const mat of combinedTextureMaterials) {
    try {
      const specSource = resolveGlbTextureBytes(doc, mat.specGlossTextureIndex, bin);
      if (!specSource) continue; // degrade to factor-only (V38)
      const diffuseSource =
        typeof mat.diffuseTextureIndex === 'number'
          ? resolveGlbTextureBytes(doc, mat.diffuseTextureIndex, bin)
          : null;
      const baked = await bakeMetalRoughPng(specSource, diffuseSource, mat);
      if (!baked) continue;
      const mrUri = `data:image/png;base64,${bytesToBase64(baked.mrPng)}`;
      const baseUri = baked.basePng
        ? `data:image/png;base64,${bytesToBase64(baked.basePng)}`
        : null;
      wireBakedMrTexture(doc, mat, mrUri, baseUri);
    } catch {
      // Degrade to the factor-only conversion already in `doc` (V38).
    }
  }

  // The baked MR images ride embedded in the JSON (data URIs); the BIN chunk is
  // unchanged, so it passes through repackGlb verbatim.
  return {
    entryBytes: repackGlb({ json: doc, bin }),
    converted: true,
    extraFiles: [],
  };
}

/**
 * Convert a spec/gloss ingest entry → metal-rough, dispatching on the container
 * extension: `.glb` → `convertSpecGlossGlb` (binary repack), `.gltf` →
 * `convertSpecGlossGltfFiles` (JSON rewrite + sibling MR textures). Any other
 * extension is a no-op. The single seam `ingestGltfFolder` calls.
 */
export async function convertSpecGlossEntry(
  entry: IngestFile,
  files: readonly IngestFile[],
): Promise<SpecGlossIngestResult> {
  const lower = entry.relativePath.toLowerCase();
  if (lower.endsWith('.glb')) return convertSpecGlossGlb(entry);
  if (lower.endsWith('.gltf')) return convertSpecGlossGltfFiles(entry, files);
  return NOT_CONVERTED(entry);
}
