// #221 — producer-side repair for a malformed-binding glTF, applied at the ingest
// seam (the same one-point-before-both-readers place spec/gloss converts, V53).
//
// Some exporters (notably 3D rippers like 3dripper) emit a mesh primitive with NO
// `material` while the file still DEFINES a material that no primitive references
// (orphaned). Per glTF 2.0 §3.7.2.1 an unbound primitive renders with the DEFAULT
// material — flat white, no maps — so the model imports untextured even though its
// texture + material are right there in the file, just never wired to the geometry.
//
// The unambiguous case — exactly ONE orphaned material + one-or-more unbound
// primitives — is almost certainly that export bug, so we bind the unbound
// primitives to the orphan. Ambiguous cases (more than one orphan, or no orphan at
// all) are left verbatim: we render the spec-compliant default material rather than
// guess which orphan belongs to which primitive.

import type { GltfDoc } from './specGlossToMetalRough';
import { parseGlb, repackGlb } from './glb';

/** One applied rebind, for the no-silent-drop notice (V38). */
export interface OrphanRebind {
  materialIndex: number;
  materialName?: string;
  /** How many unbound primitives were bound to this material. */
  primitiveCount: number;
}

interface RebindPrimitive {
  material?: number;
  [k: string]: unknown;
}
interface RebindMesh {
  primitives?: RebindPrimitive[];
  [k: string]: unknown;
}

/**
 * Bind unbound mesh primitives to the document's single orphaned material, when
 * (and only when) that mapping is unambiguous. Pure — clones the document and
 * never mutates the input (mirrors `convertSpecGlossDocument`). Returns the
 * (possibly repaired) doc + a rebind log; an empty log means "left verbatim".
 */
export function rebindOrphanMaterials(input: GltfDoc): { doc: GltfDoc; rebinds: OrphanRebind[] } {
  const materials = input.materials;
  const meshes = input.meshes as RebindMesh[] | undefined;
  if (!Array.isArray(materials) || materials.length === 0 || !Array.isArray(meshes)) {
    return { doc: input, rebinds: [] };
  }
  // Which material indices does any primitive reference? Which primitives are unbound?
  const referenced = new Set<number>();
  let unboundCount = 0;
  for (const mesh of meshes) {
    for (const prim of mesh.primitives ?? []) {
      if (typeof prim.material === 'number') referenced.add(prim.material);
      else unboundCount++;
    }
  }
  if (unboundCount === 0) return { doc: input, rebinds: [] };
  // Orphaned materials: defined but referenced by no primitive.
  const orphans: number[] = [];
  for (let i = 0; i < materials.length; i++) if (!referenced.has(i)) orphans.push(i);
  // Only the unambiguous case — exactly one orphan to bind the unbound primitives to.
  if (orphans.length !== 1) return { doc: input, rebinds: [] };

  const idx = orphans[0];
  const doc = structuredClone(input) as GltfDoc;
  for (const mesh of (doc.meshes as RebindMesh[]) ?? []) {
    for (const prim of mesh.primitives ?? []) {
      if (typeof prim.material !== 'number') prim.material = idx;
    }
  }
  return {
    doc,
    rebinds: [
      { materialIndex: idx, materialName: materials[idx]?.name, primitiveCount: unboundCount },
    ],
  };
}

export interface RebindEntryResult {
  /** The (possibly repaired) entry bytes — verbatim when nothing was rebound. */
  entryBytes: Uint8Array;
  rebinds: OrphanRebind[];
}

/**
 * Apply {@link rebindOrphanMaterials} to an ingest entry's bytes, dispatching on
 * the container: `.gltf` rewrites the JSON; `.glb` parses + repacks (BIN chunk
 * untouched — rebinding only changes integer `primitive.material` indices). A
 * no-op (bytes returned verbatim, `rebinds: []`) when the bytes aren't a valid
 * container, the extension is unknown, or there's nothing to rebind. Pure (no
 * DOM) — fully unit-testable.
 */
export function rebindOrphanMaterialsInEntry(
  relativePath: string,
  bytes: Uint8Array,
): RebindEntryResult {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith('.glb')) {
    let json: unknown;
    let bin: Uint8Array;
    try {
      // parseGlb wants a standalone ArrayBuffer; copy so an offset-backed view
      // can't trip the DataView reads (same discipline as convertSpecGlossGlb).
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const parsed = parseGlb(copy.buffer);
      json = parsed.json;
      bin = parsed.bin;
    } catch {
      return { entryBytes: bytes, rebinds: [] };
    }
    if (json === null || typeof json !== 'object') return { entryBytes: bytes, rebinds: [] };
    const { doc, rebinds } = rebindOrphanMaterials(json as GltfDoc);
    if (rebinds.length === 0) return { entryBytes: bytes, rebinds: [] };
    return { entryBytes: repackGlb({ json: doc, bin }), rebinds };
  }
  if (lower.endsWith('.gltf')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    } catch {
      return { entryBytes: bytes, rebinds: [] };
    }
    if (parsed === null || typeof parsed !== 'object') return { entryBytes: bytes, rebinds: [] };
    const { doc, rebinds } = rebindOrphanMaterials(parsed as GltfDoc);
    if (rebinds.length === 0) return { entryBytes: bytes, rebinds: [] };
    return { entryBytes: new TextEncoder().encode(JSON.stringify(doc)), rebinds };
  }
  return { entryBytes: bytes, rebinds: [] };
}
