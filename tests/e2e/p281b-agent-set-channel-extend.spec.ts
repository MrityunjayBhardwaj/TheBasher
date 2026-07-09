// p281b (#281) — the AGENT authoring op for per-side channel EXTRAPOLATION.
// mutator.timeline.setChannelExtend, run through the real five-gate agent path
// (__basher_dispatchMutator), flips how a sloped X channel extrapolates PAST its
// last keyframe. Keys: X = 0 @ t0, X = 10 @ t1; sampled at t2 (outside the
// domain). Default extendAfter='hold' → render X = 10. Agent sets after='slope'
// → the boundary slope (10/s) continues → render X = 20, render == read (H40).
// FALSIFY: agent sets after='hold' → back to the clamped 10.
import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { params: { extendAfter?: string } }> };
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
const CH = 'p281b_ch';

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
  // Sloped X channel: 0 → 10 across [0,1]. Sampled at t=2 (past the domain).
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
              { time: 1, value: [10, 0, 0], easing: 'linear' },
            ],
          },
        },
      ],
      'user',
      'p281b-seed',
    );
    w.__basher_selection.getState().select(ch);
  }, CH);
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(2));
  // Default extendAfter = 'hold' → clamped to the last key (10).
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 10) < 1e-6,
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
      time: { frame: 120, seconds: 2, normalized: 0 },
    });
    return t ? t.position[0] : NaN;
  }))!;
}

test('agent setChannelExtend(after: slope) continues the boundary slope; render == read; hold reverts', async ({
  page,
}) => {
  await boot(page);
  expect(await renderX(page), 'baseline hold → clamped 10').toBeCloseTo(10, 6);

  // Agent flips the after-extrapolation to slope through the five-gate path.
  const slope = await page.evaluate((ch) => {
    return (window as unknown as W).__basher_dispatchMutator!(
      'mutator.timeline.setChannelExtend',
      { channelId: ch, after: 'slope' },
      'agent: extrapolate the tail',
    );
  }, CH);
  expect(slope.ok, slope.ok ? '' : slope.reason).toBe(true);

  await page.waitForFunction(
    () =>
      (window as unknown as W).__basher_dag.getState().state.nodes['p281b_ch'].params
        .extendAfter === 'slope',
  );
  // Slope 10/s continued to t=2 → X = 20.
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 20) < 1e-4,
  );
  const sRender = await renderX(page);
  const sRead = await readX(page);
  expect(sRender, 'slope extrapolates to 20').toBeCloseTo(20, 3);
  expect(sRender, 'render == read (H40)').toBeCloseTo(sRead, 3);

  // FALSIFY: agent flips back to hold → clamped 10 again.
  const hold = await page.evaluate((ch) => {
    return (window as unknown as W).__basher_dispatchMutator!(
      'mutator.timeline.setChannelExtend',
      { channelId: ch, after: 'hold' },
      'agent: clamp the tail',
    );
  }, CH);
  expect(hold.ok, hold.ok ? '' : hold.reason).toBe(true);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 10) < 1e-6,
  );
  expect(await renderX(page), 'hold → back to clamped 10 (falsify)').toBeCloseTo(10, 6);
});
