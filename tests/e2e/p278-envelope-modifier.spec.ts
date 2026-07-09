// p278 (#278, V88 D2) — the ENVELOPE F-Modifier: a value-phase reference-band remap.
// A flat position channel (X = 5) is reshaped by an envelope whose per-time band shifts
// (→ translate the value) or widens (→ scale the value); the same values show on the read
// side (H40), and clearing the stack reverts to the clean curve (falsify). Boundary-pairs:
// (A) direct-seed proves the remap (shift → 6, scale → 11) through the real render/read
// pipeline; (B) the NPanel "+ envelope" button + "+ point" + a point's max field drive it.
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
const CH = 'p278_ch';
const T = 1; // sample time; the two-point band is (0,2) here → flat 5 remaps to 6

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
  // Flat position channel on n_box: X held at 5 across [0,10]. Base at t=1 is 5.
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
              { time: 10, value: [5, 0, 0], easing: 'linear' },
            ],
          },
        },
      ],
      'user',
      'p278-seed',
    );
    w.__basher_selection.getState().select(ch);
  }, CH);
  await page.evaluate((t) => (window as unknown as W).__basher_time.getState().setTime(t), T);
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
          'p278-mods',
        );
    },
    { ch: CH, m: mods },
  );
}

test('envelope shifts (→6) and scales (→11) the value; render == read; empty reverts', async ({
  page,
}) => {
  await boot(page);

  // SHIFT: reference band [-1,1]; points identity@0 and (1,3)@2 → at t=1 the band is (0,2),
  // shifted +1 with equal width → flat 5 remaps to 6.
  await setMods(page, [
    {
      type: 'envelope',
      reference: 0,
      min: -1,
      max: 1,
      points: [
        { time: 0, min: -1, max: 1 },
        { time: 2, min: 1, max: 3 },
      ],
    },
  ]);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 6) < 1e-2,
  );
  expect(await renderX(page), 'envelope shift → render 6').toBeCloseTo(6, 2);
  expect(await readX(page), 'envelope shift → read 6 (H40)').toBeCloseTo(6, 2);

  // SCALE: a single band (-1,3) — width 4 vs reference width 2 → stretch. flat 5 → 11.
  await setMods(page, [
    { type: 'envelope', reference: 0, min: -1, max: 1, points: [{ time: 0, min: -1, max: 3 }] },
  ]);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 11) < 1e-2,
  );
  expect(await renderX(page), 'envelope scale → render 11').toBeCloseTo(11, 2);
  expect(await readX(page), 'envelope scale → read 11 (H40)').toBeCloseTo(11, 2);

  // FALSIFY: empty stack → the clean curve (5) returns.
  await setMods(page, []);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 5) < 1e-6,
  );
  expect(await renderX(page), 'empty stack → clean 5').toBeCloseTo(5, 6);
});

test('NPanel "+ envelope" + "+ point" + a point max field drive the render', async ({ page }) => {
  await boot(page);
  const toggle = page.getByTestId('inspector-section-toggle-animate');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  const body = page.getByTestId('inspector-section-body-animate');

  // Add an Envelope — no control points → a no-op, X stays 5.
  await body.getByTestId('channel-modifier-add-envelope').click();
  await expect(body.getByTestId('channel-modifier-0-add-point')).toBeVisible();
  expect(await renderX(page), 'empty envelope is a no-op').toBeCloseTo(5, 2);

  // Add a control point — seeded as identity (offsets = the global band) → still 5.
  await body.getByTestId('channel-modifier-0-add-point').click();
  await expect(body.getByTestId('channel-modifier-0-point-0-max')).toBeVisible();
  expect(await renderX(page), 'identity point is a no-op').toBeCloseTo(5, 2);

  // Widen the point's upper bound to 3 → band (-1,3), scale ×2 → flat 5 remaps to 11.
  const maxField = body.getByTestId('channel-modifier-0-point-0-max');
  await maxField.fill('3');
  await maxField.blur();
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 11) < 1e-1,
  );
  expect(await renderX(page), 'point max=3 → render scales to 11').toBeCloseTo(11, 1);
});
