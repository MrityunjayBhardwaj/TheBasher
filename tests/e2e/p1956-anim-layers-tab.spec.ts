// #1956 — the drawer's Anim Layers tab: the selected character's pose layers as lanes over time.
//
// The native skinned bar (Blender's own export) imports as an armature whose pose reads a base layer
// holding the file's keys. Through the tab alone: two layers are added (the newer on top, applied
// last), the playhead crosses the lanes and follows the time, a layer's weight is edited in the tab
// and is the layer's own value, a keyed weight is said in its lane (no curve drawn), Delete takes one
// out, Bake down folds the other into a new base. With nothing selected, or the cube selected, the
// tab says why it lists nothing and offers no Add.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';

interface Node {
  type: string;
  inputs: Record<string, unknown>;
  params: Record<string, unknown>;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } }; nodes: Record<string, Node> };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
}

async function importBar(page: Page): Promise<{ armature: string; base: string }> {
  return page.evaluate(async () => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1956/skinned-bar.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const nodes = w.__basher_dag.getState().state.nodes;
    const mod = Object.values(nodes).find((n) => n.type === 'ArmatureModifier')!;
    const armature = (mod.inputs.armature as { node: string }).node;
    const base = (nodes[armature].inputs.pose as { node: string }).node;
    return { armature, base };
  });
}

const select = (page: Page, id: string | null) =>
  page.evaluate((x) => (window as unknown as W).__basher_selection.getState().select(x), id);

/** The pose layers on the armature's wire, from the Object down. */
const chain = (page: Page, armature: string) =>
  page.evaluate((id) => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    const out: string[] = [];
    let at = (nodes[id].inputs.pose as { node?: string } | undefined)?.node;
    while (at && nodes[at]?.type === 'PoseLayer') {
      out.push(at);
      at = (nodes[at].inputs.pose as { node?: string } | undefined)?.node;
    }
    return out;
  }, armature);

const params = (page: Page, id: string) =>
  page.evaluate((x) => (window as unknown as W).__basher_dag.getState().state.nodes[x]?.params, id);

async function openTab(page: Page) {
  await page.getByTestId('timeline-drawer-toggle').click();
  await page.getByTestId('timeline-tab-animLayers').click();
  await expect(page.getByTestId('anim-layers-pane')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
});

test('Anim Layers sits between NLA and Curves', async ({ page }) => {
  await page.getByTestId('timeline-drawer-toggle').click();
  const labels = await page.getByTestId('timeline-tab-strip').getByRole('tab').allTextContents();
  expect(labels.indexOf('Anim Layers')).toBe(labels.indexOf('NLA') + 1);
  expect(labels.indexOf('Curves')).toBe(labels.indexOf('Anim Layers') + 1);
});

test('with nothing selected, or an object that is no character, it says so and offers no Add', async ({
  page,
}) => {
  await select(page, null);
  await openTab(page);
  await expect(page.getByTestId('anim-layers-empty')).toHaveAttribute(
    'data-reason',
    'nothing-selected',
  );
  await expect(page.getByTestId('anim-layers-add')).toHaveCount(0);
  const cube = await page.evaluate(
    () =>
      Object.entries((window as unknown as W).__basher_dag.getState().state.nodes).find(
        ([, n]) => n.type === 'Object',
      )![0],
  );
  await select(page, cube);
  await expect(page.getByTestId('anim-layers-empty')).toHaveAttribute(
    'data-reason',
    'not-a-character',
  );
  await expect(page.getByTestId('anim-layers-empty')).toContainText('has no pose layers');
  await expect(page.getByTestId('anim-layers-add')).toHaveCount(0);
});

