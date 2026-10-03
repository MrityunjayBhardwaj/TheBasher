// #1434 — an FBX with no bone, brought in through the product's own door (File ▸ Import Folder…, the
// OS file chooser), lands as a MODEL: its Objects standing in the scene as Blender stands them, with
// no wrapper Group (#1451), no Skeleton and no pose layer, and the hierarchy, the placement at two
// frames and the material are Blender's. Saved and reloaded, all of it still is.
//
// The oracle is Blender 5.1.1 importing its own default export of the scene
// (`ref/probes/blender-armature-deform/q20_fbx_rigless_fixture.py` makes the file,
// `q21_fbx_rigless_oracle.py` records the objects, `q28_fbx_rigless_material_oracle.py` the
// material): an Empty `Holder` over a keyed `Cube` over a `Cone`, and a loose `Plane` whose material
// Blender's import reads as base colour 0.8 grey, metallic 0, roughness 0.5.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { drawnImportMeshes } from './_importedMesh';

const FIXTURE = 'src/core/import/__fixtures__/rigless-hierarchy-blender-default.fbx';
const ORACLE = 'src/core/import/__fixtures__/blender-oracle-fbx-rigless-hierarchy.json';

interface Node {
  type: string;
  params: Record<string, unknown>;
  meta?: { name?: string };
  inputs: Record<string, unknown>;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, Node>; outputs: { scene?: { node: string } } };
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_world_transform: (
    id: string,
    ctx: unknown,
  ) => { position: [number, number, number] } | null;
  __basher_mesh_world_position: (id: string) => [number, number, number] | null;
}

type Objects = Record<
  string,
  {
    parent: string | null;
    frames: Record<string, { world_translation: [number, number, number] }>;
  }
>;
const BLENDER = (JSON.parse(readFileSync(ORACLE, 'utf8')) as { objects: Objects }).objects;
const NAMES = Object.keys(BLENDER).sort();

/** Blender's Plane material after its FBX import, drawn as three draws it: sRGB of the linear 0.8. */
const srgb = (linear: number) =>
  Math.round(255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055));
const PLANE_MATERIAL = {
  color: `#${srgb(0.8).toString(16).repeat(3)}`,
  metalness: 0,
  roughness: 0.5,
  hasMap: false,
};

/** The node ids of the file's Objects and the Group, by name. */
const idsByName = (page: Page) =>
  page.evaluate((names) => {
    const { nodes } = (window as unknown as BasherWindow).__basher_dag.getState().state;
    const out: Record<string, string[]> = {};
    for (const name of names) {
      out[name] = Object.entries(nodes)
        .filter(([, n]) => (n.type === 'Object' || n.type === 'Group') && n.meta?.name === name)
        .map(([id]) => id);
    }
    return out;
  }, NAMES);

/** Every outliner row, expanded, as `[nodeId, depth]` in the order the outliner lists them. */
async function outlinerRows(page: Page): Promise<[string, number][]> {
  for (;;) {
    const collapsed = page.locator('[data-testid^="scene-tree-row-"][data-expanded="false"]');
    if ((await collapsed.count()) === 0) break;
    const id = (await collapsed.first().getAttribute('data-testid'))!.slice(
      'scene-tree-row-'.length,
    );
    await page.getByTestId(`scene-tree-toggle-${id}`).click();
  }
  return page
    .locator('[data-testid^="scene-tree-row-"]')
    .evaluateAll((rows) =>
      rows.map((r) => [
        r.getAttribute('data-testid')!.slice('scene-tree-row-'.length),
        Number(r.getAttribute('data-depth')),
      ]),
    );
}

/** The row each row hangs under: the nearest row above it one level up. */
function outlinerParents(rows: [string, number][]): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  rows.forEach(([id, depth], i) => {
    let at = i - 1;
    while (at >= 0 && rows[at][1] >= depth) at -= 1;
    parents.set(id, at >= 0 ? rows[at][0] : null);
  });
  return parents;
}

