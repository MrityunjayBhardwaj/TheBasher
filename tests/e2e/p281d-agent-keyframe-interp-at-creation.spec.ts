// p281d (#281) — interp authored AT KEY CREATION via the broadened
// mutator.timeline.keyframe (was pre-#272 linear|cubic only). Run through the
// real five-gate agent path (__basher_dispatchMutator): a channel seeded with X
// = 0 @ t0 gets a second key X = 10 @ t1 authored with easing='back', ease='out'
// in the SAME call. At t=0.5 the back-out curve overshoots past 10 → render X >
// 10, render == read (H40). FALSIFY: re-key t1 with easing='linear' → the
// straight midpoint 5 returns (proving the interp field, not the value, drove it).
import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { params: { keyframes?: { easing?: string }[] } }> };
      dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void;
    };
  };
  __basher_dispatchMutator?: (
    name: string,
    spec: unknown,
    intent: string,
  ) => { ok: true } | { ok: false; reason: string };
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_mesh_world_position?: (id: string) => [number, number, number] | null;
  __basher_evaluated_transform?: (
    id: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { position: [number, number, number] } | null;
}
const CH = 'p281d_ch';

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
    return Boolean(
      w.__basher_dag &&
      w.__basher_time &&
      w.__basher_mesh_world_position &&
      w.__basher_dispatchMutator,
    );
  });
  await page.waitForFunction(
    () => (window as unknown as W).__basher_mesh_world_position!('n_box') !== null,
  );
  // Seed a single key X = 0 @ t0 (linear). The agent will author the 2nd key.
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
            keyframes: [{ time: 0, value: [0, 0, 0], easing: 'linear' }],
          },
        },
      ],
      'user',
      'p281d-seed',
    );
    w.__basher_selection.getState().select(ch);
  }, CH);
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(0.5));
}

async function renderX(page: import('@playwright/test').Page): Promise<number> {
  return (await page.evaluate(
    () => (window as unknown as W).__basher_mesh_world_position!('n_box')![0],
  ))!;
}
async function readX(page: import('@playwright/test').Page): Promise<number> {
  return (await page.evaluate(() => {
    const t = (window as unknown as W).__basher_evaluated_transform!('n_box', {
      time: { frame: 30, seconds: 0.5, normalized: 0 },
    });
    return t ? t.position[0] : NaN;
  }))!;
}

test('agent keyframe(..., easing: back, ease: out) authors an overshooting key; render == read; linear reverts', async ({
  page,
}) => {
  await boot(page);

  // Author the 2nd key WITH the interp in one call.
  const back = await page.evaluate((ch) => {
    return (window as unknown as W).__basher_dispatchMutator!(
      'mutator.timeline.keyframe',
      { channelId: ch, time: 1, value: [10, 0, 0], easing: 'back', ease: 'out' },
      'agent: snap to 10 with overshoot',
    );
  }, CH);
  expect(back.ok, back.ok ? '' : back.reason).toBe(true);

  await page.waitForFunction(
    () =>
      (window as unknown as W).__basher_dag.getState().state.nodes['p281d_ch'].params.keyframes?.[1]
        ?.easing === 'back',
  );
  await page.waitForFunction(
    () => (window as unknown as W).__basher_mesh_world_position!('n_box')![0] > 10,
  );
  const bRender = await renderX(page);
  const bRead = await readX(page);
  expect(bRender, 'back-out overshoots past 10 at t=0.5').toBeGreaterThan(10);
  expect(bRender, 'render == read (H40)').toBeCloseTo(bRead, 3);

  // FALSIFY: re-key the same time/value with linear → straight midpoint 5.
  const lin = await page.evaluate((ch) => {
    return (window as unknown as W).__basher_dispatchMutator!(
      'mutator.timeline.keyframe',
      { channelId: ch, time: 1, value: [10, 0, 0], easing: 'linear' },
      'agent: straighten it',
    );
  }, CH);
  expect(lin.ok, lin.ok ? '' : lin.reason).toBe(true);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 5) < 1e-6,
  );
  expect(await renderX(page), 'linear → straight 5 (falsify)').toBeCloseTo(5, 6);
});
