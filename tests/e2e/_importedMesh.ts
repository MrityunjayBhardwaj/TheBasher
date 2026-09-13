// The e2e tier's ONE answer to "what did the import produce, and what is drawn for it?" — on
// whichever road the file took (#1071).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────
//
// An import now has two possible shapes. A file the native model holds arrives as a `Group` over
// ordinary `Object`s over `PolyMeshData` (#1049, #1050); a file it refuses still arrives through the
// file's own copy, as `GltfAsset` + `Object`/`GltfData` pairs. The tier read imports through two
// things that only know the second shape — `_importedChild.ts` (it asks the product's
// `importedChildOf`, which recognises only the `GltfData` pair) and the DEV probe
// `__basher_gltf_meshes` (it walks only the glTF clone). When textured files went native, fourteen
// capture specs went red at once without the product being wrong: the lookup returned null and the
// probe returned an empty list.
//
// ── WHY ONE SCENE WALK SERVES BOTH ROADS ─────────────────────────────────────────────
//
// Whatever builds the meshes, what is DRAWN is three.js meshes under the import root, and the
// renderer names every top-level scene child's wrapping group with its producer node id
// (`SceneFromDAG.tsx`, the pick wrapper). Measured on both roads (s168): a native import draws an
// unnamed mesh under a group named with its `Group` id; a refused one draws the file's named mesh
// under a group named with ITS `Group` id. So the drawn reader walks the object named by the root id
// and reads the live material — the same fields `__basher_gltf_meshes` reported — without asking
// which road put it there.
//
// ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────────────
//
// It does not hide the road. Every row says which road it came from, so a spec whose subject is
// "this file arrives native" can assert that, and a file that silently flips back to the clone road
// reds instead of passing on the other road's readings. The captured-map DESCRIPTOR is also
// road-shaped (the clone captures `gltfTexture` + an empty hash; native stores the image in the
// project and names it by content hash), and specs asserting on descriptors assert the road's own.
//
// Roots are identified by STRUCTURE, never by an id prefix: a scene child `Group` whose subtree holds
// a `GltfAsset` or an `Object` over `PolyMeshData`. Only the importer writes `PolyMeshData` today; a
// spec that builds one by hand would be counted as an import, which no spec does.
//
// REF: src/core/import/nativeGltfImport.ts (the native shape), src/nodes/PolyMeshData.ts,
//      tests/e2e/_importedChild.ts (the clone-road lookup this reuses),
//      src/viewport/SceneFromDAG.tsx (the pick wrapper's group name, `__basher_gltf_meshes`);
//      issues #1071, #1054.

import type { Page } from '@playwright/test';
import { importedChildren } from './_importedChild';

export type ImportRoad = 'native' | 'clone';

/** One import root: the transformable `Group` the importer put in the scene. */
export interface ImportRoot {
  readonly rootId: string;
  readonly road: ImportRoad;
}

/** One imported mesh, as the e2e tier needs to address it. */
export interface ImportedMeshRow {
  readonly road: ImportRoad;
  readonly rootId: string;
  /** The `Object` — the id selection, clips and channels use. */
  readonly objectId: string;
  /** The data half: `PolyMeshData` (native) or `GltfData` (clone). The material lives here. */
  readonly dataId: string;
  /** The captured material table, `[material]` on the native road (one material per mesh). */
  readonly slots: readonly unknown[];
}

/** What is actually drawn for one mesh under an import root, read off the live material. */
export interface DrawnImportMesh {
  readonly rootId: string;
  /** The three.js mesh name: the file's node name on the clone road, empty on the native one. */
  readonly name: string;
  readonly visible: boolean;
  readonly hasMap: boolean;
  /** The base-colour image has decoded (width > 0) — `__basher_gltf_meshes`' own rule. */
  readonly mapImageOk: boolean;
  readonly mapWidth: number | null;
  /** The base-colour texture's colour space (`'srgb'` for a base map), or null with no map. */
  readonly mapColorSpace: string | null;
  /** World-space axis-aligned bounding-box size of the drawn mesh — the clone probe's rule. */
  readonly worldBounds: [number, number, number];
  readonly hasMetalnessMap: boolean;
  readonly hasRoughnessMap: boolean;
  readonly color: string | null;
  readonly metalness: number | null;
  readonly roughness: number | null;
  readonly alphaTest: number | null;
  readonly transparent: boolean;
  readonly vertexColors: boolean;
  readonly side: number | null;
}

