// P7.13 — glTF material-override fidelity (closes #99).
//
// THE BUG: GltfAssetR's override effect replaced every mesh material with a
// fresh `new MeshStandardMaterial(7 scalars)`, dropping all imported texture
// maps and downgrading MeshPhysicalMaterial (KHR extensions) to plain Standard.
// A textured glTF flattened to a blob the instant a color override applied.
//
// THE PROOF (Lokayata — observe the rendered surface, not inference):
//   (1) Import a TEXTURED multi-file glTF (the p7.9 flat fixture: scene.gltf +
//       scene.bin + texture.png) end-to-end through the real ingest pipeline.
//   (2) Wire a MaterialOverride (#ff0000) into the DAG via the SAME op path the
//       app uses to build scenes (H58 — not a React-prop injection): insert it
//       between the imported GltfAsset and its Transform wrapper
//       (gltfImportChain wires GltfAsset.out → Transform.target → … → scene).
//   (3) Assert the rendered cloned mesh STILL reports hasMap && mapImageOk
//       (textures survived) AND its material.color is now #ff0000 (the tint
//       LANDED — both halves of the goal). Reverting the fix to the
//       wholesale-replace path makes hasMap go false → real regression gate.
//   (4) Source-integrity / restore guard (CAVEAT-5 / D-02): remove the override
//       from the chain; the mesh's color returns to its imported value AND
//       hasMap stays true. Because clones SHARE the imported material with the
//       useGLTF cache by reference (Mesh.js:60), this directly falsifies a fix
//       that mutated the shared source in place — that corruption would persist
//       on the cache and the color could NOT return. (Chosen over a two-instance
//       assertion: the __basher_gltf_meshes getter is single-asset / last-writer,
//       so the restore path is the robust observable here.)
//
// Observation seam: SceneFromDAG `__basher_gltf_meshes()` (DEV-only, read-only,
// V8 clean) — extended in this phase to expose each mesh's live material color.

import { test, expect } from './_fixtures';

interface MeshSummary {
  readonly name: string;
  readonly hasMap: boolean;
  readonly mapImageOk: boolean;
  readonly color: string | null;
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

/** Ingest fixtures end-to-end inside the page (bytes never cross the bridge). */
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

/** Poll the rendered mesh summary until a textured mesh satisfies `accept`
 *  (or time out). Returns the first matching textured-mesh entry. */
async function pollForTexturedMesh(
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
  throw new Error(`pollForTexturedMesh(${label}) timed out; last summary: ${JSON.stringify(last)}`);
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

test('P7.13 (#99) — material override tints a textured glTF without dropping its textures', async ({
  page,
}) => {
  const loaderErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/GLTFLoader|DRACOLoader|parse glTF|Failed to load/i.test(t)) loaderErrors.push(t);
  });
  page.on('pageerror', (e) => loaderErrors.push(e.message));

  // (1) Import the textured flat fixture through the real pipeline.
  const entryPath = await ingestFixtures(
    page,
    [
      { urlPath: '/fixtures/multifile/flat/scene.gltf', relativePath: 'scene.gltf' },
      { urlPath: '/fixtures/multifile/flat/scene.bin', relativePath: 'scene.bin' },
      { urlPath: '/fixtures/multifile/flat/texture.png', relativePath: 'texture.png' },
    ],
    'mat-override-asset',
  );
  expect(entryPath).toBe('user-imports/mat-override-asset/scene.gltf');

  // Baseline: the imported asset renders textured. Capture its imported color so
  // the restore assertion is robust to the fixture's actual base color.
  const baseline = await pollForTexturedMesh(page, () => true, 'baseline');
  const importedColor = baseline.color;
  expect(baseline.hasMap && baseline.mapImageOk).toBe(true);

  // (2) Wire a MaterialOverride (#ff0000) into the DAG via the op path the app
  //     uses to build scenes. Insert it between the imported GltfAsset and its
  //     Transform wrapper (gltfImportChain: GltfAsset.out → Transform.target).
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    const nodes = dag.state.nodes;
    const gltfId = Object.keys(nodes).find((id) => nodes[id].type === 'GltfAsset');
    // V67: import root is a transformable Group (was a Transform); the asset
    // wires into Group.children (a list socket, was Transform.target/single).
    const groupId = Object.keys(nodes).find((id) => nodes[id].type === 'Group');
    if (!gltfId || !groupId) {
      throw new Error(
        `expected a GltfAsset + Group from import; got ${JSON.stringify(
          Object.fromEntries(Object.entries(nodes).map(([id, n]) => [id, n.type])),
        )}`,
      );
    }
    dag.dispatchAtomic(
      [
        {
          type: 'disconnect',
          from: { node: gltfId, socket: 'out' },
          to: { node: groupId, socket: 'children' },
        },
        {
          type: 'addNode',
          nodeId: 'mo99',
          nodeType: 'MaterialOverride',
          params: { color: '#ff0000' },
        },
        {
          type: 'connect',
          from: { node: gltfId, socket: 'out' },
          to: { node: 'mo99', socket: 'target' },
        },
        {
          type: 'connect',
          from: { node: 'mo99', socket: 'out' },
          to: { node: groupId, socket: 'children' },
        },
      ],
      'user',
      'p7.13 apply material override',
    );
  });

  // (3) Textures survive AND the tint landed.
  const tinted = await pollForTexturedMesh(page, (m) => m.color === '#ff0000', 'after-override');
  expect(
    tinted.hasMap && tinted.mapImageOk,
    `textures must survive the override; got ${JSON.stringify(tinted)}`,
  ).toBe(true);
  expect(tinted.color).toBe('#ff0000');

  // (4) Source-integrity / restore: remove the override from the chain.
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    const nodes = dag.state.nodes;
    const gltfId = Object.keys(nodes).find((id) => nodes[id].type === 'GltfAsset')!;
    const groupId = Object.keys(nodes).find((id) => nodes[id].type === 'Group')!;
    dag.dispatchAtomic(
      [
        {
          type: 'disconnect',
          from: { node: 'mo99', socket: 'out' },
          to: { node: groupId, socket: 'children' },
        },
        {
          type: 'connect',
          from: { node: gltfId, socket: 'out' },
          to: { node: groupId, socket: 'children' },
        },
      ],
      'user',
      'p7.13 remove material override',
    );
  });

  const restored = await pollForTexturedMesh(
    page,
    (m) => m.color === importedColor,
    'after-restore',
  );
  expect(
    restored.hasMap && restored.mapImageOk,
    `textures must survive override removal; got ${JSON.stringify(restored)}`,
  ).toBe(true);
  expect(restored.color).toBe(importedColor);

  expect(loaderErrors, `unexpected loader console errors: ${loaderErrors.join('\n')}`).toEqual([]);
});
