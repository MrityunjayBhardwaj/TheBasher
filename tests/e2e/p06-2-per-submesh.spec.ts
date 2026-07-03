// v0.6 #2 (#178, W6 — D-05/D-07) — per-submesh material override on a
// MULTI-material glTF.
//
// THE FEATURE: a MaterialOverride wrapping a multi-material glTF can address ONE
// submesh slot (slotIndex) instead of every slot. Editing slot 1 must leave slot
// 0 untouched, and must KEEP slot 1's imported maps (H59 — clone-preserve, not
// wholesale-replace). The slotIndex-absent override stays whole-child (#99/#124
// backward-compat).
//
// THE PROOF (Lokayata — observe the REAL three.js material per slot, side A):
//   - Fixture `two-material-textured-quad.gltf`: ONE mesh, TWO primitives → two
//     render slots. Slot 0 = RedMat (no maps). Slot 1 = BlueMat carrying a
//     glTF metallicRoughnessTexture → three.js `.roughnessMap` (+ `.metalnessMap`).
//   - Read each slot off `__basher_gltf_meshes()` (DEV seam over the CLONED tree,
//     the object the renderer actually drew — H40/H59). Each entry carries its
//     `slot` index (per-mesh, same order GltfAssetR's override effect counts).
//
// FALSIFICATION (run once, then revert — see the wave log):
//   (a) per-slot isolation — make the override apply to EVERY slot (drop the
//       slotIndex match) → SC-1's "slot 0 unchanged" FAILS.
//   (b) map-survive — wholesale-replace the slot material → slot 1's
//       `hasRoughnessMap` FAILS (the #99/H59 trap, here per-slot).

import { test, expect } from './_fixtures';

const ASSET_REF = 'assets/two-material-textured-quad.gltf';
const FIXTURE_URL = '/assets/two-material-textured-quad.gltf';

interface MeshSummary {
  slot: number;
  name: string;
  color: string | null;
  roughness: number | null;
  hasRoughnessMap: boolean;
  hasMetalnessMap: boolean;
}
interface Op {
  type: string;
  [k: string]: unknown;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string }>; outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_importGltf?: (buffer: ArrayBuffer, assetRef: string) => Promise<{ gltfAssetId: string }>;
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_gltf_meshes?: () => MeshSummary[];
}

/** Stage the textured 2-material quad: bytes → OPFS, structure → DAG, then wait
 *  until the rendered clone reports BOTH slots with slot 1 carrying its
 *  roughnessMap (the import + render actually completed — observed, not inferred). */
async function stageTexturedQuad(page: import('@playwright/test').Page) {
  await page.evaluate(
    async ({ url, ref }) => {
      const w = window as unknown as BasherWindow;
      const buf = await fetch(url).then((r) => r.arrayBuffer());
      await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
      await w.__basher_importGltf!(buf, ref);
    },
    { url: FIXTURE_URL, ref: ASSET_REF },
  );
  await page.waitForFunction(
    () => {
      const w = window as unknown as BasherWindow;
      const s = w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : [];
      return s.length === 2 && s.some((m) => m.slot === 1 && m.hasRoughnessMap);
    },
    { timeout: 15_000 },
  );
}

/** Insert a MaterialOverride between the imported GltfAsset and its Group
 *  wrapper (the gltfImportChain GltfAsset.out → Group.children seam, V67), via the
 *  op path the app uses — NOT a React-prop injection (H58). */
