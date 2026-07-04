// specGlossToMetalRough — convert a glTF KHR_materials_pbrSpecularGlossiness
// document into a standard metallic-roughness document, AT INGEST (issue #214,
// V53 "REAL-WORLD FINDING — SPEC/GLOSS").
//
// WHY this exists (the real-world finding): three.js REMOVED the spec-gloss
// GLTFLoader plugin at ~r150 (we're on r169) — so on a spec-gloss model the
// render clone gets a default WHITE MeshStandardMaterial and the diffuse
// textures never load; AND `gltfJsonMaterialToOpenpbr` reads only
// `pbrMetallicRoughness` (absent on these materials — their data lives in
// `extensions.KHR_materials_pbrSpecularGlossiness`) → the captured IR is all
// default too. A real model (gas_station: 74/74 spec-gloss) imports flat gray.
//
// WHERE it runs (the single source of truth): render (GLTFLoader via `useGLTF`)
// and capture (`buildGltfImportOps`) BOTH independently re-parse the SAME OPFS
// bytes. So converting the JSON ONCE at ingest — before the bytes are written to
// OPFS (`ingestGltfFolder`) — is the only point that sits before BOTH readers.
// Both then read normal metal-rough → render == capture for free (V37/H40). A
// loader-plugin would fix render only and force a second converter for capture
// (two sources of truth — rejected).
//
// THE MAPPING (the full Khronos / glTF-Transform approximation — preserves the
// metal materials, not the naive metallic=0 flatten):
//   diffuseFactor.rgb            → baseColorFactor.rgb (via solveMetallic lerp)
//   diffuseFactor.a              → baseColorFactor.a (opacity)
//   diffuseTexture               → baseColorTexture (same sRGB color texture)
//   specularFactor + glossiness  → metallicFactor / roughnessFactor
//   roughnessFactor              = 1 - glossinessFactor
//   strip KHR_materials_pbrSpecularGlossiness from the material + extensionsUsed
//     / extensionsRequired (else GLTFLoader rejects the required extension)
// The combined `specularGlossinessTexture` (spec in RGB, gloss in A) needs a
// per-pixel canvas conversion → a separate slice (increment 2); this module
// FLAGS those materials (`combinedTextureMaterials`) and converts their FACTORS
// + diffuseTexture now, leaving the MR map for the pixel pass.
//
// PURE + deterministic (V2/V22): no Date.now / Math.random / IO. Operates on the
// parsed JSON document object, returns a NEW document (structuredClone) — the
// caller (specGlossIngest) re-serializes the converted entry bytes before the
// OPFS write. CONTAINER-AGNOSTIC: this same conversion runs for the JSON `.gltf`
// container AND, since #216, the binary `.glb` container (parsed via parseGlb,
// re-serialized via repackGlb) — the document shape is identical post-parse.
//
// REF: #214; .anvi/vyapti.md V53; src/core/import/gltfJsonMaterialToOpenpbr.ts
//      (the capture path that reads the converted pbrMetallicRoughness);
//      src/app/asset/importGltf.ts (the ingest wiring).

/** The glTF extension key for spec/gloss materials. */
export const SPEC_GLOSS_EXTENSION = 'KHR_materials_pbrSpecularGlossiness';

/** glTF dielectric base reflectance (F0 = 0.04) — the metal-rough constant the
 *  Khronos spec-gloss→metal-rough conversion solves against. */
const DIELECTRIC_SPECULAR = 0.04;

/** Guard against divide-by-zero in the base-color reconstruction. */
const EPSILON = 1e-6;

/** A glTF textureInfo reference (`{ index, texCoord, extensions }`). Carried
 *  verbatim so a diffuseTexture's texCoord + KHR_texture_transform survive the
 *  rename to baseColorTexture. */
interface TextureRef {
  index: number;
  texCoord?: number;
  extensions?: Record<string, unknown>;
}

/** The KHR_materials_pbrSpecularGlossiness payload (glTF spec defaults applied
 *  when a field is absent). */
