// p276 (#276, V88 D2) — the VALUE-phase F-Modifiers: Generator (polynomial of time)
// + Limits (value clamp). A flat position channel (X = 5) is deviated by a Generator
// and then clamped by a Limits modifier; the same values show on the read side (H40),
// and clearing the stack reverts to the clean curve (falsify). Three boundary-pairs:
// (A) direct-seed proves generator+limits through the real render/read pipeline;
// (B) the NPanel "+ generator" button + its c0 field drive the render; (C) the
// "+ limits" button + max-Y enable clamp the render.
import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { params: { modifiers?: unknown[] } }> };
      dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_mesh_world_position?: (id: string) => [number, number, number] | null;
  __basher_evaluated_transform?: (
    id: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { position: [number, number, number] } | null;
}
const CH = 'p276_ch';

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
  // Flat position channel on n_box: X held at 5 across [0,2]. Base at t=1 is 5.
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
              { time: 0, value: [5, 0, 0], easing: 'linear' },
              { time: 2, value: [5, 0, 0], easing: 'linear' },
            ],
          },
        },
      ],
      'user',
      'p276-seed',
    );
    w.__basher_selection.getState().select(ch);
  }, CH);
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(1));
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 5) < 1e-6,
  );
}

async function renderX(page: import('@playwright/test').Page): Promise<number> {
  return (await page.evaluate(
    () => (window as unknown as W).__basher_mesh_world_position!('n_box')![0],
  ))!;
}
async function readX(page: import('@playwright/test').Page): Promise<number> {
  return (await page.evaluate(() => {
    const t = (window as unknown as W).__basher_evaluated_transform!('n_box', {
      time: { frame: 60, seconds: 1, normalized: 0 },
    });
    return t ? t.position[0] : NaN;
  }))!;
}
async function setMods(page: import('@playwright/test').Page, mods: unknown[]) {
  await page.evaluate(
    ({ ch, m }) => {
      (window as unknown as W).__basher_dag
        .getState()
        .dispatchAtomic(
          [{ type: 'setParam', nodeId: ch, paramPath: 'modifiers', value: m }],
          'user',
          'p276-mods',
        );
    },
    { ch: CH, m: mods },
  );
}

test('generator adds to the curve, limits clamps it; render == read; empty reverts', async ({
  page,
}) => {
  await boot(page);

  // Generator (additive, constant c0 = 5): base 5 + 5 = 10.
  await setMods(page, [{ type: 'generator', additive: true, coefficients: [5] }]);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 10) < 1e-2,
  );
  expect(await renderX(page), 'generator +5 → render 10').toBeCloseTo(10, 2);
  expect(await readX(page), 'generator +5 → read 10 (H40)').toBeCloseTo(10, 2);

  // Add a Limits modifier AFTER it: clamp the 10 down to maxY = 8.
  await setMods(page, [
    { type: 'generator', additive: true, coefficients: [5] },
    { type: 'limits', useMaxY: true, maxY: 8 },
  ]);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 8) < 1e-2,
  );
  expect(await renderX(page), 'limits maxY 8 → render 8').toBeCloseTo(8, 2);
  expect(await readX(page), 'limits maxY 8 → read 8 (H40)').toBeCloseTo(8, 2);

  // FALSIFY: empty stack → the clean curve (5) returns.
  await setMods(page, []);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 5) < 1e-6,
  );
  expect(await renderX(page), 'empty stack → clean 5').toBeCloseTo(5, 6);
});

test('NPanel "+ generator" button + its c0 field drive the render', async ({ page }) => {
  await boot(page);
  const toggle = page.getByTestId('inspector-section-toggle-animate');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  const body = page.getByTestId('inspector-section-body-animate');

  // Add a Generator — default is additive [0, 1] (y = t), so at t=1 it adds 1 → X = 6.
  await body.getByTestId('channel-modifier-add-generator').click();
  await page.waitForFunction(
    () => (window as unknown as W).__basher_mesh_world_position!('n_box')![0] > 5.5,
  );
  expect(await renderX(page), 'default generator deviates off 5').toBeCloseTo(6, 2);

  // Set c0 = 10 → y = 10 + 1·1 = 11, additive over base 5 → 16.
  const c0 = body.getByTestId('channel-modifier-0-coef-0');
  await expect(c0).toBeVisible();
  await c0.fill('10');
  await c0.blur();
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 16) < 1e-2,
  );
  expect(await renderX(page), 'c0=10 → render 16').toBeCloseTo(16, 2);
});

test('NPanel "+ limits" button + max-Y enable clamp the render', async ({ page }) => {
  await boot(page);
  // Seed a generator (+5 → 10) directly, then clamp it through the Limits UI.
  await setMods(page, [{ type: 'generator', additive: true, coefficients: [5] }]);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 10) < 1e-2,
  );

  const toggle = page.getByTestId('inspector-section-toggle-animate');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  const body = page.getByTestId('inspector-section-body-animate');

  await body.getByTestId('channel-modifier-add-limits').click();
  // The Limits card is modifier index 1. Enable max Y, then set it to 8.
  const useMax = body.getByTestId('channel-modifier-1-useMaxY');
  await expect(useMax).toBeVisible();
  await useMax.check();
  const maxY = body.getByTestId('channel-modifier-1-maxY');
  await expect(maxY).toBeVisible();
  await maxY.fill('8');
  await maxY.blur();

  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 8) < 1e-2,
  );
  expect(await renderX(page), 'UI limits maxY 8 → render clamps to 8').toBeCloseTo(8, 2);
});