async function setFrame(page: Page, frame: number): Promise<void> {
  await page.evaluate(
    (s) => (window as unknown as BasherWindow).__basher_time.getState().setTime(s),
    (frame - 1) / 24,
  );
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

/** Everything the import must be, read off the live product. Run after the import and after a reload. */
async function expectAsBlender(page: Page, when: string): Promise<void> {
  const ids = await idsByName(page);
  for (const name of NAMES) expect(ids[name], `${when}: one node named ${name}`).toHaveLength(1);
  const id = (name: string) => ids[name][0];

  // A model: no Skeleton, no pose layer, and no Group but the file's own Empty (`Holder`).
  const landed = await page.evaluate(() => {
    const { nodes, outputs } = (window as unknown as BasherWindow).__basher_dag.getState().state;
    return {
      types: Object.values(nodes).map((n) => n.type),
      groups: Object.keys(nodes).filter((c) => nodes[c].type === 'Group'),
      scene: outputs.scene!.node,
    };
  });
  expect(landed.types, when).not.toContain('Skeleton');
  expect(landed.types, when).not.toContain('PoseLayer');
  expect(landed.groups, `${when}: only the file's Empty is a Group`).toEqual([id('Holder')]);

  // The outliner shows Blender's hierarchy, the file's top-level Objects under the scene.
  const parents = outlinerParents(await outlinerRows(page));
  for (const name of NAMES) {
    const want = BLENDER[name].parent === null ? landed.scene : id(BLENDER[name].parent!);
    expect(parents.get(id(name)), `${when}: ${name}'s outliner parent`).toBe(want);
  }

  // Every Object stands where Blender stands it, as resolved and as drawn, at frames 1 and 25 (the
  // Cube is keyed a unit up between them, and carries the Cone).
  for (const frame of [1, 25]) {
    await setFrame(page, frame);
    for (const name of NAMES) {
      const [x, y, z] = BLENDER[name].frames[String(frame)].world_translation;
      const want = [x, z, -y];
      const placed = await page.evaluate(
        ({ id, frame }) => {
          const w = window as unknown as BasherWindow;
          const ctx = { time: { frame, seconds: (frame - 1) / 24, normalized: 0 } };
          const resolved = w.__basher_world_transform(id, ctx)?.position ?? null;
          const isObject = w.__basher_dag.getState().state.nodes[id].type === 'Object';
          return { resolved, drawn: isObject ? w.__basher_mesh_world_position(id) : null };
        },
        { id: id(name), frame },
      );
      const label = `${when}: ${name} at frame ${frame}`;
      expect(placed.resolved, `${label}, resolved`).not.toBeNull();
      placed.resolved!.forEach((c, k) =>
        expect(c, `${label}, resolved ${k}`).toBeCloseTo(want[k], 3),
      );
      if (name !== 'Holder') {
        expect(placed.drawn, `${label}, drawn`).not.toBeNull();
        placed.drawn!.forEach((c, k) => expect(c, `${label}, drawn ${k}`).toBeCloseTo(want[k], 3));
      }
    }
  }

  // The Plane draws Blender's material.
  const plane = (await drawnImportMeshes(page, id('Plane'))).map((m) => ({
    color: m.color,
    metalness: m.metalness,
    roughness: m.roughness,
    hasMap: m.hasMap,
  }));
  expect(plane, `${when}: the Plane's material`).toEqual([PLANE_MATERIAL]);
}

test('#1434 — an FBX with no bone, picked through Import Folder, lands as Blender’s model, and still does after a reload', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebGL|GPU/i.test(m.text())) errors.push(m.text());
  });

  // The folder the user picks: the file alone in it.
  const folder = testInfo.outputPath('rigless');
  mkdirSync(folder, { recursive: true });
  copyFileSync(FIXTURE, join(folder, 'rigless.fbx'));

  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('menu-file-button').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('menu-file-import').click(),
  ]);
  await chooser.setFiles(folder);

  await expect
    .poll(async () => Object.values(await idsByName(page)).map((ids) => ids.length), {
      message: 'the file’s Objects land',
      timeout: 15_000,
    })
    .toEqual(NAMES.map(() => 1));
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
  await expectAsBlender(page, 'after the import');

  await page.evaluate(async () => {
    const boot = await import('/src/app/boot.ts');
    await boot.saveCurrent();
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => Object.values(await idsByName(page)).map((ids) => ids.length), {
      message: 'the file’s Objects come back',
      timeout: 15_000,
    })
    .toEqual(NAMES.map(() => 1));
  await expectAsBlender(page, 'after a reload');
  expect(errors).toEqual([]);
});
