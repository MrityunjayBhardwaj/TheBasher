// #1259 — a Quat channel's target and path, picked in the running app. The census measures every
// posable node in both rotation modes, so a quaternion is offered where the node composes it,
// and a vec3 channel is no longer offered `rotation` there (quaternion mode overwrites it).
//
// Driven through the real <select>s; the effect is read off the drawn three.js scene.

import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';

interface W {
  __basher_dag: { getState(): { dispatch: (op: unknown, src: string, d: string) => void } };
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

const dispatch = (page: Page, op: unknown) =>
  page.evaluate(
    (o) => (window as unknown as W).__basher_dag.getState().dispatch(o, 'user', 'e2e'),
    op,
  );
const select = (page: Page, id: string) =>
  page.evaluate((n) => (window as unknown as W).__basher_selection.getState().select(n), id);
const at = (page: Page, t: number) =>
  page.evaluate((s) => (window as unknown as W).__basher_time.getState().setTime(s), t);

function shown(page: Page, testid: string) {
  return page.getByTestId(testid).evaluate((el) => {
    const s = el as HTMLSelectElement;
    return {
      value: s.value,
      selectedText: s.selectedIndex >= 0 ? s.options[s.selectedIndex].text : null,
      enabled: [...s.options].filter((o) => !o.disabled).map((o) => o.value),
    };
  });
}

/** Every drawn mesh's world orientation, rounded — what a rotation key moves. */
const drawnOrientations = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    const scene = (window as unknown as W).__basher_three.getState().scene;
    scene?.updateMatrixWorld(true);
    scene?.traverse((o: { isMesh?: boolean; matrixWorld: { elements: number[] } }) => {
      if (o.isMesh)
        out.push(
          o.matrixWorld.elements
            .slice(0, 11)
            .map((v) => Math.round(v * 1e3) / 1e3)
            .join(','),
        );
    });
    return out.sort();
  });

test('a quat channel picks a quaternion-mode sphere and its quaternion, and the drawn mesh turns', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  const sphere = await page.evaluate(() =>
    (window as unknown as W).__basher_addPrimitive('Sphere', [0, 1, 0]),
  );
  const obj = sphere!.nodeId;
  // The mode switch the NPanel makes: the identity quaternion, then the mode.
  await dispatch(page, {
    type: 'setParam',
    nodeId: obj,
    paramPath: 'quaternion',
    value: [0, 0, 0, 1],
  });
  await dispatch(page, {
    type: 'setParam',
    nodeId: obj,
    paramPath: 'rotationMode',
    value: 'quaternion',
  });

  await dispatch(page, {
    type: 'addNode',
    nodeId: 'q_e2e',
    nodeType: 'KeyframeChannelQuat',
    params: {
      keyframes: [
        { time: 0, value: [0, 0, 0, 1], easing: 'linear' },
        { time: 2, value: [0, 0.7071, 0, 0.7071], easing: 'linear' },
      ],
    },
  });
  await select(page, 'q_e2e');
  const targets = await shown(page, 'inspector-options-q_e2e-target');
  expect(targets.enabled, 'the quaternion-mode sphere is offered to a quat channel').toContain(obj);

  // Control: aimed at the sphere with no path, nothing turns between the two times.
  await page.getByTestId('inspector-options-q_e2e-target').selectOption(obj);
  await at(page, 0);
  const still0 = await drawnOrientations(page);
  await at(page, 2);
  await expect.poll(() => drawnOrientations(page), 'no path, no turn').toEqual(still0);

  const paths = await shown(page, 'inspector-options-q_e2e-paramPath');
  // Exactly the quaternion (beside the empty choice): position/scale are vec3, not quat.
  expect(paths.enabled.filter((v) => v !== '')).toEqual(['quaternion']);
  await page.getByTestId('inspector-options-q_e2e-paramPath').selectOption('quaternion');
  await at(page, 0);
  await expect.poll(() => drawnOrientations(page)).toEqual(still0);
  await at(page, 2);
  await expect
    .poll(() => drawnOrientations(page), 'the drawn sphere turns with the key')
    .not.toEqual(still0);

  // And a vec3 channel on the same sphere lists `rotation` as still: quaternion mode draws the
  // quaternion, not the euler rotation.
  await dispatch(page, {
    type: 'addNode',
    nodeId: 'rot_e2e',
    nodeType: 'KeyframeChannelVec3',
    params: { target: obj, paramPath: 'rotation' },
  });
  await select(page, 'rot_e2e');
  await expect
    .poll(() => shown(page, 'inspector-options-rot_e2e-paramPath'))
    .toMatchObject({ value: 'rotation', selectedText: 'rotation — nothing drawn changes' });
  expect((await shown(page, 'inspector-options-rot_e2e-paramPath')).enabled).toEqual(
    expect.arrayContaining(['position', 'scale']),
  );
  expect(errors, 'no page errors').toEqual([]);
});
