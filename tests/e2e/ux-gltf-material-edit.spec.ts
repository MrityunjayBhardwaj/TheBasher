// #178 (S4) — the inspector MATERIAL section for an imported child is EDITABLE: the
// native OpenPBR lobe editor, wired to the child's DAG-captured `materials[]`.
//
// THE PROOF (falsifiable, [[H97]]): import cube-draco → select its GltfChild →
// the MATERIAL section renders editable fields (not the read-only readout). Type
// a new base-colour hex into the inspector → the DAG `materials[0].base.color`
// changes AND the rendered clone repaints (read back through __basher_gltf_meshes,
// the same live-three.js seam S3 uses). If the editor weren't wired to the same
// `materials` the renderer reads, the clone colour would never change.

import { test, expect } from './_fixtures';
import { openInspectorSection } from './_inspectorSections';
import { importedChild, importedChildren } from './_importedChild';

interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { id: string; type: string; params: Record<string, unknown> }>;
      };
    };
  };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_gltf_meshes?: () => { name: string; color: string | null; hasMap: boolean }[];
}

async function ingestCube(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const bytes = new Uint8Array(
      await fetch('/assets/cube-draco.glb').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestGltfFolder([{ relativePath: 'cube-draco.glb', bytes }], 'matedit');
  });
}

// #389 — `id` is the DATA half's (where the material lives and what the controls are
// keyed on); `objectId` is what a director selects. `materials` is the flattened slot
// table, which is what `materials[]` used to be.
async function cubeChild(page: import('@playwright/test').Page) {
  const c = await importedChild(page, 'cube');
  return c
    ? {
        id: c.dataId,
        objectId: c.objectId,
        materials: c.slots as { base: { color: string } }[],
      }
    : null;
}

const renderedCubeColor = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const m = (w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : []).find(
      (s) => s.name === 'cube',
    );
    return m ? m.color : null;
  });

test.describe('#178 S4 — editable glTF material inspector', () => {
  test('editing base.color via the inspector editor repaints the rendered clone', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
    );
    await ingestCube(page);
    await expect
      .poll(async () => (await cubeChild(page))?.materials?.length ?? 0)
      .toBeGreaterThan(0);
    await expect.poll(() => renderedCubeColor(page)).toBeTruthy();

    const child = await cubeChild(page);
    await page.evaluate((id) => {
      (window as unknown as BasherWindow).__basher_selection.getState().select(id);
    }, child!.id);
    // The MATERIAL section is default-collapsed — expand it.
    await openInspectorSection(page, 'material');

    // The EDITABLE editor renders (not the read-only readout).
    const editor = page.getByTestId(`inspector-material-editor-${child!.id}`);
    await expect(editor).toBeVisible();
    await expect(page.getByTestId('gltf-material-readout')).toHaveCount(0);

    // Type a new base colour into the hex field → commit on Enter.
    const hex = page.getByTestId(`inspector-colorhex-${child!.id}-material.base.color`);
    await hex.fill('#ff0000');
    await hex.press('Enter');

    // Side A: the DAG material updated.
    await expect
      .poll(async () => (await cubeChild(page))?.materials?.[0].base.color)
      .toBe('#ff0000');
    // Side B: the rendered clone repainted (the S3 overlay re-applied on the edit).
    await expect.poll(() => renderedCubeColor(page)).toBe('#ff0000');
  });

  test('editing metalness via the inspector writes the DAG material', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
    );
    await ingestCube(page);
    await expect
      .poll(async () => (await cubeChild(page))?.materials?.length ?? 0)
      .toBeGreaterThan(0);
    const child = await cubeChild(page);
    await page.evaluate((id) => {
      (window as unknown as BasherWindow).__basher_selection.getState().select(id);
    }, child!.id);
    await openInspectorSection(page, 'material');

    const num = page.getByTestId(`inspector-input-${child!.id}-material.base.metalness`);
    await expect(num).toBeVisible();
    await num.fill('0.7');

    await expect
      .poll(async () => {
        const c = await cubeChild(page);
        return (c?.materials as unknown as { base: { metalness: number } }[])?.[0].base.metalness;
      })
      .toBe(0.7);
  });

  test('a multi-slot child offers a slot selector; editing slot 1 writes that slot only', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_importGltf === 'function',
    );
    // The two-material quad → ONE GltfChild owning 2 material slots.
    await page.evaluate(async () => {
      const w = window as unknown as BasherWindow & {
        __basher_importGltf: (b: ArrayBuffer, ref: string) => Promise<unknown>;
        __basher_writeOpfsBytes: (p: string, b: Uint8Array) => Promise<void>;
      };
      const ref = 'assets/two-material-textured-quad.gltf';
      const buf = await fetch('/assets/two-material-textured-quad.gltf').then((r) =>
        r.arrayBuffer(),
      );
      await w.__basher_writeOpfsBytes(ref, new Uint8Array(buf));
      await w.__basher_importGltf(buf, ref);
    });
    // #389 — the two-slot child, found by ARITY on the flattened table (`materialSlots ??
    // [material]`), which is what the retired `materials[].length === 2` asked.
    const twoSlotChild = async () =>
      (await importedChildren(page)).find((c) => c.slots.length === 2) ?? null;
    await expect.poll(async () => (await twoSlotChild()) !== null).toBe(true);
    const two = (await twoSlotChild())!;
    const childId = two.dataId;

    // Select the OBJECT; the editor is keyed on the DATA half.
    await page.evaluate((id) => {
      (window as unknown as BasherWindow).__basher_selection.getState().select(id);
    }, two.objectId);
    await openInspectorSection(page, 'material');

    // Two slot buttons; switch to slot 1, then edit its base colour.
    await expect(page.getByTestId(`inspector-material-slot-${childId}-0`)).toBeVisible();
    await page.getByTestId(`inspector-material-slot-${childId}-1`).click();
    const hex = page.getByTestId(`inspector-colorhex-${childId}-materialSlots.1.base.color`);
    await hex.fill('#00ff00');
    await hex.press('Enter');

    // Slot 1 changed; slot 0 is untouched (the whole-array replace edits only the
    // active slot).
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const w = window as unknown as BasherWindow;
          const c = w.__basher_dag.getState().state.nodes[id as string];
          // #389 — the full table lives in `materialSlots` for a multi-primitive child,
          // and it is what `dataSlotsOnly` renders from. The sibling `material` is the
          // ONE-SLOT fallback, deliberately left at its imported value here, so reading
          // it would report slot 0 as unchanged after an edit that did land.
          const mats = c.params.materialSlots as { base: { color: string } }[];
          return [mats[0].base.color, mats[1].base.color];
        }, childId),
      )
      .toEqual(['#ff0000', '#00ff00']);
  });
});