interface SpecGlossExtension {
  diffuseFactor?: number[];
  diffuseTexture?: TextureRef;
  specularFactor?: number[];
  glossinessFactor?: number;
  specularGlossinessTexture?: TextureRef;
}

/** A glTF material document object (the fields this converter reads/writes;
 *  everything else passes through structuredClone untouched). */
export interface GltfDocMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    metallicFactor?: number;
    roughnessFactor?: number;
    baseColorTexture?: TextureRef;
    metallicRoughnessTexture?: TextureRef;
  };
  extensions?: Record<string, unknown>;
  [k: string]: unknown;
}

/** A glTF image / texture / sampler entry (the fields the combined-texture pixel
 *  pass appends when it bakes a new metallic-roughness texture). */
export interface GltfImage {
  uri?: string;
  mimeType?: string;
  [k: string]: unknown;
}
export interface GltfTexture {
  source?: number;
  sampler?: number;
  [k: string]: unknown;
}
export interface GltfSampler {
  wrapS?: number;
  wrapT?: number;
  [k: string]: unknown;
}

/** A glTF document object (the top-level fields this converter touches). */
export interface GltfDoc {
  materials?: GltfDocMaterial[];
  images?: GltfImage[];
  textures?: GltfTexture[];
  samplers?: GltfSampler[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  [k: string]: unknown;
}

/** True iff the document declares spec/gloss anywhere (extension list OR a
 *  material extension) — the ingest gate + idempotency guard (a re-ingest of an
 *  already-converted file has no spec-gloss → no-op). */
export function hasSpecGlossMaterials(doc: GltfDoc): boolean {
  if ((doc.extensionsUsed ?? []).includes(SPEC_GLOSS_EXTENSION)) return true;
  return (doc.materials ?? []).some((m) => m.extensions?.[SPEC_GLOSS_EXTENSION] !== undefined);
}

/** Khronos perceived-brightness luminance (the weighting the spec-gloss→
 *  metal-rough reference uses to collapse an RGB triple to a scalar). */
function perceivedBrightness(c: readonly number[]): number {
  const [r = 0, g = 0, b = 0] = c;
  return Math.sqrt(0.299 * r * r + 0.587 * g * g + 0.114 * b * b);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Solve for the metallic value that best reproduces a (diffuse, specular) pair
 * under the metal-rough dielectric-F0=0.04 model — the Khronos quadratic
 * (gltf-pipeline / glTF-Transform `metalRough`). Inputs are perceived-brightness
 * scalars. specular below the dielectric floor ⇒ fully dielectric (metallic 0).
 */
export function solveMetallic(
  diffuse: number,
  specular: number,
  oneMinusSpecularStrength: number,
): number {
  if (specular < DIELECTRIC_SPECULAR) return 0;
  const a = DIELECTRIC_SPECULAR;
  const b =
    (diffuse * oneMinusSpecularStrength) / (1 - DIELECTRIC_SPECULAR) +
    specular -
    2 * DIELECTRIC_SPECULAR;
  const c = DIELECTRIC_SPECULAR - specular;
  const discriminant = Math.max(b * b - 4 * a * c, 0);
  return clamp01((-b + Math.sqrt(discriminant)) / (2 * a));
}

/** The metal-rough values a spec/gloss (diffuse, specular, glossiness) triple
 *  reduces to — the shared core consumed by BOTH the factor path and the
 *  per-texel texture path, so they cannot diverge (one Khronos formula). */
export interface MetalRoughValue {
  baseColor: [number, number, number];
  metallic: number;
  roughness: number;
}

/**
 * The ONE Khronos spec/gloss → metal-rough conversion (the per-component core).
 * All RGB inputs are linear 0..1; glossiness 0..1. Reconstructs base color from
 * BOTH the diffuse and the specular reflectance, lerped by metallic² so a metal
 * (high coloured specular) keeps its tint while a dielectric keeps its albedo.
 * roughness = 1 - glossiness. Used for the material factors AND for each texel
 * of a combined specularGlossinessTexture.
 */
export function specGlossToMetalRough(
  diffuse: readonly [number, number, number],
  specular: readonly [number, number, number],
  glossiness: number,
): MetalRoughValue {
  const specularStrength = Math.max(specular[0], specular[1], specular[2]);
  const oneMinusSpecularStrength = 1 - specularStrength;
  const metallic = solveMetallic(
    perceivedBrightness(diffuse),
    perceivedBrightness(specular),
    oneMinusSpecularStrength,
  );

  const baseColor: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const fromDiffuse =
      (diffuse[i] * oneMinusSpecularStrength) /
      (1 - DIELECTRIC_SPECULAR) /
      Math.max(1 - metallic, EPSILON);
    const fromSpecular =
      (specular[i] - DIELECTRIC_SPECULAR * (1 - metallic)) / Math.max(metallic, EPSILON);
    const t = metallic * metallic;
    baseColor[i] = clamp01(fromDiffuse * (1 - t) + fromSpecular * t);
  }

  return { baseColor, metallic, roughness: clamp01(1 - glossiness) };
}

/** The metal-rough factors a spec/gloss material's FACTORS reduce to (the
 *  texture-independent part — exported for the boundary-pair test). */
export interface MetalRoughFactors {
  baseColorFactor: [number, number, number, number];
  metallicFactor: number;
  roughnessFactor: number;
}

/**
 * Convert spec/gloss FACTORS → metal-rough factors (delegates to the shared
 * `specGlossToMetalRough` core + carries diffuse alpha through as opacity).
 */
export function specGlossFactorsToMetalRough(
  diffuseFactor: readonly number[] = [1, 1, 1, 1],
  specularFactor: readonly number[] = [1, 1, 1],
  glossinessFactor = 1,
): MetalRoughFactors {
  const diffuse: [number, number, number] = [
    diffuseFactor[0] ?? 1,
    diffuseFactor[1] ?? 1,
    diffuseFactor[2] ?? 1,
  ];
  const opacity = diffuseFactor[3] ?? 1;
  const specular: [number, number, number] = [
    specularFactor[0] ?? 1,
    specularFactor[1] ?? 1,
    specularFactor[2] ?? 1,
  ];
  const { baseColor, metallic, roughness } = specGlossToMetalRough(
    diffuse,
    specular,
    glossinessFactor,
  );
  return {
    baseColorFactor: [baseColor[0], baseColor[1], baseColor[2], opacity],
    metallicFactor: metallic,
    roughnessFactor: roughness,
  };
}

/**
 * Convert a combined specularGlossinessTexture (+ optional resampled diffuse) to
 * a metallic-roughness texture, per texel. RGBA inputs are 0..255 (sRGB-decoded
 * is unnecessary — perceived-brightness on raw 0..1 is the Khronos convention).
 *
 *   spec:    RGBA of the specularGlossinessTexture (RGB = specular, A = gloss)
 *   diffuse: RGBA diffuse texture resampled to the SAME dimensions, or null →
 *            use `diffuseFactor` for every texel (the common case: a material
 *            with a spec/gloss map but only a diffuse FACTOR).
 *   glossFromAlpha: true when the spec/gloss image carries an alpha channel
 *            (PNG); false (e.g. JPEG) → glossiness is the constant `glossiness`.
 *
 * Output RGBA is the glTF metallicRoughnessTexture convention: R = AO (unused,
 * left 255/white), G = roughness, B = metalness, A = 255. The texture is LINEAR
 * data (the caller must encode it losslessly — PNG, never JPEG — and mark it
 * NoColorSpace; GLTFLoader already treats metallicRoughnessTexture as linear).
 */
export function specGlossPixelsToMetalRough(
  spec: Uint8ClampedArray,
  diffuse: Uint8ClampedArray | null,
  diffuseFactor: readonly [number, number, number],
  glossiness: number,
  glossFromAlpha: boolean,
): Uint8ClampedArray {
  return specGlossPixelsToMetalRoughAndBase(
    spec,
    diffuse,
    diffuseFactor,
    glossiness,
    glossFromAlpha,
  ).mr;
}

/** The per-texel bake outputs: the metallic-roughness map, the reconstructed
 *  base-color map, and the peak metallic across all texels (the caller bakes the
 *  base map only when this exceeds a threshold — a fully-dielectric material keeps
 *  its original diffuse texture). */
export interface MetalRoughBaseBake {
  /** metallicRoughnessTexture RGBA (R=AO white, G=roughness, B=metalness) — LINEAR. */
  mr: Uint8ClampedArray;
  /** baseColorTexture RGBA (the reconstructed albedo, A=255) — sRGB color data, in
   *  the SAME raw working space as the diffuse input (the Khronos approximation). */
  base: Uint8ClampedArray;
  /** Peak metallic 0..1 across all texels — drives the "is this a metal?" gate. */
  maxMetallic: number;
}

/**
 * The full combined-texture bake: metallic-roughness AND the reconstructed
 * base-color, per texel, sharing the ONE `specGlossToMetalRough` core (so the MR
 * map and the base map can't diverge). For a coloured-specular METAL the base
 * color comes from the SPECULAR channel (the metal's tint), which the diffuse
 * texture does not carry — this is what `specGlossPixelsToMetalRough` discards.
 * Reports `maxMetallic` so the caller skips the base bake for a dielectric (whose
 * base ≈ diffuse — re-baking would only re-encode + add a texture for no gain).
 */
export function specGlossPixelsToMetalRoughAndBase(
  spec: Uint8ClampedArray,
  diffuse: Uint8ClampedArray | null,
  diffuseFactor: readonly [number, number, number],
  glossiness: number,
  glossFromAlpha: boolean,
): MetalRoughBaseBake {
  const n = spec.length; // 4 per texel (RGBA)
  const mr = new Uint8ClampedArray(n);
  const base = new Uint8ClampedArray(n);
  let maxMetallic = 0;
  for (let i = 0; i < n; i += 4) {
    const specRgb: [number, number, number] = [spec[i] / 255, spec[i + 1] / 255, spec[i + 2] / 255];
    const gloss = glossFromAlpha ? spec[i + 3] / 255 : glossiness;
    const diffRgb: [number, number, number] = diffuse
      ? [diffuse[i] / 255, diffuse[i + 1] / 255, diffuse[i + 2] / 255]
      : [diffuseFactor[0], diffuseFactor[1], diffuseFactor[2]];
    const { baseColor, metallic, roughness } = specGlossToMetalRough(diffRgb, specRgb, gloss);
    mr[i] = 255; // R: AO unused (white)
    mr[i + 1] = Math.round(roughness * 255); // G: roughness
    mr[i + 2] = Math.round(metallic * 255); // B: metalness
    mr[i + 3] = 255; // A
    base[i] = Math.round(baseColor[0] * 255);
    base[i + 1] = Math.round(baseColor[1] * 255);
    base[i + 2] = Math.round(baseColor[2] * 255);
    base[i + 3] = 255;
    if (metallic > maxMetallic) maxMetallic = metallic;
  }
  return { mr, base, maxMetallic };
}

/** Strip a value from a string list; returns undefined when the list empties
 *  (so an `extensionsRequired` that held only spec-gloss is removed entirely). */
function withoutExtension(list: string[] | undefined, ext: string): string[] | undefined {
  if (!list) return list;
  const next = list.filter((e) => e !== ext);
  return next.length > 0 ? next : undefined;
}

/** A spec/gloss material that carried a combined `specularGlossinessTexture` —
 *  everything the per-pixel pass (increment 2, app layer) needs to bake a
 *  metallic-roughness texture. Captured BEFORE the extension is stripped from
 *  the document; the factors + diffuseTexture are already converted in `doc`. */
export interface CombinedTextureMaterial {
  /** Index into `doc.materials`. */
  materialIndex: number;
  /** glTF texture index of the combined specularGlossinessTexture (RGB = spec,
   *  A = gloss). */
  specGlossTextureIndex: number;
  /** glTF texture index of the diffuse texture, if any (resampled per-texel for
   *  the metallic solve; absent → use `diffuseFactor`). */
  diffuseTextureIndex?: number;
  diffuseFactor: [number, number, number, number];
  specularFactor: [number, number, number];
  glossinessFactor: number;
}

/** The result of a document conversion: the new document + the combined-texture
 *  materials whose MR map needs the per-pixel pass (their factors + diffuseTexture
 *  are already converted in `doc`). */
export interface SpecGlossConversionResult {
  doc: GltfDoc;
  combinedTextureMaterials: CombinedTextureMaterial[];
}

/**
 * Convert every spec/gloss material in a glTF document to metal-rough and strip
 * the extension from the document. Pure: returns a NEW document (structuredClone
 * of the input), never mutates the argument. Idempotent — a document with no
 * spec/gloss is returned cloned-but-unchanged. The combined-texture MR map is
 * NOT produced here (that needs pixel IO); those materials are flagged so the
 * ingest pixel pass can fill them.
 */
export function convertSpecGlossDocument(input: GltfDoc): SpecGlossConversionResult {
  const doc = structuredClone(input) as GltfDoc;
  const combinedTextureMaterials: CombinedTextureMaterial[] = [];

  const materials = doc.materials ?? [];
  for (let i = 0; i < materials.length; i++) {
    const mat = materials[i];
    const sg = mat.extensions?.[SPEC_GLOSS_EXTENSION] as SpecGlossExtension | undefined;
    if (!sg) continue;

    const factors = specGlossFactorsToMetalRough(
      sg.diffuseFactor,
      sg.specularFactor,
      sg.glossinessFactor,
    );

    const pbr: NonNullable<GltfDocMaterial['pbrMetallicRoughness']> = {
      ...(mat.pbrMetallicRoughness ?? {}),
      baseColorFactor: factors.baseColorFactor,
      metallicFactor: factors.metallicFactor,
      roughnessFactor: factors.roughnessFactor,
    };
    // diffuseTexture → baseColorTexture (both are sRGB color textures in
    // GLTFLoader; reuse the same texture index, preserving texCoord + any
    // KHR_texture_transform). The combined specularGlossinessTexture → the
    // metallicRoughnessTexture in a later pixel pass (flagged below).
    if (sg.diffuseTexture) {
      pbr.baseColorTexture = sg.diffuseTexture;
    }
    if (typeof sg.specularGlossinessTexture?.index === 'number') {
      combinedTextureMaterials.push({
        materialIndex: i,
        specGlossTextureIndex: sg.specularGlossinessTexture.index,
        ...(typeof sg.diffuseTexture?.index === 'number'
          ? { diffuseTextureIndex: sg.diffuseTexture.index }
          : {}),
        diffuseFactor: [
          sg.diffuseFactor?.[0] ?? 1,
          sg.diffuseFactor?.[1] ?? 1,
          sg.diffuseFactor?.[2] ?? 1,
          sg.diffuseFactor?.[3] ?? 1,
        ],
        specularFactor: [
          sg.specularFactor?.[0] ?? 1,
          sg.specularFactor?.[1] ?? 1,
          sg.specularFactor?.[2] ?? 1,
        ],
        glossinessFactor: sg.glossinessFactor ?? 1,
      });
    }
    mat.pbrMetallicRoughness = pbr;

    // Remove the spec/gloss extension from the material; drop the `extensions`
    // bag entirely once empty so the converted JSON is clean.
    if (mat.extensions) {
      delete mat.extensions[SPEC_GLOSS_EXTENSION];
      if (Object.keys(mat.extensions).length === 0) delete mat.extensions;
    }
  }

  // Strip the extension from the document-level lists (GLTFLoader rejects a
  // required extension it doesn't support).
  doc.extensionsUsed = withoutExtension(doc.extensionsUsed, SPEC_GLOSS_EXTENSION);
  if (doc.extensionsUsed === undefined) delete doc.extensionsUsed;
  doc.extensionsRequired = withoutExtension(doc.extensionsRequired, SPEC_GLOSS_EXTENSION);
  if (doc.extensionsRequired === undefined) delete doc.extensionsRequired;

  return { doc, combinedTextureMaterials };
}
