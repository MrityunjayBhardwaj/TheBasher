// #124 — force a mapped PBR channel (the GOAL, successor to #99 / V28).
//
// THE GAP (#99 left open): the map-aware tint REFUSES to apply roughness/
// metalness when the source carries the corresponding map — so a director
// cannot flatten a TEXTURED METAL asset. Setting metalness=0 is silently
// ignored because a metalnessMap defends the channel.
//
// THE CAPABILITY (#124): a per-field explicit `overridden` set. A field IN the
// set FORCES the scalar even over a source map; a field NOT in the set keeps
// the #99 map-defends default (backward-compat, D-03).
//
// THE PROOF (Lokayata — observe the rendered three.js material, NOT the node
// params; H40/H59 boundary-pair):
//   (0) Import a TEXTURED METAL glTF (metallicRoughnessTexture → three.js
//       .metalnessMap + .roughnessMap; metallicFactor 1 → .metalness === 1).
//   (1) Baseline: the rendered mesh reports metalness===1 AND hasMetalnessMap.
//   (2) Override metalness=0 WITHOUT the set → metalness STAYS 1 (the map
//       defends — the #99 default, the gap this issue closes). Falsification:
//       if the force fired unconditionally, this would already be 0.
//   (3) Add `overridden:{metalness:true}` via setParam → metalness FORCED to 0
//       (the #124 GOAL) while .metalnessMap STILL survives (the clone keeps the
//       ref; the forced scalar zeroes its contribution — a flatten, not a drop)
//       AND the base .map survives.
//   (4) Revert the field (`overridden:{}`) → metalness returns to 1 (map
//       defends again). The per-field bit is the ONLY thing that flips behaviour.
//
// Observation seam: SceneFromDAG `__basher_gltf_meshes()` (DEV-only, read-only,
// V8 clean) — exposes each mesh's live .metalness / .roughness + map presence.

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
      state: {
        nodes: Record<string, { type: string; params?: Record<string, unknown> }>;
        outputs: { scene?: { node: string } };
      };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
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

/** Poll the rendered mesh summary until a textured mesh satisfies `accept`. */
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
    return Boolean(w.__basher_dag && w.__basher_ingestGltfFolder);
  });
});

/** Wire a MaterialOverride between the imported GltfAsset and its Group (V67). */
async function applyOverride(
  page: import('@playwright/test').Page,
  params: Record<string, unknown>,
): Promise<void> {
  await page.evaluate((p) => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    const nodes = dag.state.nodes;
    const gltfId = Object.keys(nodes).find((id) => nodes[id].type === 'GltfAsset');
    // V67: import root is a transformable Group (was a Transform); the asset
    // wires into Group.children (a list socket, was Transform.target/single).
    const groupId = Object.keys(nodes).find((id) => nodes[id].type === 'Group');
    if (!gltfId || !groupId) throw new Error('expected GltfAsset + Group from import');
    dag.dispatchAtomic(
      [
        {
          type: 'disconnect',
          from: { node: gltfId, socket: 'out' },
          to: { node: groupId, socket: 'children' },
        },
        { type: 'addNode', nodeId: 'mo124', nodeType: 'MaterialOverride', params: p },
        {
          type: 'connect',
          from: { node: gltfId, socket: 'out' },
          to: { node: 'mo124', socket: 'target' },
        },
        {
          type: 'connect',
          from: { node: 'mo124', socket: 'out' },
          to: { node: groupId, socket: 'children' },
        },
      ],
      'user',
      '#124 apply material override',
    );
  }, params);
}

test('#124 (V28) — an authored metalness FORCES a mapped metal channel; unset still defers to the map', async ({
  page,
}) => {
  const loaderErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/GLTFLoader|DRACOLoader|parse glTF|Failed to load/i.test(t)) loaderErrors.push(t);
  });
  page.on('pageerror', (e) => loaderErrors.push(e.message));

  // (0) Import the textured METAL fixture (metallicRoughnessTexture + metallicFactor 1).
  const entryPath = await ingestFixtures(
    page,
    [
      { urlPath: '/fixtures/multifile/metal/scene.gltf', relativePath: 'scene.gltf' },
      { urlPath: '/fixtures/multifile/metal/scene.bin', relativePath: 'scene.bin' },
      { urlPath: '/fixtures/multifile/metal/texture.png', relativePath: 'texture.png' },
    ],
    'force-channel-asset',
  );
  expect(entryPath).toBe('user-imports/force-channel-asset/scene.gltf');

  // (1) Baseline: textured, metal, with a metalnessMap.
  const baseline = await pollForMesh(page, (m) => m.metalness === 1, 'baseline');
  expect(
    baseline.hasMetalnessMap,
    `metal fixture must carry a metalnessMap; ${JSON.stringify(baseline)}`,
  ).toBe(true);
  expect(baseline.metalness).toBe(1);

  // (2) Override metalness=0 WITHOUT the authored set → the map STILL defends the
  //     channel (the #99 default). This is the gap #124 closes: the metalness=0
  //     is silently ignored. (Falsification: an unconditional force would land 0 here.)
  await applyOverride(page, { color: '#ffffff', metalness: 0 });
  const unforced = await pollForMesh(page, (m) => m.color === '#ffffff', 'unforced');
  expect(
    unforced.metalness,
    `without the authored bit the metalnessMap must defend the channel; ${JSON.stringify(unforced)}`,
  ).toBe(1);
  expect(unforced.hasMetalnessMap).toBe(true);

  // (3) THE GOAL — author the bit (overridden.metalness = true) → metalness FORCED
  //     to 0 even over the map. The map ref survives (flatten, not drop); base map too.
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    dag.dispatchAtomic(
      [{ type: 'setParam', nodeId: 'mo124', paramPath: 'overridden', value: { metalness: true } }],
      'user',
      '#124 force metalness',
    );
  });
  const forced = await pollForMesh(page, (m) => m.metalness === 0, 'forced');
  expect(
    forced.metalness,
    `authored metalness=0 must force the channel; ${JSON.stringify(forced)}`,
  ).toBe(0);
  expect(forced.hasMetalnessMap, 'the metalnessMap ref must survive (flatten, not drop)').toBe(
    true,
  );
  expect(forced.hasMap && forced.mapImageOk, 'the base color texture must survive').toBe(true);

  // (4) Revert the field → the map defends again (the bit is the only lever).
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    dag.dispatchAtomic(
      [{ type: 'setParam', nodeId: 'mo124', paramPath: 'overridden', value: {} }],
      'user',
      '#124 revert metalness force',
    );
  });
  const reverted = await pollForMesh(page, (m) => m.metalness === 1, 'reverted');
  expect(
    reverted.metalness,
    `reverting the bit restores map-defended metalness; ${JSON.stringify(reverted)}`,
  ).toBe(1);
  expect(reverted.hasMetalnessMap).toBe(true);

  expect(loaderErrors, `unexpected loader console errors: ${loaderErrors.join('\n')}`).toEqual([]);
});
