// Import a fixture on the CLONE road, laid out on disk exactly as the ingest door lays it out.
//
// #1063 — `cube-draco.glb` was the fixture these specs used to reach the clone road, because the
// native reader refused Draco. It now decodes Draco, so the ingest door brings the file across as
// native geometry and the clone road's machinery (GltfAsset, GltfChild, the rendered clone and its
// material overlay) is no longer on the path. The clone road still serves every file the native
// road refuses (#1053 retires it), so specs whose subject is that road import through
// `__basher_importGltf`, which never tries native — the precedent #1123 set in
// `gltf-material-render-options.spec.ts`. The bytes go to `user-imports/<folder>/<file>`, where
// ingest would have put them, so the asset ref, the OPFS read and the bundle embed are unchanged.
//
// REF: src/app/boot.ts (`__basher_importGltf`, `__basher_writeOpfsBytes`); issues #1063, #1053.

import type { Page } from '@playwright/test';

interface CloneImportWindow {
  __basher_writeOpfsBytes: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_importGltf: (buffer: ArrayBuffer, assetRef: string) => Promise<unknown>;
}

/**
 * Import `/assets/<file>` on the clone road as `user-imports/<folder>/<saveAs>` (the file's own name
 * by default, as ingest keeps it). Returns the asset ref.
 */
export async function ingestOnCloneRoad(
  page: Page,
  file: string,
  folder: string,
  saveAs: string = file,
): Promise<string> {
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<CloneImportWindow>;
    return (
      typeof w.__basher_importGltf === 'function' && typeof w.__basher_writeOpfsBytes === 'function'
    );
  });
  return page.evaluate(
    async ({ file, folder, saveAs }) => {
      const w = window as unknown as CloneImportWindow;
      const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
      const path = `user-imports/${folder}/${saveAs}`;
      await w.__basher_writeOpfsBytes(path, bytes);
      await w.__basher_importGltf(bytes.slice().buffer, path);
      return path;
    },
    { file, folder, saveAs },
  );
}
