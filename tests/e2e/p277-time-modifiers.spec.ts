// p277 (#277, V88 D2) — the TIME-phase F-Modifiers: Stepped (snap the sample time to
// a grid → hold) + Limits-X (clamp the sample time → constant-extrapolate). A RAMP
// position channel (X = 10·t) makes the time remap observable: at t = 1.4 the clean
// curve reads 14, Stepped(step 1) snaps t → 1 so X holds at 10, Limits-X(maxX 0.5)
// clamps t → 0.5 so X holds at 5. The same values show on the read side (H40), and
// clearing the stack reverts to the clean curve (falsify). Three boundary-pairs:
// (A) direct-seed proves stepped + limits-X through the real render/read pipeline;
// (B) the NPanel "+ stepped" button + its step field drive the render; (C) the
// "+ limits" button + max-X enable clamp the render.
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
const CH = 'p277_ch';
const T = 1.4; // sample time; clean ramp X = 10·1.4 = 14

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
  // RAMP position channel on n_box: X = 10·t across [0,4]. Base at t=1.4 is 14.
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
              { time: 4, value: [40, 0, 0], easing: 'linear' },
            ],
          },
        },
      ],
      'user',
      'p277-seed',
    );
    w.__basher_selection.getState().select(ch);
  }, CH);
  await page.evaluate((t) => (window as unknown as W).__basher_time.getState().setTime(t), T);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 14) < 1e-2,
  );
}

async function renderX(page: import('@playwright/test').Page): Promise<number> {
  return (await page.evaluate(
    () => (window as unknown as W).__basher_mesh_world_position!('n_box')![0],
  ))!;
}
async function readX(page: import('@playwright/test').Page): Promise<number> {
  return (await page.evaluate((t) => {
    const w = window as unknown as W;
    const tr = w.__basher_evaluated_transform!('n_box', {
      time: { frame: t * 60, seconds: t, normalized: 0 },
    });
    return tr ? tr.position[0] : NaN;
  }, T))!;
}
async function setMods(page: import('@playwright/test').Page, mods: unknown[]) {
  await page.evaluate(
    ({ ch, m }) => {
      (window as unknown as W).__basher_dag
        .getState()
        .dispatchAtomic(
          [{ type: 'setParam', nodeId: ch, paramPath: 'modifiers', value: m }],
          'user',
          'p277-mods',
        );
    },
    { ch: CH, m: mods },
  );
}

test('stepped holds the curve, limits-X constant-extrapolates; render == read; empty reverts', async ({
  page,
}) => {
  await boot(page);

  // Stepped (step 1): snap t=1.4 → 1, so the ramp HOLDS at X = 10 (not 14).
  await setMods(page, [{ type: 'stepped', step: 1, offset: 0 }]);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 10) < 1e-2,
  );
  expect(await renderX(page), 'stepped step1 → render holds at 10').toBeCloseTo(10, 2);
  expect(await readX(page), 'stepped step1 → read holds at 10 (H40)').toBeCloseTo(10, 2);

  // Limits-X (maxX 0.5): clamp t=1.4 → 0.5, so X holds at 5 (constant-extrapolate).
  await setMods(page, [{ type: 'limits', useMaxX: true, maxX: 0.5 }]);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 5) < 1e-2,
  );
  expect(await renderX(page), 'limits maxX 0.5 → render holds at 5').toBeCloseTo(5, 2);
  expect(await readX(page), 'limits maxX 0.5 → read holds at 5 (H40)').toBeCloseTo(5, 2);

  // FALSIFY: empty stack → the clean ramp (14) returns.
  await setMods(page, []);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 14) < 1e-2,
  );
  expect(await renderX(page), 'empty stack → clean 14').toBeCloseTo(14, 2);
});

test('NPanel "+ stepped" button + its step field drive the render', async ({ page }) => {
  await boot(page);
  const toggle = page.getByTestId('inspector-section-toggle-animate');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  const body = page.getByTestId('inspector-section-body-animate');

  // Add a Stepped — default step 1 → snap 1.4 to 1 → X holds at 10 (off the clean 14).
  await body.getByTestId('channel-modifier-add-stepped').click();
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 10) < 1e-1,
  );
  expect(await renderX(page), 'default stepped holds at 10').toBeCloseTo(10, 1);

  // Set step = 2 → snap 1.4 to 0 → X holds at 0.
  const step = body.getByTestId('channel-modifier-0-step');
  await expect(step).toBeVisible();
  await step.fill('2');
  await step.blur();
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0]) < 1e-1,
  );
  expect(await renderX(page), 'step=2 → snaps to 0 → X 0').toBeCloseTo(0, 1);
});

test('NPanel "+ limits" button + max-X enable clamp the render', async ({ page }) => {
  await boot(page);
  const toggle = page.getByTestId('inspector-section-toggle-animate');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  const body = page.getByTestId('inspector-section-body-animate');

  // Add a Limits modifier, enable max X, then clamp the sample time to 0.5 → X = 5.
  await body.getByTestId('channel-modifier-add-limits').click();
  const useMaxX = body.getByTestId('channel-modifier-0-useMaxX');
  await expect(useMaxX).toBeVisible();
  await useMaxX.check();
  const maxX = body.getByTestId('channel-modifier-0-maxX');
  await expect(maxX).toBeVisible();
  await maxX.fill('0.5');
  await maxX.blur();

  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 5) < 1e-1,
  );
  expect(await renderX(page), 'UI limits maxX 0.5 → render clamps time → X 5').toBeCloseTo(5, 1);
});
