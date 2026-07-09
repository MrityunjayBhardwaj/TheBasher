// p289 (#289, V88 D1) — PER-AXIS (independent) extrapolation / Cycles. #280 made value/time
// modifiers per-axis but extrapolation + Cycles stayed channel-level; #289 resolves them per
// axis (Blender: each axis is its own F-curve). Boundary-pairs on a ramp position channel
// [0,0,0]→[2,4,6] (per-axis slopes 1/2/3): (A) a per-axis slope on X via the NPanel Per-axis
// Extend control → at t=3 X extrapolates to 3, Y/Z HOLD at 4/6, render==read (H40), clear
// reverts (falsify); (B) a per-axis Cycles in X's own stack cycles ONLY X → X folds to 1,
// Y/Z hold; (C) the per-axis Cycles Add button is re-enabled (PER_AXIS_EXCLUDE now empty).
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
const CH = 'p289_ch';

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
              { time: 0, value: [0, 0, 0], easing: 'linear' },
              { time: 2, value: [2, 4, 6], easing: 'linear' },
            ],
          },
        },
      ],
      'user',
      'p289-seed',
    );
    w.__basher_selection.getState().select(ch);
  }, CH);
  // t=3 is 1s past the domain end (t=2).
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(3));
}

const pos = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as W).__basher_mesh_world_position!('n_box'));
const readPos = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const t = (window as unknown as W).__basher_evaluated_transform!('n_box', {
      time: { frame: 180, seconds: 3, normalized: 0 },
    });
    return t ? t.position : null;
  });

async function openAnimate(page: import('@playwright/test').Page) {
  const toggle = page.getByTestId('inspector-section-toggle-animate');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  return page.getByTestId('inspector-section-body-animate');
}

test('a per-axis slope on X extrapolates X alone; Y/Z hold; render == read; clear reverts', async ({
  page,
}) => {
  await boot(page);
  const body = await openAnimate(page);

  // Baseline: channel-level hold → past the domain every axis holds the last key → [2,4,6].
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 2) < 1e-6,
  );

  // Set X's per-axis extrapolation AFTER = slope (axis 0 is default-selected).
  await body.getByTestId('channel-axisextend-0-after').selectOption('slope');

  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 3) < 1e-2,
  );
  const r = (await pos(page))!;
  expect(r[0], 'X slopes to 3').toBeCloseTo(3, 2);
  expect(r[1], 'Y holds at 4').toBeCloseTo(4, 2);
  expect(r[2], 'Z holds at 6').toBeCloseTo(6, 2);
  const rd = (await readPos(page))!;
  expect(rd[0], 'read X == render X (H40)').toBeCloseTo(3, 2);
  expect(rd[1], 'read Y == render Y').toBeCloseTo(4, 2);
  expect(rd[2], 'read Z == render Z').toBeCloseTo(6, 2);

  // FALSIFY: revert X to the channel Extend (hold) → X holds at 2 again.
  await body.getByTestId('channel-axisextend-0-clear').click();
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 2) < 1e-6,
  );
  expect((await pos(page))![0], 'X reverted to 2 (hold)').toBeCloseTo(2, 6);
});

test('per-axis Cycles is re-enabled in the per-axis Add menu (PER_AXIS_EXCLUDE emptied)', async ({
  page,
}) => {
  await boot(page);
  const body = await openAnimate(page);
  // Override X's modifier stack → its ModifierList (with the Add menu) appears. #289 dropped
  // 'cycles' from PER_AXIS_EXCLUDE, so the per-axis Cycles Add button is now present.
  await body.getByTestId('channel-axis-0-override').click();
  await expect(body.getByTestId('channel-axismod-0-add-cycles')).toBeVisible();
});

test('a per-axis Cycles in X’s stack cycles X alone; render == read; clear reverts', async ({
  page,
}) => {
  await boot(page);

  // Put a Cycles(repeat) in X's OWN per-axis stack. #289: it now drives X's extrapolation
  // (folds [0,2]) while Y/Z keep the channel-level hold.
  await page.evaluate((ch) => {
    const w = window as unknown as W;
    w.__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: ch,
          paramPath: 'axisModifiers',
          value: [
            [
              {
                type: 'cycles',
                beforeMode: 'repeat',
                afterMode: 'repeat',
                beforeCycles: 0,
                afterCycles: 0,
                muted: false,
                influence: 1,
              },
            ],
            null,
            null,
          ],
        },
      ],
      'user',
      'p289-axis-cycles',
    );
  }, CH);

  // At t=3, X folds back to t=1 → X=1; Y/Z hold at 4/6.
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 1) < 1e-2,
  );
  const r = (await pos(page))!;
  expect(r[0], 'X cycled to 1').toBeCloseTo(1, 2);
  expect(r[1], 'Y holds at 4').toBeCloseTo(4, 2);
  expect(r[2], 'Z holds at 6').toBeCloseTo(6, 2);
  const rd = (await readPos(page))!;
  expect(rd[0], 'read X == render X (H40)').toBeCloseTo(1, 2);
  expect(rd[2], 'read Z == render Z').toBeCloseTo(6, 2);

  // FALSIFY: clear the per-axis stack → X holds at 2 (channel-level).
  await page.evaluate((ch) => {
    const w = window as unknown as W;
    w.__basher_dag
      .getState()
      .dispatchAtomic(
        [{ type: 'setParam', nodeId: ch, paramPath: 'axisModifiers', value: undefined }],
        'user',
        'p289-clear',
      );
  }, CH);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 2) < 1e-6,
  );
  expect((await pos(page))![0], 'X reverted to 2 (hold)').toBeCloseTo(2, 6);
});
