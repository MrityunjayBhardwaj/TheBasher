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
// caller (importGltf) re-serializes the converted entry bytes before the OPFS
// write. GLB (.glb) is deferred (needs a binary re-pack); this targets the
// JSON-only `.gltf` container.
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

/** A glTF document object (the top-level fields this converter touches). */
export interface GltfDoc {
  materials?: GltfDocMaterial[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  [k: string]: unknown;
}

/** True iff the document declares spec/gloss anywhere (extension list OR a
 *  material extension) — the ingest gate + idempotency guard (a re-ingest of an
 *  already-converted file has no spec-gloss → no-op). */
export function hasSpecGlossMaterials(doc: GltfDoc): boolean {
  if ((doc.extensionsUsed ?? []).includes(SPEC_GLOSS_EXTENSION)) return true;
  return (doc.materials ?? []).some(
    (m) => m.extensions?.[SPEC_GLOSS_EXTENSION] !== undefined,
  );
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

/** The metal-rough factors a spec/gloss material's FACTORS reduce to (the
 *  texture-independent part — exported for the boundary-pair test). */
export interface MetalRoughFactors {
  baseColorFactor: [number, number, number, number];
  metallicFactor: number;
  roughnessFactor: number;
}

/**
 * Convert spec/gloss FACTORS → metal-rough factors (the full Khronos
 * approximation). Reconstructs base color from BOTH the diffuse and the
 * specular reflectance, lerped by metallic² so a metal (high coloured specular)
 * keeps its tint while a dielectric keeps its albedo. roughness = 1 - glossiness.
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

  const specularStrength = Math.max(specular[0], specular[1], specular[2]);
  const oneMinusSpecularStrength = 1 - specularStrength;
  const metallic = solveMetallic(
    perceivedBrightness(diffuse),
    perceivedBrightness(specular),
    oneMinusSpecularStrength,
  );

  // Reconstruct base color from the diffuse side and the specular side, then
  // lerp by metallic² (the Khronos blend — biases toward albedo until clearly
  // metallic). Clamp each channel to [0,1].
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

  return {
    baseColorFactor: [baseColor[0], baseColor[1], baseColor[2], opacity],
    metallicFactor: metallic,
    roughnessFactor: clamp01(1 - glossinessFactor),
  };
}

/** Strip a value from a string list; returns undefined when the list empties
 *  (so an `extensionsRequired` that held only spec-gloss is removed entirely). */
function withoutExtension(list: string[] | undefined, ext: string): string[] | undefined {
  if (!list) return list;
  const next = list.filter((e) => e !== ext);
  return next.length > 0 ? next : undefined;
}

/** The result of a document conversion: the new document + the material indices
 *  that carried a combined `specularGlossinessTexture` (their MR map needs the
 *  per-pixel pass — increment 2; their factors + diffuseTexture are converted
 *  here). */
export interface SpecGlossConversionResult {
  doc: GltfDoc;
  /** Material indices whose spec/gloss used a combined specularGlossinessTexture. */
  combinedTextureMaterials: number[];
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
  const combinedTextureMaterials: number[] = [];

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
    if (sg.specularGlossinessTexture) {
      combinedTextureMaterials.push(i);
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

/** The bytes-level result of converting a `.gltf` entry file (the ingest seam). */
export interface SpecGlossBytesConversion {
  /** The converted JSON bytes when `converted`, else the input bytes verbatim. */
  bytes: Uint8Array;
  /** True iff the document carried spec/gloss and was rewritten. */
  converted: boolean;
  /** Material indices needing the combined-texture pixel pass (increment 2). */
  combinedTextureMaterials: number[];
}

/**
 * Parse a JSON-only `.gltf` entry's bytes, convert any spec/gloss materials to
 * metal-rough, and re-serialize. A no-op (returns the input bytes, converted:
 * false) when the bytes aren't valid JSON, aren't a glTF object, or carry no
 * spec/gloss — so it is safe to call on every `.gltf` entry at ingest. GLB
 * (`.glb`) is NOT handled here (it needs a binary re-pack — deferred, #214); the
 * caller gates on the `.gltf` extension.
 */
export function convertSpecGlossGltfBytes(bytes: Uint8Array): SpecGlossBytesConversion {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8').decode(bytes));
  } catch {
    return { bytes, converted: false, combinedTextureMaterials: [] };
  }
  if (doc === null || typeof doc !== 'object' || !hasSpecGlossMaterials(doc as GltfDoc)) {
    return { bytes, converted: false, combinedTextureMaterials: [] };
  }
  const { doc: out, combinedTextureMaterials } = convertSpecGlossDocument(doc as GltfDoc);
  return {
    bytes: new TextEncoder().encode(JSON.stringify(out)),
    converted: true,
    combinedTextureMaterials,
  };
}