async function insertOverride(
  page: import('@playwright/test').Page,
  params: Record<string, unknown>,
) {
  await page.evaluate((p) => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    const nodes = dag.state.nodes;
    const gltfId = Object.keys(nodes).find((id) => nodes[id].type === 'GltfAsset');
    // V67: import root is a transformable Group (was a Transform); the asset
    // wires into Group.children (a list socket, was Transform.target/single).
    const groupId = Object.keys(nodes).find((id) => nodes[id].type === 'Group');
    if (!gltfId || !groupId) throw new Error('expected GltfAsset + Group from import');
    dag.dispatchAtomic(
      [
        {
          type: 'disconnect',
          from: { node: gltfId, socket: 'out' },
          to: { node: groupId, socket: 'children' },
        },
        { type: 'addNode', nodeId: 'mo62', nodeType: 'MaterialOverride', params: p },
        {
          type: 'connect',
          from: { node: gltfId, socket: 'out' },
          to: { node: 'mo62', socket: 'target' },
        },
        {
          type: 'connect',
          from: { node: 'mo62', socket: 'out' },
          to: { node: groupId, socket: 'children' },
        },
      ],
      'user',
      'insert per-submesh override',
    );
  }, params);
}

/** Read the per-slot material summary off the rendered clone, sorted by slot. */
async function readSlots(page: import('@playwright/test').Page): Promise<MeshSummary[]> {
  // One repaint so a fresh override re-applies before the read.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  const slots = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : [];
  });
  return [...slots].sort((a, b) => a.slot - b.slot);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* OPFS entry absent on first run */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_importGltf && w.__basher_writeOpfsBytes && w.__basher_dag);
  });
});

test('W6 (#178) — a per-slot override edits ONLY its slot and keeps that slot’s maps (H59)', async ({
  page,
}) => {
  await stageTexturedQuad(page);

  // Baseline: slot 0 = RedMat (no roughnessMap, roughness 0.5); slot 1 = BlueMat
  // WITH a roughnessMap. Observe the real clone, not the glTF JSON.
  const base = await readSlots(page);
  expect(base).toHaveLength(2);
  expect(base[0].hasRoughnessMap, 'slot 0 (RedMat) has no roughnessMap').toBe(false);
  expect(base[1].hasRoughnessMap, 'slot 1 (BlueMat) carries a roughnessMap').toBe(true);
  expect(base[0].color).toBe('#ff0000'); // red
  expect(base[1].color).toBe('#0000ff'); // blue

  // Edit slot 1's roughness (FORCED over the map — #124 — so the scalar lands
  // while the map survives) + a marker colour. slotIndex=1 ⇒ slot 0 untouched.
  await insertOverride(page, {
    slotIndex: 1,
    color: '#00ff00',
    roughness: 0.123,
    overridden: { roughness: true },
  });

  const after = await readSlots(page);
  expect(after).toHaveLength(2);

  // Slot 1 — the override LANDED and the imported roughnessMap SURVIVED (H59:
  // clone-preserve, not wholesale-replace). A wholesale-replace would drop it.
  expect(after[1].color, 'slot 1 tint landed').toBe('#00ff00');
  expect(after[1].roughness ?? -1, 'slot 1 forced roughness landed').toBeCloseTo(0.123, 5);
  expect(after[1].hasRoughnessMap, 'slot 1 roughnessMap SURVIVED the per-slot edit').toBe(true);

  // Slot 0 — completely UNCHANGED (the per-slot override never touched it).
  expect(after[0].color, 'slot 0 untouched by a slot-1 edit').toBe('#ff0000');
  expect(after[0].roughness ?? -1, 'slot 0 roughness untouched').toBeCloseTo(0.5, 5);
  expect(after[0].hasRoughnessMap).toBe(false);
});

test('W6 (#178) — a whole-child override (no slotIndex) still tints EVERY slot (backward-compat)', async ({
  page,
}) => {
  await stageTexturedQuad(page);
  await readSlots(page); // ensure baseline rendered

  // No slotIndex ⇒ the #99/#124 whole-child behaviour: BOTH slots get the tint,
  // and the textured slot keeps its roughnessMap.
  await insertOverride(page, { color: '#00ff00' });

  const after = await readSlots(page);
  expect(after).toHaveLength(2);
  expect(after[0].color, 'slot 0 tinted by whole-child override').toBe('#00ff00');
  expect(after[1].color, 'slot 1 tinted by whole-child override').toBe('#00ff00');
  expect(after[1].hasRoughnessMap, 'slot 1 keeps its roughnessMap under whole-child override').toBe(
    true,
  );
});
