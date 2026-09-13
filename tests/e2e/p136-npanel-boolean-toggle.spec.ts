// #136 — NPanel BooleanField, driven through the REAL Inspector and observed on
// the live three.js material. Before this, every boolean param rendered as the
// `(complex — Pro mode)` fallback and was NOT editable in the UI — so #131's
// `ignoreSourceMaterial` flatten toggle could only be set via setParam/agent.
//
// THE PROOF (on a textured-metal asset):
//   (0) wire a MaterialOverride, select it → the Inspector shows an
//       `ignoreSourceMaterial` checkbox (unchecked; maps intact).
//   (1) check it via the real checkbox → the live material drops its maps by
//       intent (flatten) — proving the boolean is UI-editable and dispatches.
//   (2) uncheck it → the maps restore (the composed material is back).
//
// #1072 — the fixture now arrives as native geometry (#1050); the override wraps an
// ordinary Object (`_importOverride.ts`) and the drawn material is read by
// `_importedMesh.ts`. The checkbox half holds on that road. ⚠️ RED AT STEP (1) UNTIL
// #1076: the native draw ignores `ignoreSourceMaterial`, so checking the box dispatches
// and changes nothing on screen. The spec asserts the promise, not today's behaviour.

import { test, expect } from './_fixtures';
import { drawnImportMeshes, importRoots, type DrawnImportMesh } from './_importedMesh';
import { wrapImportInOverride } from './_importOverride';

type MeshSummary = DrawnImportMesh;
interface IngestFileShape {
  relativePath: string;
  bytes: Uint8Array;
}
interface Op {
  type: string;
  [k: string]: unknown;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params?: Record<string, unknown> }> };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_ingestGltfFolder?: (
    files: ReadonlyArray<IngestFileShape>,
    folderName: string,
  ) => Promise<string>;
}

interface FixtureSpec {
  readonly urlPath: string;
  readonly relativePath: string;
}

async function ingestFixtures(
  page: import('@playwright/test').Page,
  fixtures: ReadonlyArray<FixtureSpec>,
  folderName: string,
): Promise<string> {
  return page.evaluate(
    async ({ fixtures: f, name }) => {
      const w = window as unknown as BasherWindow;
      const files: IngestFileShape[] = [];
      for (const spec of f) {
        const buf = await fetch(spec.urlPath).then((r) => r.arrayBuffer());
        files.push({ relativePath: spec.relativePath, bytes: new Uint8Array(buf) });
      }
      return await w.__basher_ingestGltfFolder!(files, name);
    },
    { fixtures: fixtures as FixtureSpec[], name: folderName },
  );
}

async function pollForMesh(
  page: import('@playwright/test').Page,
  accept: (m: MeshSummary) => boolean,
  label: string,
  timeoutMs = 8_000,
): Promise<MeshSummary> {
  const start = Date.now();
  let last: MeshSummary[] = [];
  while (Date.now() - start < timeoutMs) {
    const summary = await drawnImportMeshes(page);
    last = summary;
    const match = summary.find((m) => accept(m));
    if (match) return match;
    await page.waitForTimeout(120);
  }
  throw new Error(`pollForMesh(${label}) timed out; last summary: ${JSON.stringify(last)}`);
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
    return Boolean(w.__basher_dag && w.__basher_ingestGltfFolder && w.__basher_selection);
  });
});

test('#136 — boolean param is UI-editable: ignoreSourceMaterial checkbox flattens/restores, observed live', async ({
  page,
}) => {
  await ingestFixtures(
    page,
    [
      { urlPath: '/fixtures/multifile/metal/scene.gltf', relativePath: 'scene.gltf' },
      { urlPath: '/fixtures/multifile/metal/scene.bin', relativePath: 'scene.bin' },
      { urlPath: '/fixtures/multifile/metal/texture.png', relativePath: 'texture.png' },
    ],
    'bool-asset',
  );
  await expect.poll(async () => (await importRoots(page)).map((r) => r.road)).toEqual(['native']);
  await wrapImportInOverride(page, 'mo136', {});
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_selection!.getState().select('mo136');
  });

  // Baseline: textured, maps intact.
  const baseline = await pollForMesh(page, (m) => m.hasMap && m.mapImageOk, 'baseline');
  expect(baseline.hasMetalnessMap).toBe(true);

  // The boolean now renders as a real checkbox (was `(complex — Pro mode)`).
  await expect(page.getByTestId('inspector')).toBeVisible();
  const toggle = page.getByTestId('inspector-toggle-mo136-ignoreSourceMaterial');
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();

  // (1) Check it → flatten drops the source maps by intent.
  await toggle.check();
  await expect(toggle).toBeChecked();
  const flattened = await pollForMesh(page, (m) => !m.hasMap, 'flattened-via-checkbox');
  expect(flattened.hasMap, 'checking the box flattens the material (maps dropped)').toBe(false);
  expect(flattened.hasMetalnessMap).toBe(false);

  // (2) Uncheck → the composed material restores every map.
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  const restored = await pollForMesh(page, (m) => m.hasMap, 'restored-via-checkbox');
  expect(restored.hasMap && restored.hasMetalnessMap, 'unchecking restores the maps').toBe(true);
});
