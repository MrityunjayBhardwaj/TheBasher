// #1765 — a file saved when a sun shone down its −Y, whose sun has keyed rotation, opens with its
// keys kept as they were and a warning on screen naming that sun: while those keys play it now
// shines a quarter turn off. A file whose sun is still opens with no such warning.
//
// Driven through the app's own scene import (the road Open Scene takes). The bundle is the
// current scene written back as format 26 with one sun added, so the v26 → v27 step runs on it.
// Falsified by dropping the notice call from `migrateLightAimToTurn`: the warning never shows.

import { expect, test } from './_fixtures';

interface W {
  __basher_dag: { getState(): { state: { nodes: Record<string, unknown>; outputs: unknown } } };
  __basher_import_scene_bundle: (b: unknown) => Promise<string>;
}

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(w.__basher_dag && w.__basher_import_scene_bundle);
  });
}

/** Import the current scene, written as format 26, with a sun `sunId` added (keyed or still). */
async function importV26WithSun(
  page: import('@playwright/test').Page,
  sunId: string,
  keyed: boolean,
) {
  await page.evaluate(
    async ({ sunId, keyed }) => {
      const w = window as unknown as W;
      const { state } = w.__basher_dag.getState();
      const nodes: Record<string, unknown> = {
        ...structuredClone(state.nodes),
        [`${sunId}_data`]: {
          id: `${sunId}_data`,
          type: 'LightData',
          version: 1,
          params: { lightKind: 'Directional', intensity: 1, color: '#ffffff' },
          inputs: {},
        },
        [sunId]: {
          id: sunId,
          type: 'Object',
          version: 1,
          params: { position: [4, 6, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
          inputs: { data: { node: `${sunId}_data`, socket: 'out' } },
        },
      };
      if (keyed)
        nodes[`${sunId}_rot`] = {
          id: `${sunId}_rot`,
          type: 'KeyframeChannelVec3',
          version: 1,
          params: {
            name: 'rotation',
            target: sunId,
            paramPath: 'rotation',
            keyframes: [
              { time: 0, value: [0, 0, 0], easing: 'linear' },
              { time: 2, value: [40, 10, 0], easing: 'linear' },
            ],
          },
          inputs: {},
        };
      const scene = (state.outputs as { scene: { node: string } }).scene.node;
      const sceneNode = nodes[scene] as { inputs: Record<string, unknown> };
      const lights = sceneNode.inputs.lights;
      sceneNode.inputs.lights = [
        ...(Array.isArray(lights) ? lights : lights ? [lights] : []),
        { node: sunId, socket: 'out' },
      ];
      await w.__basher_import_scene_bundle({
        formatVersion: 26,
        bundleVersion: 1,
        id: 'p1765-keyed-sun',
        name: 'p1765 keyed sun',
        exportedAt: 0,
        state: { ...state, nodes },
      });
    },
    { sunId, keyed },
  );
}

test('a v26 sun with keyed rotation opens with a warning that names it', async ({ page }) => {
  await boot(page);
  await importV26WithSun(page, 'keyed_sun', true);
  const warning = page.getByTestId('toast-warn').filter({ hasText: '"keyed_sun"' });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('quarter turn');
  // Its keys are kept as they were.
  const kept = await page.evaluate(
    () =>
      (
        (window as unknown as W).__basher_dag.getState().state.nodes.keyed_sun_rot as {
          params: { keyframes: { value: number[] }[] };
        }
      ).params.keyframes[1].value,
  );
  expect(kept).toEqual([40, 10, 0]);
});

test('a v26 sun that is still opens with no such warning', async ({ page }) => {
  await boot(page);
  await importV26WithSun(page, 'still_sun', false);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean((window as unknown as W).__basher_dag.getState().state.nodes.still_sun),
      ),
    )
    .toBe(true);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('toast-warn').filter({ hasText: 'quarter turn' })).toHaveCount(0);
});
