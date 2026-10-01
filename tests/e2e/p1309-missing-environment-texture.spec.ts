// #1309 — an HDRI that cannot be read is drawn magenta and named, by the world and by a studio
// light alike, and never takes the app down.
//
// One imported HDRI lights the world AND textures a studio area light. Save, reload: both draw
// from it (the control). Delete the file and reload. Before the fix the studio light threw the
// failed read into render with no boundary above it and the app went blank (no editor, no canvas);
// the world, which has a boundary, silently lost its lighting. Now both draw the magenta stand-in —
// Blender fills an image it cannot read with magenta in both engines — the scene stays up, and the
// banner names the file once.
//
// REF: src/app/asset/environmentTextureLoader.ts (`resolveEnvironmentTexture`,
//      `missingEnvironmentFor`); src/viewport/SceneFromDAG.tsx (`StudioAreaLightR`);
//      src/viewport/SceneEnvironment.tsx; issues #1309, #1308, #1048.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitLightDataId, splitLightOps } from './_splitLight';

interface Obj {
  type: string;
  color?: { r: number; g: number; b: number };
  material?: { map?: { name?: string; image?: { width?: number } } | null };
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: unknown[]) => void;
    };
  };
  __basher_three: {
    getState: () => {
      scene: { environment: unknown; traverse: (cb: (o: Obj) => void) => void } | null;
    };
  };
  __basher_mesh_world_bounds?: (nodeId: string) => [number, number, number] | null;
  __basher_importEnvHdri: (bytes: Uint8Array, filename: string) => Promise<string>;
  __basher_opfs: { exists: (p: string) => Promise<boolean>; delete: (p: string) => Promise<void> };
}

async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () => (window as unknown as BasherWindow).__basher_mesh_world_bounds?.('n_box') != null,
    null,
    { timeout: 20_000 },
  );
}

/** What the world and the studio light draw from: the card's map, the light's tint, the world. */
function drawn(page: Page) {
  return page.evaluate(() => {
    const scene = (window as unknown as BasherWindow).__basher_three.getState().scene!;
    // Asserted, not annotated: `traverse` assigns it in a callback, which narrowing cannot see.
    let card = null as { name: string; width: number } | null;
    const tints: string[] = [];
    scene.traverse((o) => {
      const map = o.type === 'Mesh' ? o.material?.map : null;
      if (map) card = { name: map.name ?? '', width: map.image?.width ?? 0 };
      if (o.type === 'RectAreaLight' && o.color) {
        const { r, g, b } = o.color;
        tints.push(r > 0 && b > 0 && g < 1e-6 ? 'magenta' : 'other');
      }
    });
    return { card, magentaLight: tints.includes('magenta'), worldLit: !!scene.environment };
  });
}

test('#1309 — a missing HDRI is drawn magenta by the world and a studio light, not a blank app', async ({
  page,
}) => {
  test.slow(); // an import, a save and two reloads, each observed
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry('basher', { recursive: true });
    } catch {
      /* not present */
    }
  });
  await page.reload();
  await waitForEditor(page);

  const lightOps = splitLightOps({
    objectId: 'p1309_light',
    lightKind: 'Area',
    position: [3, 4, 3],
    shading: { intensity: 5, color: '#ffffff', width: 2, height: 2, lookAt: [0, 0, 0] },
  });
  const assetRef = await page.evaluate(
    async ({ lightOps, dataId }) => {
      const w = window as unknown as BasherWindow;
      const bytes = new Uint8Array(
        await fetch('/fixtures/env/test.hdr').then((r) => r.arrayBuffer()),
      );
      const assetRef = await w.__basher_importEnvHdri(bytes, 'test.hdr');
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic([
        ...lightOps,
        { type: 'setParam', nodeId: dataId, paramPath: 'tex', value: assetRef },
        {
          type: 'connect',
          from: { node: 'p1309_light', socket: 'out' },
          to: { node: sceneId, socket: 'lights' },
        },
        {
          type: 'setParam',
          nodeId: sceneId,
          paramPath: 'envSource',
          value: { kind: 'file', assetRef },
        },
      ]);
      return assetRef;
    },
    { lightOps, dataId: splitLightDataId('p1309_light') },
  );

  // CONTROL: saved and reloaded with the file present, both draw from the HDRI itself.
  await page.evaluate(async () => (await import('/src/app/boot.ts')).saveCurrent());
  await page.reload();
  await waitForEditor(page);
  await expect
    .poll(() => drawn(page), { timeout: 15_000 })
    .toMatchObject({ magentaLight: false, worldLit: true });
  expect((await drawn(page)).card?.name).not.toBe('missing-image');
  expect(errors, 'no page errors while the file is there').toEqual([]);

  // #1309: remove the file and reload. The editor comes up, the studio light's card and tint are
  // the magenta stand-in, the world is lit by it, and the banner names the file once.
  await page.evaluate((p) => (window as unknown as BasherWindow).__basher_opfs.delete(p), assetRef);
  expect(
    await page.evaluate(
      (p) => (window as unknown as BasherWindow).__basher_opfs.exists(p),
      assetRef,
    ),
  ).toBe(false);
  await page.reload();
  await waitForEditor(page);
  await expect
    .poll(() => drawn(page), { timeout: 15_000 })
    .toEqual({ card: { name: 'missing-image', width: 64 }, magentaLight: true, worldLit: true });
  const rows = page.locator('[data-testid^="asset-error-row-"]');
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId(`asset-error-row-${assetRef}`)).toContainText('drawn magenta');
  expect(errors, 'a missing HDRI is never thrown into render').toEqual([]);
});
