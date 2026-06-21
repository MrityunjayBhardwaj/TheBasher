// Multi-glTF entry chooser (#214 follow-up). A folder with more than one glTF
// (e.g. a `model.gltf` + `model_Textured.gltf` variant pack) used to have ONE
// silently auto-picked by locateEntryFile — often the stripped/untextured one.
// Now the user is prompted to choose which model to import.
//
// Driven through the __basher_ingestGltfFolder seam, which routes through the
// SAME interactive chokepoint (ingestAndImportGltf → resolveGltfEntryChoice) the
// menu/drag paths use. The ingest promise is stashed on window so the test can
// interact with the modal mid-flight, then await the result.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_gltf_meshes?: () => { name: string; hasMap: boolean }[];
  __p?: Promise<string>;
}

// Kick off an import of a TWO-entry set (one textured, one plain) built from the
// known-good albedo fixture, WITHOUT awaiting — so the chooser modal is up while
// the test interacts. Both entries are self-contained (data-URI buffer + image),
// so ingest succeeds for whichever is chosen.
async function startMultiEntryImport(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const texturedBytes = new Uint8Array(
      await fetch('/assets/albedo-textured-quad.gltf').then((r) => r.arrayBuffer()),
    );
    const doc = JSON.parse(new TextDecoder().decode(texturedBytes)) as Record<string, unknown>;
    // Derive a PLAIN variant from the same valid geometry: strip its texture.
    const plain = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    plain.materials = [{ name: 'Plain', pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 } }];
    delete plain.textures;
    delete plain.images;
    delete plain.samplers;
    const plainBytes = new TextEncoder().encode(JSON.stringify(plain));
    // Don't await — let the chooser modal stay up for the test to interact with.
    w.__p = w.__basher_ingestGltfFolder(
      [
        { relativePath: 'b_plain.gltf', bytes: plainBytes },
        { relativePath: 'a_textured.gltf', bytes: texturedBytes },
      ],
      'multi',
    );
  });
}

test.describe('multi-glTF entry chooser (#214)', () => {
  test('prompts on a multi-entry folder; picking the textured one imports it', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
    );
    await startMultiEntryImport(page);

    // The chooser appears with BOTH entries (richest-first → textured on top).
    const chooser = page.getByTestId('gltf-entry-chooser');
    await expect(chooser).toBeVisible();
    const options = page.getByTestId('gltf-entry-option');
    await expect(options).toHaveCount(2);
    await expect(options.first()).toContainText('a_textured.gltf'); // 1 material · 1 texture

    // Pick the textured entry → it imports, and a clone mesh carries a base map.
    await options.first().click();
    const entryPath = await page.evaluate(() => (window as unknown as BasherWindow).__p);
    expect(entryPath).toContain('a_textured.gltf');
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const w = window as unknown as BasherWindow;
          return (w.__basher_gltf_meshes?.() ?? []).some((m) => m.hasMap);
        }),
      )
      .toBe(true);
  });

  test('dismissing the chooser aborts the import (no model added)', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
    );
    await startMultiEntryImport(page);

    const chooser = page.getByTestId('gltf-entry-chooser');
    await expect(chooser).toBeVisible();
    await page.getByTestId('gltf-entry-cancel').click();

    // The seam resolves to '' (no import) and the chooser is gone.
    const entryPath = await page.evaluate(() => (window as unknown as BasherWindow).__p);
    expect(entryPath).toBe('');
    await expect(chooser).toBeHidden();
  });
});