/** Every import root in the scene, in the scene's child order. */
export async function importRoots(page: Page): Promise<ImportRoot[]> {
  return page.evaluate(() => {
    type N = {
      type: string;
      inputs: Record<string, { node?: string } | { node?: string }[] | undefined>;
    };
    const w = window as unknown as {
      __basher_dag: {
        getState: () => {
          state: { nodes: Record<string, N>; outputs: { scene?: { node: string } } };
        };
      };
    };
    const { nodes, outputs } = w.__basher_dag.getState().state;
    const sceneId = outputs.scene?.node;
    if (!sceneId || !nodes[sceneId]) return [];
    const refs = (v: unknown): string[] =>
      (Array.isArray(v) ? v : v ? [v] : [])
        .map((r) => (r as { node?: string }).node)
        .filter((id): id is string => typeof id === 'string');
    const roadOf = (rootId: string): 'native' | 'clone' | null => {
      const seen = new Set<string>();
      const stack = [rootId];
      let road: 'native' | 'clone' | null = null;
      while (stack.length) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const n = nodes[id];
        if (!n) continue;
        if (n.type === 'GltfAsset') return 'clone';
        if (
          n.type === 'Object' &&
          refs(n.inputs.data).some((d) => nodes[d]?.type === 'PolyMeshData')
        )
          road = 'native';
        for (const v of Object.values(n.inputs)) stack.push(...refs(v));
      }
      return road;
    };
    const out: { rootId: string; road: 'native' | 'clone' }[] = [];
    for (const id of refs(nodes[sceneId].inputs.children)) {
      if (nodes[id]?.type !== 'Group') continue;
      const road = roadOf(id);
      if (road) out.push({ rootId: id, road });
    }
    return out;
  });
}

/** How many imports the scene holds, on either road. Poll it; a read before the import lands is 0. */
export async function importCount(page: Page): Promise<number> {
  return (await importRoots(page)).length;
}

/** Every imported mesh, on either road, each tagged with its road and root. */
export async function importedMeshes(page: Page): Promise<ImportedMeshRow[]> {
  const roots = await importRoots(page);
  const native = await page.evaluate(
    (rootIds: string[]) => {
      type N = {
        type: string;
        params: Record<string, unknown>;
        inputs: Record<string, { node?: string } | { node?: string }[] | undefined>;
      };
      const w = window as unknown as {
        __basher_dag: { getState: () => { state: { nodes: Record<string, N> } } };
      };
      const nodes = w.__basher_dag.getState().state.nodes;
      const refs = (v: unknown): string[] =>
        (Array.isArray(v) ? v : v ? [v] : [])
          .map((r) => (r as { node?: string }).node)
          .filter((id): id is string => typeof id === 'string');
      const rows: { rootId: string; objectId: string; dataId: string; slots: unknown[] }[] = [];
      for (const rootId of rootIds) {
        const seen = new Set<string>();
        const stack = [rootId];
        while (stack.length) {
          const id = stack.pop()!;
          if (seen.has(id)) continue;
          seen.add(id);
          const n = nodes[id];
          if (!n) continue;
          if (n.type === 'Object') {
            const dataId = refs(n.inputs.data).find((d) => nodes[d]?.type === 'PolyMeshData');
            if (dataId) {
              const material = nodes[dataId].params.material ?? null;
              rows.push({ rootId, objectId: id, dataId, slots: [material] });
            }
          }
          for (const v of Object.values(n.inputs)) stack.push(...refs(v));
        }
      }
      return rows;
    },
    roots.filter((r) => r.road === 'native').map((r) => r.rootId),
  );

  // The clone road keeps its one lookup; this only attaches each child to its root, by the asset
  // the root's subtree holds.
  const cloneRoots = roots.filter((r) => r.road === 'clone').map((r) => r.rootId);
  const assetRefByRoot = await page.evaluate((rootIds: string[]) => {
    type N = {
      type: string;
      params: Record<string, unknown>;
      inputs: Record<string, { node?: string } | { node?: string }[] | undefined>;
    };
    const w = window as unknown as {
      __basher_dag: { getState: () => { state: { nodes: Record<string, N> } } };
    };
    const nodes = w.__basher_dag.getState().state.nodes;
    const refs = (v: unknown): string[] =>
      (Array.isArray(v) ? v : v ? [v] : [])
        .map((r) => (r as { node?: string }).node)
        .filter((id): id is string => typeof id === 'string');
    const out: Record<string, string> = {};
    for (const rootId of rootIds) {
      const seen = new Set<string>();
      const stack = [rootId];
      while (stack.length) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const n = nodes[id];
        if (!n) continue;
        if (n.type === 'GltfAsset' && typeof n.params.assetRef === 'string')
          out[n.params.assetRef] = rootId;
        for (const v of Object.values(n.inputs)) stack.push(...refs(v));
      }
    }
    return out;
  }, cloneRoots);
  const clone: ImportedMeshRow[] = [];
  for (const c of await importedChildren(page)) {
    const rootId = assetRefByRoot[c.assetRef];
    if (!rootId) continue;
    clone.push({ road: 'clone', rootId, objectId: c.objectId, dataId: c.dataId, slots: c.slots });
  }
  return [...native.map((r) => ({ road: 'native' as const, ...r })), ...clone];
}

