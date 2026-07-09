// p280 (#280, V88 D2) — PER-AXIS (independent) vec F-Modifier stacks. A vec channel's
// shared `modifiers` apply to every component; #280 adds an optional per-axis OVERRIDE
// (axisModifiers[i]) so a modifier can move ONE axis alone (Blender: each axis is its own
// F-curve). Two boundary-pairs on a flat [5,5,5] position channel: (A) a per-axis Generator
// on X alone → X=15, Y/Z=5, render==read (H40), and clearing the override reverts (falsify);
// (B) the SHARED stack still drives ALL axes (guards the ModifierList refactor).
import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => { dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void };
  };
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_mesh_world_position?: (id: string) => [number, number, number] | null;
  __basher_evaluated_transform?: (
    id: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { position: [number, number, number] } | null;
}
const CH = 'p280_ch';

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* ignore */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_dag && w.__basher_time && w.__basher_mesh_world_position);
  });
  await page.waitForFunction(
    () => (window as unknown as W).__basher_mesh_world_position!('n_box') !== null,
  );
  await page.evaluate((ch) => {
    const w = window as unknown as W;
    w.__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: ch,
          nodeType: 'KeyframeChannelVec3',
          params: {
            name: 'position',
            target: 'n_box',
            paramPath: 'position',
            keyframes: [
              { time: 0, value: [5, 5, 5], easing: 'linear' },
              { time: 4, value: [5, 5, 5], easing: 'linear' },
            ],
          },
        },
      ],
      'user',
      'p280-seed',
    );
    w.__basher_selection.getState().select(ch);
  }, CH);
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(1));
}

const pos = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as W).__basher_mesh_world_position!('n_box'));
const readPos = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const t = (window as unknown as W).__basher_evaluated_transform!('n_box', {
      time: { frame: 60, seconds: 1, normalized: 0 },
    });
    return t ? t.position : null;
  });

async function openAnimate(page: import('@playwright/test').Page) {
  const toggle = page.getByTestId('inspector-section-toggle-animate');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  return page.getByTestId('inspector-section-body-animate');
}

test('a per-axis Generator on X alone moves X; Y/Z unchanged; render == read; clear reverts', async ({
  page,
}) => {
  await boot(page);
  const body = await openAnimate(page);

  // Override X (default-selected axis), then add a Generator to X's OWN stack. Set it to a
  // constant +10 (order 0, c0=10) → X = 5 + 10 = 15; Y/Z keep the shared (empty) stack = 5.
  await body.getByTestId('channel-axis-0-override').click();
  await body.getByTestId('channel-axismod-0-add-generator').click();
  await body.getByTestId('channel-axismod-0-0-order').fill('0');
  await body.getByTestId('channel-axismod-0-0-order').blur();
  await body.getByTestId('channel-axismod-0-0-coef-0').fill('10');
  await body.getByTestId('channel-axismod-0-0-coef-0').blur();

  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 15) < 1e-2,
  );
  const r = (await pos(page))!;
  expect(r[0], 'X moved to 15').toBeCloseTo(15, 2);
  expect(r[1], 'Y unchanged').toBeCloseTo(5, 2);
  expect(r[2], 'Z unchanged').toBeCloseTo(5, 2);
  const rd = (await readPos(page))!;
  expect(rd[0], 'read X == render X (H40)').toBeCloseTo(15, 2);
  expect(rd[1], 'read Y == render Y').toBeCloseTo(5, 2);

  // FALSIFY: clear X's override → the whole stack is shared (empty) again → [5,5,5].
  await body.getByTestId('channel-axis-0-clear').click();
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 5) < 1e-6,
  );
  expect((await pos(page))![0], 'X reverted to 5').toBeCloseTo(5, 6);
});

test('the SHARED stack still drives ALL axes (ModifierList refactor guard)', async ({ page }) => {
  await boot(page);
  const body = await openAnimate(page);

  // Add a Generator to the SHARED stack (the top add menu, testid channel-modifier-add-*).
  await body.getByTestId('channel-modifier-add-generator').click();
  await body.getByTestId('channel-modifier-0-order').fill('0');
  await body.getByTestId('channel-modifier-0-order').blur();
  await body.getByTestId('channel-modifier-0-coef-0').fill('10');
  await body.getByTestId('channel-modifier-0-coef-0').blur();

  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 15) < 1e-2,
  );
  const r = (await pos(page))!;
  expect(r[0], 'shared → X 15').toBeCloseTo(15, 2);
  expect(r[1], 'shared → Y 15').toBeCloseTo(15, 2);
  expect(r[2], 'shared → Z 15').toBeCloseTo(15, 2);
});
