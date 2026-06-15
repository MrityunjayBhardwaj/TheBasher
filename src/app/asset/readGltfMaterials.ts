// readGltfMaterials — a READ-ONLY projection of a mounted GltfAsset clone's
// materials, for the inspector (UX backlog #8).
//
// WHY THIS EXISTS
// ===============
// A glTF's embedded materials are baked onto the three.js clone GltfAssetR
// mounts; they are NOT extracted into the DAG (unlike a primitive's
// InlineMaterialSpec). So when a director selects a glTF asset or child, the
// inspector's MATERIAL section is EMPTY — they can't even SEE what materials the
// model has (observed: the two-material quad shows red+blue in the viewport but
// nothing in the inspector). This reads the materials off the rendered clone so
// the inspector can display them. EDITING still goes through the MaterialOverride
// wrapper — this is inspect-only (V33-style: a read-only projection extracted by
// ONE pure function, the same discipline as the UV layout read).
//
// WHAT IS READ
// ============
// One entry per render SLOT — the i-th `isMesh` in `clone.traverse`, the SAME
// order GltfAssetR's material-override effect counts slots (so a slot index here
// lines up with what an override addresses). Reads the POST-override material
// (what is actually drawn — Lokayata). Each slot is tagged with the nearest
// stamped ancestor's `basherGltfChildId` so the inspector can filter to a
// selected GltfChild.
//
// REF: UX-BACKLOG #8; src/viewport/SceneFromDAG.tsx (GltfAssetR slot order +
//      the stamp); src/app/asset/gltfMaterialStore.ts (the published store).

import type * as THREE from 'three';

export interface GltfMaterialSlot {
  /** Render slot index (i-th isMesh in clone.traverse — matches override slotIndex). */
  readonly slot: number;
  /** GltfChild DAG node id of the nearest stamped ancestor, or null if unstamped. */
  readonly childId: string | null;
  readonly meshName: string;
  readonly materialName: string;
  /** Base color as `#rrggbb`, or null if the material has no color. */
  readonly color: string | null;
  readonly metalness: number | null;
  readonly roughness: number | null;
  readonly opacity: number | null;
  /** Emissive color as `#rrggbb`, or null. */
  readonly emissive: string | null;
  /** Which texture map slots are bound (e.g. 'base color', 'normal', 'roughness'). */
  readonly maps: readonly string[];
}

const MAP_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['map', 'base color'],
  ['normalMap', 'normal'],
  ['roughnessMap', 'roughness'],
  ['metalnessMap', 'metalness'],
  ['emissiveMap', 'emissive'],
  ['aoMap', 'ambient occlusion'],
];

/** Nearest ancestor (including self) carrying a `basherGltfChildId` stamp.
 *  Exported so the renderer's DAG-material overlay (#178 S3) maps a clone mesh
 *  back to its GltfChild with the SAME rule this read-only projection uses. */
export function nearestChildId(o: THREE.Object3D): string | null {
  let cur: THREE.Object3D | null = o;
  while (cur) {
    const id = (cur.userData as { basherGltfChildId?: unknown }).basherGltfChildId;
    if (typeof id === 'string' && id) return id;
    cur = cur.parent;
  }
  return null;
}

function hex(c: { getHexString?: () => string } | undefined): string | null {
  return c && typeof c.getHexString === 'function' ? `#${c.getHexString()}` : null;
}

function summarizeMaterial(mat: THREE.Material, mesh: THREE.Mesh, slot: number): GltfMaterialSlot {
  const m = mat as THREE.MeshStandardMaterial; // duck-typed; fields read defensively
  const maps: string[] = [];
  for (const [prop, label] of MAP_LABELS) {
    if ((m as unknown as Record<string, unknown>)[prop]) maps.push(label);
  }
  return {
    slot,
    childId: nearestChildId(mesh),
    meshName: mesh.name || '(unnamed)',
    materialName: mat.name || '(unnamed material)',
    color: hex(m.color),
    metalness: typeof m.metalness === 'number' ? m.metalness : null,
    roughness: typeof m.roughness === 'number' ? m.roughness : null,
    opacity: typeof m.opacity === 'number' ? m.opacity : null,
    emissive: hex(m.emissive),
    maps,
  };
}

/** Walk the clone and summarize one slot per mesh material. A mesh with a
 *  material ARRAY (geometry groups) contributes one slot per element, in order. */
export function readGltfMaterials(root: THREE.Object3D): GltfMaterialSlot[] {
  const slots: GltfMaterialSlot[] = [];
  let slot = -1;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    slot += 1;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // One render slot per mesh (matching the override effect's slotIdx); when a
    // mesh carries multiple materials, summarize the first (the addressable one).
    slots.push(summarizeMaterial(mats[0], mesh, slot));
  });
  return slots;
}
