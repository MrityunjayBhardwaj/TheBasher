// #130 (Wave D, D-04) — the NPanel per-field override decorator + ✕-revert,
// driven through the REAL Inspector and observed on the live three.js material
// (H40/H59 boundary-pair — NOT the node params).
//
// THE AFFORDANCE: a MaterialOverride (or GltfChild) field carries a state dot
// (hollow = inherits source / filled = director-authored) + a ✕ revert button.
// Editing the field MARKS it overridden in the same atomic (K6) → the renderer
// FORCES the channel even over a source map. Revert clears the bit through the
// shared overrideSet primitive → the renderer falls back to source.
//
// THE PROOF (on a textured-metal asset whose metalnessMap defends the channel):
//   (0) Wire MaterialOverride (metalness=0.2, NO authored bit) → rendered
//       metalness STAYS 1 (the #99 map-aware default; the dot is hollow).
//   (1) Edit the metalness field to 0 via the real NPanel input → the live
//       material reports metalness===0 (FORCED) and the dot fills — proving
//       edit-marks-overridden in one atomic.
//   (2) Click the ✕ revert decorator → the live material returns to metalness 1
//       (map defends again) and the dot goes hollow — proving revert restores
//       source through the explicit bit.
//
// GltfChild parity (the consolidation dividend — the SAME decorator on the SAME
// ParamRow) is covered by overrideDescriptor.test.ts (GltfChild is a descriptor
// consumer) + the shared code path; this spec proves the live-channel half on
// the material seam (__basher_gltf_meshes exposes .metalness, not TRS).

import { test, expect } from './_fixtures';

interface MeshSummary {
  readonly name: string;
  readonly hasMap: boolean;
  readonly mapImageOk: boolean;
  readonly color: string | null;
  readonly metalness: number | null;
  readonly roughness: number | null;
  readonly hasMetalnessMap: boolean;
  readonly hasRoughnessMap: boolean;
}
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
  __basher_gltf_meshes?: () => MeshSummary[];
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
    const summary = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      return w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : [];
    });
    last = summary;
    const match = summary.find((m) => m.hasMap && m.mapImageOk && accept(m));
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

test('#130 (D-04) — NPanel decorator: edit marks overridden + ✕ reverts, observed live', async ({
  page,
}) => {
  // (0) Import the textured-metal fixture + wire a MaterialOverride with a
  //     metalness scalar but NO authored bit (the map defends → metalness 1).
  await ingestFixtures(
    page,
    [
      { urlPath: '/fixtures/multifile/metal/scene.gltf', relativePath: 'scene.gltf' },
      { urlPath: '/fixtures/multifile/metal/scene.bin', relativePath: 'scene.bin' },
      { urlPath: '/fixtures/multifile/metal/texture.png', relativePath: 'texture.png' },
    ],
    'decorator-asset',
  );
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    const nodes = dag.state.nodes;
    const gltfId = Object.keys(nodes).find((id) => nodes[id].type === 'GltfAsset')!;
    const transformId = Object.keys(nodes).find((id) => nodes[id].type === 'Transform')!;
    dag.dispatchAtomic(
      [
        {
          type: 'disconnect',
          from: { node: gltfId, socket: 'out' },
          to: { node: transformId, socket: 'target' },
        },
        {
          type: 'addNode',
          nodeId: 'mo130',
          nodeType: 'MaterialOverride',
          params: { color: '#ffffff', metalness: 0.2 },
        },
        {
          type: 'connect',
          from: { node: gltfId, socket: 'out' },
          to: { node: 'mo130', socket: 'target' },
        },
        {
          type: 'connect',
          from: { node: 'mo130', socket: 'out' },
          to: { node: transformId, socket: 'target' },
        },
      ],
      'user',
      '#130 wire override',
    );
    w.__basher_selection!.getState().select('mo130');
  });

  // Baseline: the metalnessMap defends — rendered metalness stays 1.
  const baseline = await pollForMesh(page, (m) => m.metalness === 1, 'baseline');
  expect(baseline.hasMetalnessMap).toBe(true);

  // Open the Inspector material section so the decorated field is on screen.
  await expect(page.getByTestId('inspector')).toBeVisible();
  const sectionBody = page.getByTestId('inspector-section-body-material');
  if (!(await sectionBody.isVisible().catch(() => false))) {
    await page.getByTestId('inspector-section-toggle-material').click();
  }
  await expect(sectionBody).toBeVisible();

  // The dot starts hollow (the field inherits source — no authored bit).
  const dot = page.getByTestId('inspector-override-dot-mo130-metalness');
  await expect(dot).toBeVisible();
  await expect(dot).not.toHaveAttribute('data-overridden', 'true');

  // (1) Edit the metalness field through the REAL NPanel input → the same atomic
  //     marks it overridden, so the renderer FORCES the channel over the map.
  const input = page.getByTestId('inspector-input-mo130-metalness');
  await input.fill('0');
  await input.blur();
  const forced = await pollForMesh(page, (m) => m.metalness === 0, 'forced-via-npanel');
  expect(forced.metalness, 'editing the field forces the channel (marks overridden)').toBe(0);
  expect(forced.hasMetalnessMap, 'the map ref survives (force is a flatten, not a drop)').toBe(
    true,
  );
  await expect(dot).toHaveAttribute('data-overridden', 'true');

  // (2) Click the ✕ revert decorator → the bit clears, the map defends again.
  await page.getByTestId('inspector-override-revert-mo130-metalness').click();
  const reverted = await pollForMesh(page, (m) => m.metalness === 1, 'reverted-via-npanel');
  expect(reverted.metalness, 'reverting clears the bit → source channel restored').toBe(1);
  await expect(dot).not.toHaveAttribute('data-overridden', 'true');
});
