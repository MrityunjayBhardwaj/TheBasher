// glTF direct-import (V53, V38 no-silent-drop) — features the importer does not
// yet capture into the editable IR (sheen/volume/specular, KHR_texture_transform,
// secondary UV sets) are surfaced as a CONSOLE notice on import, not silently
// dropped. The import stays FAITHFUL (the clone renders these), so this is a
// notice — NOT the red `asset failed:` error banner (user decision 2026-06-20).
//
// THE PROOF: importing sheen-quad.gltf (KHR_materials_sheen + a TEXCOORD_1) emits
// a console warning naming both limitations; the asset-error banner stays absent.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

test('an import with not-yet-editable features warns to the console, not the error banner', async ({
  page,
}) => {
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text());
  });

  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
  );
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const bytes = new Uint8Array(
      await fetch('/assets/sheen-quad.gltf').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestGltfFolder([{ relativePath: 'sheen-quad.gltf', bytes }], 'sheen');
  });

  // The console notice names BOTH limitations (the extension + the secondary UV set).
  // Found by its own wording: since #1049 a second warning also names the extension —
  // the one saying why this file took the clone road rather than arriving native.
  await expect
    .poll(() => warnings.find((t) => t.includes("aren't editable in Basher yet")))
    .toContain('KHR_materials_sheen');
  expect(warnings.find((t) => t.includes("aren't editable in Basher yet"))).toContain(
    'secondary UV set',
  );
  // …and the road notice says why it is not native, naming the issue that brings it across.
  // Sheen is a material lobe the native material does not hold (#1123); the second UV set is no
  // longer a reason, since the native road carries it (#1062).
  expect(warnings.find((t) => t.includes('not as native geometry'))).toContain('#1123');
  // …and the import is NOT presented as a failure (no red error banner).
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
});