/**
 * The first imported mesh that carries a material, or `null` — `firstMaterialChild` on both roads.
 * Bones and empties carry no material on the clone road; the native road mints none of them.
 */
export async function firstMaterialMesh(page: Page): Promise<ImportedMeshRow | null> {
  return (await importedMeshes(page)).find((m) => m.slots[0] != null) ?? null;
}

/**
 * Every mesh drawn under an import root, read off the live three.js material. `rootId` narrows to one
 * import. Empty until the import has mounted and drawn — poll it.
 */
export async function drawnImportMeshes(page: Page, rootId?: string): Promise<DrawnImportMesh[]> {
  const roots = rootId ? [rootId] : (await importRoots(page)).map((r) => r.rootId);
  return page.evaluate((rootIds: string[]) => {
    type Tex = { image?: { width?: number } | null; colorSpace?: string } | null | undefined;
    type V3 = { x: number; y: number; z: number };
    type Box = {
      min: V3;
      max: V3;
      clone: () => Box;
      applyMatrix4: (m: unknown) => Box;
    };
    type Mat = {
      map?: Tex;
      metalnessMap?: Tex;
      roughnessMap?: Tex;
      color?: { getHexString: () => string };
      metalness?: number;
      roughness?: number;
      alphaTest?: number;
      transparent?: boolean;
      vertexColors?: boolean;
      side?: number;
    };
    type O3 = {
      name: string;
      isMesh?: boolean;
      visible: boolean;
      parent: O3 | null;
      material?: Mat | Mat[];
      matrixWorld: unknown;
      updateWorldMatrix: (parents: boolean, children: boolean) => void;
      geometry?: { boundingBox: Box | null; computeBoundingBox: () => void };
      getObjectByName: (n: string) => O3 | undefined;
      traverse: (f: (o: O3) => void) => void;
    };
    const w = window as unknown as { __basher_three?: { getState: () => { scene: O3 | null } } };
    const scene = w.__basher_three?.getState().scene;
    const out: DrawnImportMesh[] = [];
    if (!scene) return out;
    for (const rootId of rootIds) {
      const root = scene.getObjectByName(rootId);
      if (!root) continue;
      root.traverse((o) => {
        if (!o.isMesh) return;
        let visible = true;
        for (let p: O3 | null = o; p; p = p.parent) if (!p.visible) visible = false;
        // The geometry's own box carried through the world matrix — what
        // `Box3.setFromObject` computes for an unskinned mesh, without importing three.
        o.updateWorldMatrix(true, false);
        if (o.geometry && !o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const box = o.geometry?.boundingBox?.clone().applyMatrix4(o.matrixWorld);
        const worldBounds: [number, number, number] = box
          ? [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z]
          : [0, 0, 0];
        for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
          const width = mat?.map?.image?.width;
          out.push({
            rootId,
            name: o.name ?? '',
            visible,
            hasMap: Boolean(mat?.map),
            mapImageOk: typeof width === 'number' && width > 0,
            mapWidth: typeof width === 'number' ? width : null,
            mapColorSpace: mat?.map?.colorSpace ?? null,
            worldBounds,
            hasMetalnessMap: Boolean(mat?.metalnessMap),
            hasRoughnessMap: Boolean(mat?.roughnessMap),
            color: mat?.color ? `#${mat.color.getHexString()}` : null,
            metalness: typeof mat?.metalness === 'number' ? mat.metalness : null,
            roughness: typeof mat?.roughness === 'number' ? mat.roughness : null,
            alphaTest: typeof mat?.alphaTest === 'number' ? mat.alphaTest : null,
            transparent: mat?.transparent === true,
            vertexColors: mat?.vertexColors === true,
            side: typeof mat?.side === 'number' ? mat.side : null,
          });
        }
      });
    }
    return out;
  }, roots);
}
