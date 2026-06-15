// #178 (S6 / Part B) — a11y of the editable glTF material inspector chrome.
// The S4/S5 editor adds: a slot selector (radiogroup) and map rows (a group per
// slot with pick/replace, clear/revert buttons + a hidden file input). This spec
// pins the ARIA contract so a future chrome edit can't silently regress it:
//   - the map-row buttons carry SLOT-SPECIFIC accessible names (6 slots would
//     otherwise all read "pick"/"clear" — ambiguous to a screen reader);
//   - each map row is a named role=group (NOT a <label> wrapping the file input,
//     which made clicking the slot text spuriously open the OS file chooser);
//   - the hidden file input keeps its aria-label;
//   - the multi-slot selector is a radiogroup of radios with aria-checked.

import { test, expect } from './_fixtures';

interface W {
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
  __basher_importGltf: (b: ArrayBuffer, ref: string) => Promise<unknown>;
  __basher_writeOpfsBytes: (p: string, b: Uint8Array) => Promise<void>;
}

type Page = import('@playwright/test').Page;

const cubeChildId = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as W;
    const c = Object.values(w.__basher_dag.getState().state.nodes).find(
      (n) => n.type === 'GltfChild' && n.params.childName === 'cube',
    );
    return c?.id ?? null;
  });

test.describe('#178 S6 — glTF material inspector a11y', () => {
  test('map-row buttons have slot-specific accessible names; row is a named group', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as W).__basher_ingestGltfFolder === 'function',
    );
    await page.evaluate(async () => {
      const w = window as unknown as W;
      const bytes = new Uint8Array(
        await fetch('/assets/cube-draco.glb').then((r) => r.arrayBuffer()),
      );
      await w.__basher_ingestGltfFolder([{ relativePath: 'cube-draco.glb', bytes }], 'a11y');
    });
    await expect.poll(() => cubeChildId(page)).not.toBeNull();
    const id = await cubeChildId(page);
    await page.evaluate(
      (i) => (window as unknown as W).__basher_selection.getState().select(i),
      id,
    );
    await page.getByTestId('inspector-section-toggle-material').click();

    // The albedo row is a named group (not a label), and its action buttons read
    // unambiguously — "Pick albedo map" / "Clear albedo map", not bare "pick".
    await expect(page.getByRole('group', { name: /albedo map/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pick albedo map' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear albedo map' })).toBeVisible();
    // A different slot's buttons are distinct (normal, not albedo).
    await expect(page.getByRole('button', { name: 'Pick normal map' })).toBeVisible();
    // The hidden file input keeps its aria-label.
    await expect(page.getByTestId(`inspector-gltfmap-file-${id}-0-albedo`)).toHaveAttribute(
      'aria-label',
      'albedo map file',
    );
  });

  test('the multi-slot selector is a radiogroup of radios with aria-checked', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as W).__basher_importGltf === 'function',
    );
    await page.evaluate(async () => {
      const w = window as unknown as W;
      const ref = 'assets/two-material-textured-quad.gltf';
      const buf = await fetch('/assets/two-material-textured-quad.gltf').then((r) =>
        r.arrayBuffer(),
      );
      await w.__basher_writeOpfsBytes(ref, new Uint8Array(buf));
      await w.__basher_importGltf(buf, ref);
    });
    const twoSlotChild = () =>
      page.evaluate(() => {
        const w = window as unknown as W;
        const c = Object.values(w.__basher_dag.getState().state.nodes).find(
          (n) =>
            n.type === 'GltfChild' &&
            Array.isArray(n.params.materials) &&
            (n.params.materials as unknown[]).length === 2,
        );
        return c?.id ?? null;
      });
    await expect.poll(twoSlotChild).not.toBeNull();
    const id = await twoSlotChild();
    await page.evaluate(
      (i) => (window as unknown as W).__basher_selection.getState().select(i),
      id,
    );
    await page.getByTestId('inspector-section-toggle-material').click();

    const group = page.getByRole('radiogroup', { name: 'Material slot' });
    await expect(group).toBeVisible();
    const radios = group.getByRole('radio');
    await expect(radios).toHaveCount(2);
    // Exactly one radio is checked (the active slot).
    await expect(group.getByRole('radio', { checked: true })).toHaveCount(1);
  });
});
