// v0.6 #2 (#178, W6) — a whole-child MaterialOverride over a MULTI-material import tints EVERY slot,
// and the textured slot keeps its imported map.
//
// Fixture `two-material-textured-quad.gltf`: two primitives, imported native as ONE mesh with two
// material slots (#1052). Slot 0 = RedMat (no maps); slot 1 = BlueMat carrying a
// metallicRoughnessTexture → three's `.roughnessMap`. Each slot is read off the live three.js
// material the import root draws.
//
// #1053 — the per-slot case (`slotIndex`, "the i-th mesh of the clone") retired with the clone road:
// no renderer reads `slotIndex` any more. Per-slot materials on the native road are the Object's
// slot overrides (`p645-object-slot-override-draws.spec.ts`).

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { importRoots } from './_importedMesh';
import { wrapImportInOverride } from './_importOverride';

interface BasherWindow {
  __basher_dag?: unknown;
  __basher_three?: unknown;
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

/** Each slot the one import draws: its colour and whether its roughness map decoded. */
async function drawnSlots(page: Page): Promise<{ color: string; roughnessMap: boolean }[]> {
  const roots = await importRoots(page);
  if (roots.length !== 1) return [];
  return page.evaluate((id) => {
    type Mat = {
      color?: { getHexString: () => string };
      roughnessMap?: { image?: { width?: number } | null } | null;
    };
    type O3 = { isMesh?: boolean; material?: Mat | Mat[]; traverse: (f: (o: O3) => void) => void };
    const w = window as unknown as {
      __basher_three: { getState: () => { scene: { getObjectByName: (n: string) => O3 } } };
    };
    const out: { color: string; roughnessMap: boolean }[] = [];
    w.__basher_three
      .getState()
      .scene.getObjectByName(id)
      ?.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
          out.push({
            color: m?.color ? `#${m.color.getHexString()}` : '',
            roughnessMap: (m?.roughnessMap?.image?.width ?? 0) > 0,
          });
      });
    return out;
  }, roots[0].rootId);
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
    return Boolean(w.__basher_ingestGltfFolder && w.__basher_dag && w.__basher_three);
  });
});

test('W6 (#178) — a whole-child override tints EVERY slot of a two-material import', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const file = 'two-material-textured-quad.gltf';
    const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
    await (window as unknown as BasherWindow).__basher_ingestGltfFolder!(
      [{ relativePath: file, bytes }],
      'p06-2',
    );
  });
  // Baseline, observed on the drawn material: red and blue, the blue slot textured.
  await expect
    .poll(() => drawnSlots(page), { timeout: 15_000 })
    .toEqual([
      { color: '#ff0000', roughnessMap: false },
      { color: '#0000ff', roughnessMap: true },
    ]);
  expect((await importRoots(page))[0].road).toBe('native');

  await wrapImportInOverride(page, 'mo62', { color: '#00ff00' });

  // Both slots take the tint, and the textured slot keeps its roughness map.
  await expect
    .poll(() => drawnSlots(page))
    .toEqual([
      { color: '#00ff00', roughnessMap: false },
      { color: '#00ff00', roughnessMap: true },
    ]);
});

// #1412 — an override saved with a `slotIndex` keeps its reset reachable. The control is a readout
// of the held slot plus an "All" button: it used to be a radio group whose one radio ("All") could
// never be the checked one, since the control only renders while a slot IS held.
test('#1412 — a held slot reads as text and "All" clears it (no radio group)', async ({ page }) => {
  await page.evaluate(async () => {
    const file = 'two-material-textured-quad.gltf';
    const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
    await (window as unknown as BasherWindow).__basher_ingestGltfFolder!(
      [{ relativePath: file, bytes }],
      'p06-2-slot',
    );
  });
  await expect.poll(async () => (await importRoots(page)).length, { timeout: 15_000 }).toBe(1);
  await wrapImportInOverride(page, 'mo62s', { color: '#00ff00', slotIndex: 1 });
  await page.evaluate(() => {
    (
      window as unknown as {
        __basher_selection: { getState: () => { select: (id: string) => void } };
      }
    ).__basher_selection
      .getState()
      .select('mo62s');
  });

  const selector = page.getByTestId('inspector-slot-selector-mo62s');
  if (!(await selector.isVisible().catch(() => false))) {
    await page.getByTestId('inspector-section-toggle-material').click();
  }
  await expect(selector).toBeVisible();
  await expect(page.getByTestId('inspector-slot-held-mo62s')).toHaveText('Slot 1');
  await expect(selector.getByRole('radiogroup')).toHaveCount(0);
  await expect(selector.getByRole('radio')).toHaveCount(0);

  await page.getByTestId('inspector-slot-all-mo62s').click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const dag = (
          window as unknown as {
            __basher_dag: {
              getState: () => {
                state: { nodes: Record<string, { params: { slotIndex?: unknown } }> };
              };
            };
          }
        ).__basher_dag.getState();
        return dag.state.nodes.mo62s?.params.slotIndex ?? 'cleared';
      }),
    )
    .toBe('cleared');
  // With no slot held there is nothing to reset, so the control goes away.
  await expect(selector).toHaveCount(0);
});
