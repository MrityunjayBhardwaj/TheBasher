// #1320 — a glTF file with WebP textures imports native, and draws the image Blender draws.
//
// Blender 5.1.1 at its default settings (`import_webp_texture` off) takes a texture's fallback PNG
// or JPEG when the file has one, and the WebP source only when it is the sole one. Measured on
// these two fixtures: `webp-fallback-quad.gltf` draws the PNG (red), `webp-only-quad.gltf` the WebP
// (blue). Before #1320 the native reader refused both.
//
// Read on the drawn three material: the map's decoded image, sampled through a canvas, so "the map
// is there" and "the right picture decoded" are separate answers. Save and reload proves the stored
// `.webp` key is one the project's image store lists and loads back.
//
// REF: src/core/import/nativeGltfImport.ts (`readTextureImage`, `sniffImage`, `WEBP_EXTENSION`);
//      src/core/project/projectImages.ts; Blender `io_scene_gltf2/blender/imp/texture.py`
//      (`get_source`); issue #1320.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface Win {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string; inputs: Record<string, unknown> }> };
    };
  };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_three: {
    getState: () => {
      scene: {
        traverseVisible: (
          cb: (o: { isMesh?: boolean; material?: { map?: { image?: unknown } | null } }) => void,
        ) => void;
      } | null;
    };
  };
}

async function ready(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<Win>;
    return Boolean(w.__basher_ingestGltfFolder && w.__basher_three);
  });
}

/** The one visible mapped mesh's map, as decoded: its size and the RGB of its first texel. */
function drawnMap(page: Page) {
  return page.evaluate(() => {
    const scene = (window as unknown as Win).__basher_three.getState().scene;
    const images: CanvasImageSource[] = [];
    scene?.traverseVisible((o) => {
      const image = o.isMesh ? o.material?.map?.image : undefined;
      if (image) images.push(image as CanvasImageSource);
    });
    if (images.length !== 1) return { count: images.length };
    const image = images[0] as CanvasImageSource & { width: number; height: number };
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return { count: 1, width: image.width, rgb: [r, g, b] };
  });
}

const nativeNodes = (page: Page) =>
  page.evaluate(() => {
    const types = Object.values((window as unknown as Win).__basher_dag.getState().state.nodes).map(
      (n) => n.type,
    );
    return {
      polyMesh: types.filter((t) => t === 'PolyMeshData').length,
      clone: types.filter((t) => t === 'GltfAsset').length,
    };
  });

async function ingest(page: Page, file: string): Promise<void> {
  await page.evaluate(async (f) => {
    const bytes = new Uint8Array(await fetch(`/assets/${f}`).then((r) => r.arrayBuffer()));
    await (window as unknown as Win).__basher_ingestGltfFolder(
      [{ relativePath: f, bytes }],
      'p1320',
    );
  }, file);
}

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* not present */
      }
    }
  });
  await page.reload();
  await ready(page);
});

test('#1320 — a WebP with a PNG fallback imports native and draws the fallback', async ({
  page,
}) => {
  await ingest(page, 'webp-fallback-quad.gltf');
  expect(await nativeNodes(page)).toEqual({ polyMesh: 1, clone: 0 });
  await expect.poll(() => drawnMap(page)).toEqual({ count: 1, width: 4, rgb: [255, 0, 0] });
  expect(errors).toEqual([]);
});

test('#1320 — a WebP alone imports native, draws, and loads back after a save', async ({
  page,
}) => {
  await ingest(page, 'webp-only-quad.gltf');
  expect(await nativeNodes(page)).toEqual({ polyMesh: 1, clone: 0 });
  const blue = { count: 1, width: 4, rgb: [0, 0, 255] };
  await expect.poll(() => drawnMap(page)).toEqual(blue);

  await page.evaluate(async () => {
    const url = '/src/app/boot.ts';
    const boot = (await import(/* @vite-ignore */ url)) as { saveCurrent: () => Promise<void> };
    await boot.saveCurrent();
  });
  await page.reload();
  await ready(page);
  await expect.poll(() => drawnMap(page)).toEqual(blue);
  expect(errors).toEqual([]);
});
