// p274 (#274, V88 D2) — the per-channel F-MODIFIER STACK. A flat position channel
// (X = 5) with a NOISE modifier deviates the rendered box off the clean curve; the
// same deviation shows on the read side (H40), and MUTING the modifier reverts to
// the clean value (falsify). Two boundary-pairs: (A) direct-seed proves the sampler
// through the real render/read pipeline; (B) the NPanel "+ noise" button + its
// fields drive the same render (UI → setParam → render).
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
const CH = 'p274_ch';

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
      'p274-seed',
    );
    w.__basher_selection.getState().select(ch);
  }, CH);
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(1));
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

test('noise modifier deviates render off the clean curve; render == read; mute reverts', async ({
  page,
}) => {
  await boot(page);
  // Clean base (no modifiers) renders exactly 5.
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 5) < 1e-6,
  );

  // Add a noise modifier: blend add, strength 3, offset 10 → deviation ∈ [7,13],
  // so the rendered X ∈ [12,18] — always off the clean 5, deterministically.
  await page.evaluate((ch) => {
    (window as unknown as W).__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: ch,
          paramPath: 'modifiers',
          value: [
            { type: 'noise', blend: 'add', strength: 3, scale: 1, phase: 0, offset: 10, depth: 1 },
          ],
        },
      ],
      'e2e',
      'p274-noise',
    );
  }, CH);
  await page.waitForFunction(
    () => (window as unknown as W).__basher_mesh_world_position!('n_box')![0] > 11,
  );
  const noisyRender = await renderX(page);
  const noisyRead = await readX(page);
  expect(noisyRender, 'noise deviates render off 5').toBeGreaterThan(11);
  expect(noisyRead, 'read deviates too').toBeGreaterThan(11);
  expect(noisyRender, 'render == read (H40)').toBeCloseTo(noisyRead, 3);

  // FALSIFY: mute the modifier → the clean base (5) is restored.
  await page.evaluate((ch) => {
    (window as unknown as W).__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: ch,
          paramPath: 'modifiers',
          value: [
            {
              type: 'noise',
              blend: 'add',
              strength: 3,
              scale: 1,
              phase: 0,
              offset: 10,
              depth: 1,
              muted: true,
            },
          ],
        },
      ],
      'e2e',
      'p274-mute',
    );
  }, CH);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 5) < 1e-6,
  );
  expect(await renderX(page), 'muted → back to clean 5').toBeCloseTo(5, 6);
});

test('NPanel "+ noise" button + its fields drive the render', async ({ page }) => {
  await boot(page);
  const toggle = page.getByTestId('inspector-section-toggle-animate');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  const body = page.getByTestId('inspector-section-body-animate');

  const add = body.getByTestId('channel-modifier-add-noise');
  await expect(add).toBeVisible({ timeout: 10_000 });
  await add.click();

  // A modifier card appears; author a big offset so the deviation is unmistakable.
  const offset = body.getByTestId('channel-modifier-0-offset');
  await expect(offset).toBeVisible();
  await offset.fill('20');
  await offset.blur();

  // DAG updated + render followed (base 5 + noise + 20 ≈ 25).
  await expect
    .poll(async () =>
      page.evaluate(
        (ch) =>
          (window as unknown as W).__basher_dag.getState().state.nodes[ch].params.modifiers?.length,
        CH,
      ),
    )
    .toBe(1);
  await page.waitForFunction(
    () => (window as unknown as W).__basher_mesh_world_position!('n_box')![0] > 20,
  );
  expect(await renderX(page), 'UI add-noise → render deviates').toBeGreaterThan(20);

  // FALSIFY: tick mute → reverts to the clean 5.
  await body.getByTestId('channel-modifier-0-mute').check();
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 5) < 1e-6,
  );
  expect(await renderX(page), 'mute → clean 5').toBeCloseTo(5, 6);
});
