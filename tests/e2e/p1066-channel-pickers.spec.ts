// #1066 — a keyframe channel's target and path, picked in the running app.
//
// Each picker is driven through the real <select>, and the effect is read off the drawn
// three.js scene, not the DAG: a path that nothing reads would still pass a DAG read (#1235).

import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState(): {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      dispatch: (op: unknown, src: string, d: string) => void;
    };
  };
  __basher_selection: { getState(): { select: (id: string) => void } };
  __basher_time: { getState(): { setTime: (t: number) => void } };
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

const at = (page: Page, t: number) =>
  page.evaluate((s) => (window as unknown as W).__basher_time.getState().setTime(s), t);

test('a channel picks a spot light and its intensity from the pickers, and the drawn light follows', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  const spot = await page.evaluate(() =>
    (window as unknown as W).__basher_addPrimitive('SpotLight', [0, 3, 0]),
  );
  expect(spot?.dataNodeId, 'the spot light has a data node').toBeTruthy();
  const data = spot!.dataNodeId!;

  // An unwired channel, keyed low → high, the way the dopesheet leaves one before it is aimed.
  await dispatch(page, {
    type: 'addNode',
    nodeId: 'ch_e2e',
    nodeType: 'KeyframeChannelNumber',
    params: {
      name: 'glow',
      keyframes: [
        { time: 0, value: 0.5, easing: 'linear' },
        { time: 2, value: 40, easing: 'linear' },
      ],
    },
  });
  await page.evaluate(() =>
    (window as unknown as W).__basher_selection.getState().select('ch_e2e'),
  );

  const targetId = 'inspector-options-ch_e2e-target';
  const pathId = 'inspector-options-ch_e2e-paramPath';
  const targets = await shown(page, targetId);
  expect(targets.enabled, 'the spot light data is offered to a number channel').toContain(data);

  // Control: aimed at the light with no path, nothing moves between the two times.
  await page.getByTestId(targetId).selectOption(data);
  await at(page, 0);
  const still0 = await drawnSpotIntensities(page);
  await at(page, 2);
  await expect.poll(() => drawnSpotIntensities(page), 'no path, no motion').toEqual(still0);

  const paths = await shown(page, pathId);
  expect(paths.enabled).toEqual(expect.arrayContaining(['intensity', 'angle', 'penumbra']));
  // Only what the census measured to draw: a spot light's width is not offered.
  expect(paths.enabled).not.toContain('width');

  await page.getByTestId(pathId).selectOption('intensity');
  await at(page, 0);
  await expect.poll(() => drawnSpotIntensities(page)).not.toEqual(still0);
  const lit0 = await drawnSpotIntensities(page);
  await at(page, 2);
  await expect
    .poll(() => drawnSpotIntensities(page), 'the drawn light follows the key')
    .not.toEqual(lit0);
  const lit2 = await drawnSpotIntensities(page);
  expect(Math.max(...lit2)).toBeGreaterThan(Math.max(...lit0));
  expect(errors, 'no page errors').toEqual([]);
});

test('a path nothing draws is listed with why, and a target nobody measured is read-only', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  // A point light has no cone: on it, `angle` is listed, disabled, with why — beside what does draw.
  const point = await page.evaluate(() =>
    (window as unknown as W).__basher_addPrimitive('PointLight', [0, 3, 0]),
  );
  await dispatch(page, {
    type: 'addNode',
    nodeId: 'cone_e2e',
    nodeType: 'KeyframeChannelNumber',
    params: { target: point!.dataNodeId, paramPath: 'angle' },
  });
  await page.evaluate(() =>
    (window as unknown as W).__basher_selection.getState().select('cone_e2e'),
  );
  await expect
    .poll(() => shown(page, 'inspector-options-cone_e2e-paramPath'))
    .toMatchObject({
      value: 'angle',
      selectedText: 'angle — nothing drawn changes',
      enabled: expect.arrayContaining(['intensity']),
    });

  // A Track-To's aim point is read raw, and none of its vec3 params draws: nothing to pick,
  // so the path is shown read-only with the measured answer.
  await dispatch(page, { type: 'addNode', nodeId: 'tt_e2e', nodeType: 'TrackTo', params: {} });
  await dispatch(page, {
    type: 'addNode',
    nodeId: 'aim_e2e',
    nodeType: 'KeyframeChannelVec3',
    params: { target: 'tt_e2e', paramPath: 'aimPoint' },
  });
  await page.evaluate(() =>
    (window as unknown as W).__basher_selection.getState().select('aim_e2e'),
  );
  const aim = page.getByTestId('inspector-options-locked-aim_e2e-paramPath');
  await expect(aim).toContainText('aimPoint');
  await expect(aim).toContainText('no vec3 param of TrackTo animates');

  // A Shot was never placed by the census: the path is shown read-only, saying so.
  await dispatch(page, { type: 'addNode', nodeId: 'shot_e2e', nodeType: 'Shot', params: {} });
  await dispatch(page, {
    type: 'addNode',
    nodeId: 'shotch_e2e',
    nodeType: 'KeyframeChannelNumber',
    params: { target: 'shot_e2e', paramPath: 'duration' },
  });
  await page.evaluate(() =>
    (window as unknown as W).__basher_selection.getState().select('shotch_e2e'),
  );
  const locked = page.getByTestId('inspector-options-locked-shotch_e2e-paramPath');
  await expect(locked).toContainText('duration');
  await expect(locked).toContainText('the census has not measured Shot');
  await expect(page.getByTestId('inspector-options-shotch_e2e-paramPath')).toHaveCount(0);
  expect(errors, 'no page errors').toEqual([]);
});
