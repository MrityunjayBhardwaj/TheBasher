// #178 (S6 / Part B) — a11y of the editable glTF material inspector chrome.
// The S4/S5 editor adds: a slot selector (radiogroup) and map rows (a group per
// slot with pick/replace, remove buttons + a hidden file input). This spec
// pins the ARIA contract so a future chrome edit can't silently regress it:
//   - the map-row buttons carry SLOT-SPECIFIC accessible names (6 slots would
//     otherwise all read "pick"/"clear" — ambiguous to a screen reader);
//   - each map row is a named role=group (NOT a <label> wrapping the file input,
//     which made clicking the slot text spuriously open the OS file chooser);
//   - the hidden file input keeps its aria-label;
//   - the multi-slot selector is a radiogroup of radios with aria-checked.

import { test, expect } from './_fixtures';
import { firstMaterialMesh, importedMeshes } from './_importedMesh';
import { openInspectorSection } from './_inspectorSections';

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
}

type Page = import('@playwright/test').Page;

/**
 * Import `/assets/<file>` through the door a drop takes. #1053 — the native road: this spec ran on the
 * clone road until the clone road was retired.
 */
async function ingest(page: Page, file: string, folder: string): Promise<void> {
  await page.evaluate(
    async ({ file, folder }) => {
      const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
      await (window as unknown as W).__basher_ingestGltfFolder(
        [{ relativePath: file, bytes }],
        folder,
      );
    },
    { file, folder },
  );
}

// #389 — the DATA half's id: the material rows, and therefore every label and control
// this spec reaches for, are keyed on the node that owns the material.
const cubeMesh = async (page: Page) => await firstMaterialMesh(page);

test.describe('#178 S6 — glTF material inspector a11y', () => {
  test('map-row buttons have slot-specific accessible names; row is a named group', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as W).__basher_ingestGltfFolder === 'function',
    );
    await ingest(page, 'cube-draco.glb', 'a11y');
    await expect.poll(async () => (await cubeMesh(page))?.road ?? null).toBe('native');
    const { dataId: id, objectId } = (await cubeMesh(page))!;
    // Select the OBJECT — what a director clicks; the rows are keyed on the data half.
    await page.evaluate(
      (i) => (window as unknown as W).__basher_selection.getState().select(i),
      objectId,
    );
    await openInspectorSection(page, 'material');

    // The albedo row is a named group (not a label), and its action button reads
    // unambiguously — "Pick albedo map", not bare "pick". An empty slot offers pick only
    // (#1397 — the old "clear" wrote a placeholder the renderer draws magenta); a filled
    // slot's "Replace"/"Remove" names are pinned by ux-gltf-map-edit.spec.ts.
    await expect(page.getByRole('group', { name: /albedo map/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pick albedo map' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear albedo map' })).toHaveCount(0);
    // A different slot's buttons are distinct (normal, not albedo).
    await expect(page.getByRole('button', { name: 'Pick normal map' })).toBeVisible();
    // The hidden file input keeps its aria-label.
    await expect(page.getByTestId(`inspector-map-file-${id}-albedo`)).toHaveAttribute(
      'aria-label',
      'albedo map file',
    );
  });

  test('the multi-slot selector is a radiogroup of radios with aria-checked', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as W).__basher_ingestGltfFolder === 'function',
    );
    await ingest(page, 'two-material-textured-quad.gltf', 'a11y-two');
    // #1052 — a two-primitive mesh stores the full table in `materialSlots`; `slots`
    // is that table flattened by the one rule, so the arity question is asked of it.
    const twoSlotChild = async () => {
      const c = (await importedMeshes(page)).find(
        (m) => m.road === 'native' && m.slots.length === 2,
      );
      // The OBJECT half — this id is selected, and selection addresses the object.
      return c?.objectId ?? null;
    };
    await expect.poll(twoSlotChild).not.toBeNull();
    const id = await twoSlotChild();
    await page.evaluate(
      (i) => (window as unknown as W).__basher_selection.getState().select(i),
      id,
    );
    await openInspectorSection(page, 'material');

    const group = page.getByRole('radiogroup', { name: 'Material slot' });
    await expect(group).toBeVisible();
    const radios = group.getByRole('radio');
    await expect(radios).toHaveCount(2);
    // Exactly one radio is checked (the active slot).
    await expect(group.getByRole('radio', { checked: true })).toHaveCount(1);
  });
});
