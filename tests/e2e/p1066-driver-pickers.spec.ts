// #1066 — a ParamDriver's target and path, picked in the running app from the census's DRIVER
// answers (#1258), which are not the channel's: the camera pose ignores a driver (#1266).
//
// Each picker is driven through the real <select>, and the effect is read off the drawn
// three.js scene, not the DAG: a driver on a param nothing reads would still pass a DAG read.

import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState(): { dispatch: (op: unknown, src: string, d: string) => void };
  };
  __basher_selection: { getState(): { select: (id: string) => void } };
  __basher_addPrimitive: (
    kind: string,
    at: [number, number, number],
  ) => { nodeId: string; dataNodeId: string | null } | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __basher_three: { getState(): { scene: any } };
}

async function boot(page: Page) {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(w.__basher_selection && w.__basher_addPrimitive && w.__basher_three);
  });
}

function dispatch(page: Page, op: unknown) {
  return page.evaluate(
    (o) => (window as unknown as W).__basher_dag.getState().dispatch(o, 'user', 'e2e'),
    op,
  );
}

const select = (page: Page, id: string) =>
  page.evaluate((n) => (window as unknown as W).__basher_selection.getState().select(n), id);

function shown(page: Page, testid: string) {
  return page.getByTestId(testid).evaluate((el) => {
    const s = el as HTMLSelectElement;
    return {
      value: s.value,
      selectedText: s.selectedIndex >= 0 ? s.options[s.selectedIndex].text : null,
      enabled: [...s.options].filter((o) => !o.disabled).map((o) => o.value),
      disabled: [...s.options].filter((o) => o.disabled).map((o) => o.text),
    };
  });
}

/** Every drawn SpotLight's intensity, read off the viewport's three.js scene. */
const drawnSpotIntensities = (page: Page) =>
  page.evaluate(() => {
    const out: number[] = [];
    (window as unknown as W).__basher_three
      .getState()
      .scene?.traverse((o: { isSpotLight?: boolean; intensity?: number }) => {
        if (o.isSpotLight) out.push(Math.round((o.intensity ?? 0) * 1e4) / 1e4);
      });
    return out.sort((a, b) => a - b);
  });

test('a driver picks a spot light and its intensity from the pickers, and the drawn light follows its controller', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  const spot = await page.evaluate(() =>
    (window as unknown as W).__basher_addPrimitive('SpotLight', [0, 3, 0]),
  );
  const ctl = await page.evaluate(() =>
    (window as unknown as W).__basher_addPrimitive('Null', [0, 0, 0]),
  );
  expect(spot?.dataNodeId, 'the spot light has a data node').toBeTruthy();
  const data = spot!.dataNodeId!;

  // An unaimed driver reading the controller's X, mapped 0..1 → 2..40.
  await dispatch(page, {
    type: 'addNode',
    nodeId: 'drv_e2e',
    nodeType: 'ParamDriver',
    params: {
      sourceTransform: {
        node: ctl!.nodeId,
        channel: 'tx',
        remap: { inMin: 0, inMax: 1, outMin: 2, outMax: 40 },
      },
    },
  });
  await select(page, 'drv_e2e');

  const targetId = 'inspector-options-drv_e2e-target';
  const pathId = 'inspector-options-drv_e2e-paramPath';
  const targets = await shown(page, targetId);
  expect(targets.enabled, 'the spot light data is offered to a number driver').toContain(data);

  // Control: aimed at the light with no path, moving the controller moves nothing.
  await page.getByTestId(targetId).selectOption(data);
  const still = await drawnSpotIntensities(page);
  await dispatch(page, {
    type: 'setParam',
    nodeId: ctl!.nodeId,
    paramPath: 'position',
    value: [1, 0, 0],
  });
  await expect.poll(() => drawnSpotIntensities(page), 'no path, no motion').toEqual(still);

  const paths = await shown(page, pathId);
  expect(paths.enabled).toEqual(expect.arrayContaining(['intensity', 'angle', 'penumbra']));
  // A transform channel is a number: no vec3 path is offered.
  expect(paths.enabled).not.toContain('position');

  await page.getByTestId(pathId).selectOption('intensity');
  await expect
    .poll(() => drawnSpotIntensities(page), 'the driven light reads the controller (x=1 → 40)')
    .toContain(40);
  await dispatch(page, {
    type: 'setParam',
    nodeId: ctl!.nodeId,
    paramPath: 'position',
    value: [0, 0, 0],
  });
  await expect.poll(() => drawnSpotIntensities(page), 'and follows it back (x=0 → 2)').toContain(2);
  expect(errors, 'no page errors').toEqual([]);
});

test("a camera's fov is offered to a channel, and read-only with why to a driver", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  const cam = await page.evaluate(() =>
    (window as unknown as W).__basher_addPrimitive('PerspectiveCamera', [0, 2, 8]),
  );
  const data = cam!.dataNodeId!;

  // The channel control: a number channel on the same camera is offered fov.
  await dispatch(page, {
    type: 'addNode',
    nodeId: 'fovch_e2e',
    nodeType: 'KeyframeChannelNumber',
    params: { target: data, paramPath: '' },
  });
  await select(page, 'fovch_e2e');
  await expect
    .poll(async () => (await shown(page, 'inspector-options-fovch_e2e-paramPath')).enabled)
    .toContain('fov');

  // The driver: the census measured a driver move no param of a perspective camera's data
  // (the pose ignores drivers, #1266), so there is nothing to offer — the path is read-only
  // with that answer, and the camera is disabled in the target list.
  await dispatch(page, {
    type: 'addNode',
    nodeId: 'fovdrv_e2e',
    nodeType: 'ParamDriver',
    params: { target: data, paramPath: 'fov' },
  });
  await select(page, 'fovdrv_e2e');
  const locked = page.getByTestId('inspector-options-locked-fovdrv_e2e-paramPath');
  await expect(locked).toContainText('fov');
  await expect(locked).toContainText(
    'a driver moves no number or vec3 param of CameraData:Perspective',
  );
  await expect(page.getByTestId('inspector-options-fovdrv_e2e-paramPath')).toHaveCount(0);
  const targets = await shown(page, 'inspector-options-fovdrv_e2e-target');
  expect(targets.enabled).not.toContain(data);
  expect(errors, 'no page errors').toEqual([]);
});
