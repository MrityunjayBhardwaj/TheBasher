// p279 (#279, V88 D2) — the RESTRICTED-RANGE authoring UI for value-phase F-Modifiers.
// The engine (effectiveInfluence in channelModifiers.ts) already folds a modifier's
// useRange + [rangeStart,rangeEnd] window + blend-in/out ramps into its effective 0..1
// strength; this proves the NEW NPanel controls (#279) drive that engine end-to-end.
// A flat X = 5 channel gets a constant Generator (+10 → 15 at full strength); restricting
// it to [0,4] with a 2s blend-in attenuates the render to 50% inside the ramp (X = 10),
// leaves it full past the ramp (X = 15), and — the falsify — clearing useRange reverts to
// full everywhere (byte-identical to no range). Boundary-pair: render == read (H40).
import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
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
const CH = 'p279_ch';

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
  // Flat position channel on n_box: X held at 5 across [0,4].
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
              { time: 4, value: [5, 0, 0], easing: 'linear' },
            ],
          },
        },
      ],
      'user',
      'p279-seed',
    );
    w.__basher_selection.getState().select(ch);
  }, CH);
}

const renderX = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as W).__basher_mesh_world_position!('n_box')![0]);
const readX = (page: import('@playwright/test').Page, seconds: number, frame: number) =>
  page.evaluate(
    ({ s, f }) => {
      const t = (window as unknown as W).__basher_evaluated_transform!('n_box', {
        time: { frame: f, seconds: s, normalized: 0 },
      });
      return t ? t.position[0] : NaN;
    },
    { s: seconds, f: frame },
  );
const setT = (page: import('@playwright/test').Page, s: number) =>
  page.evaluate((sec) => (window as unknown as W).__basher_time.getState().setTime(sec), s);

test('range UI: blend-in ramp attenuates render (== read), past ramp full, clear reverts', async ({
  page,
}) => {
  await boot(page);
  const toggle = page.getByTestId('inspector-section-toggle-animate');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  const body = page.getByTestId('inspector-section-body-animate');

  // Generator additive, order 0, c0 = 10 → constant +10 → X = 15 at full strength.
  await body.getByTestId('channel-modifier-add-generator').click();
  const order = body.getByTestId('channel-modifier-0-order');
  await order.fill('0');
  await order.blur();
  const c0 = body.getByTestId('channel-modifier-0-coef-0');
  await c0.fill('10');
  await c0.blur();
  await setT(page, 1);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 15) < 1e-2,
  );
  expect(await renderX(page), 'full-strength generator → 15').toBeCloseTo(15, 2);

  // NEW UI: restrict to [0,4] with blend-in = 2 (the #279 controls).
  await body.getByTestId('channel-modifier-0-useRange').check();
  await body.getByTestId('channel-modifier-0-rangeStart').fill('0');
  await body.getByTestId('channel-modifier-0-rangeStart').blur();
  await body.getByTestId('channel-modifier-0-rangeEnd').fill('4');
  await body.getByTestId('channel-modifier-0-rangeEnd').blur();
  await body.getByTestId('channel-modifier-0-blendIn').fill('2');
  await body.getByTestId('channel-modifier-0-blendIn').blur();

  // t=1 → 50% into the 2s ramp → contribution 10·0.5 = 5 → X = 10. render == read (H40).
  await setT(page, 1);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 10) < 1e-2,
  );
  expect(await renderX(page), 'blend-in 50% → render 10').toBeCloseTo(10, 2);
  expect(await readX(page, 1, 60), 'blend-in 50% → read 10 (H40)').toBeCloseTo(10, 2);

  // t=3 → past the ramp (>= start+blendIn) → full strength → X = 15. render == read.
  await setT(page, 3);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 15) < 1e-2,
  );
  expect(await renderX(page), 'past ramp → render 15').toBeCloseTo(15, 2);
  expect(await readX(page, 3, 180), 'past ramp → read 15 (H40)').toBeCloseTo(15, 2);

  // FALSIFY: clear useRange → full strength everywhere again (X = 15 at t=1).
  await body.getByTestId('channel-modifier-0-useRange').uncheck();
  await setT(page, 1);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 15) < 1e-2,
  );
  expect(await renderX(page), 'clearing useRange reverts to full 15').toBeCloseTo(15, 2);
});