test('a character’s layers: added on top, the playhead crosses them, edits are the layer’s own', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { armature, base } = await importBar(page);
  await select(page, armature);
  await openTab(page);

  // A fresh import: no rows above the locked base.
  await expect(page.getByTestId('anim-layers-base')).toContainText('Base');
  await expect(page.getByTestId('anim-layers-base')).toContainText('locked');
  await expect(page.locator('[data-testid^="anim-layers-row-"]')).toHaveCount(0);

  // Two layers through + Add Layer: the newer is on top, which is the one the Object reads first.
  await page.getByTestId('anim-layers-add').click();
  await expect(page.locator('[data-testid^="anim-layers-row-"]')).toHaveCount(1);
  await page.getByTestId('anim-layers-add').click();
  await expect(page.locator('[data-testid^="anim-layers-row-"]')).toHaveCount(2);
  const wire = await chain(page, armature);
  expect(wire).toHaveLength(3);
  expect(wire[2]).toBe(base);
  const shown = await page
    .locator('[data-testid^="anim-layers-row-"]')
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-testid')!.slice('anim-layers-row-'.length)),
    );
  expect(shown).toEqual([wire[0], wire[1]]);
  const [top, lower] = wire;
  // The layer just added is the picked one.
  await expect(page.getByTestId(`anim-layers-row-${top}`)).toHaveAttribute('data-selected', 'true');

  // The playhead crosses the lanes and follows the time.
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(0));
  const t0 = Number(await page.getByTestId('anim-layers-playhead').getAttribute('data-t'));
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(2));
  await expect(page.getByTestId('anim-layers-playhead')).not.toHaveAttribute(
    'data-t',
    t0.toFixed(4),
  );
  const t2 = Number(await page.getByTestId('anim-layers-playhead').getAttribute('data-t'));
  expect(t2).toBeGreaterThan(t0);
  const lane = await page.getByTestId(`anim-layers-lane-${top}`).boundingBox();
  const head = await page.getByTestId('anim-layers-playhead').boundingBox();
  expect(head!.y).toBeLessThanOrEqual(lane!.y);
  expect(head!.y + head!.height).toBeGreaterThanOrEqual(lane!.y + lane!.height);

  // Pick the lower layer and edit its weight in the tab: it is the layer's own param.
  await page.getByTestId(`anim-layers-row-${lower}`).getByRole('button').click();
  await expect(page.getByTestId(`anim-layers-row-${lower}`)).toHaveAttribute(
    'data-selected',
    'true',
  );
  const weight = page
    .getByTestId('anim-layers-settings')
    .getByTestId(`inspector-input-${lower}-weight`);
  await weight.fill('0.4');
  await expect.poll(async () => (await params(page, lower))?.weight).toBe(0.4);
  await expect(page.getByTestId(`anim-layers-row-${lower}`)).toContainText('0.40');
  await expect(page.getByTestId(`anim-layers-lane-${lower}`)).toHaveAttribute(
    'data-keyed',
    'false',
  );

  // A layer added while another is picked becomes the picked one; Delete then takes it out again.
  await page.getByTestId('anim-layers-add').click();
  await expect(page.locator('[data-testid^="anim-layers-row-"]')).toHaveCount(3);
  const newest = (await chain(page, armature))[0];
  await expect(page.getByTestId(`anim-layers-row-${newest}`)).toHaveAttribute(
    'data-selected',
    'true',
  );
  await page.getByTestId('anim-layers-delete').click();
  await expect(page.locator('[data-testid^="anim-layers-row-"]')).toHaveCount(2);
  expect(await chain(page, armature)).toEqual([top, lower, base]);

  // A layer whose weight is keyed says so in its lane, and draws no curve it does not have. The keys
  // are written as the layer holds them (a `weight` channel inside it): keying the weight from its
  // row does nothing yet (#1958), so this spec does not press I.
  await page.evaluate((id) => {
    const dag = (window as unknown as W).__basher_dag.getState();
    dag.dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: id,
          paramPath: 'channels',
          value: [
            {
              bone: '',
              component: 'weight',
              keyframes: [
                { time: 0, value: 0 },
                { time: 1, value: 1 },
              ],
            },
          ],
        },
      ],
      'user',
      'key layer weight (spec)',
    );
  }, lower);
  await expect(page.getByTestId(`anim-layers-lane-${lower}`)).toHaveAttribute('data-keyed', 'true');
  await expect(page.getByTestId(`anim-layers-lane-${lower}`)).toContainText('2 keys');
  await expect(page.getByTestId('anim-layers').locator('svg polyline')).toHaveCount(0);

  // Delete takes the top layer out and joins the wire back up.
  await page.getByTestId(`anim-layers-row-${top}`).getByRole('button').click();
  await page.getByTestId('anim-layers-delete').click();
  await expect(page.locator('[data-testid^="anim-layers-row-"]')).toHaveCount(1);
  expect(await chain(page, armature)).toEqual([lower, base]);

  // The base is locked: picking it leaves nothing to delete or bake.
  await page.getByTestId('anim-layers-base').getByRole('button').click();
  await expect(page.getByTestId('anim-layers-delete')).toBeDisabled();
  await expect(page.getByTestId('anim-layers-bake')).toBeDisabled();

  // Bake down at the remaining layer: it and the base are folded into a new base and muted.
  await page.getByTestId(`anim-layers-row-${lower}`).getByRole('button').click();
  await page.getByTestId('anim-layers-bake').click();
  await expect.poll(async () => (await params(page, lower))?.mute).toBe(true);
  expect((await params(page, base))?.mute).toBe(true);
  await expect(page.getByTestId('anim-layers-notice')).toHaveCount(0);

  // The filter narrows the rows by name.
  await page.getByTestId('anim-layers-filter').fill('zzz-no-such-layer');
  await expect(page.locator('[data-testid^="anim-layers-row-"]')).toHaveCount(0);
  await expect(page.getByTestId('anim-layers-base')).toBeVisible();
});
