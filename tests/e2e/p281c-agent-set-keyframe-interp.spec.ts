// p281c (#281) — the AGENT authoring op for per-keyframe INTERPOLATION.
// mutator.timeline.setKeyframeInterp, run through the real five-gate agent path
// (__basher_dispatchMutator), changes HOW a linear X channel moves between its
// keys. Keys: X = 0 @ t0, X = 10 @ t1 (both linear). At t=0.5, linear → X = 5.
// Agent sets easing='back', ease='out' on all keys → the Penner "back" curve
// OVERSHOOTS past the endpoint → render X ≈ 10.88 (> 10), render == read (H40).
// Only an overshooting easing can exceed 10 at t=0.5, so the assertion is
// unambiguous. FALSIFY: agent sets easing='linear' → back to the straight 5.
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
const CH = 'p281c_ch';

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
  // Linear X ramp 0 → 10 across [0,1]; sampled at the segment midpoint t=0.5.
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
      'p281c-seed',
    );
    w.__basher_selection.getState().select(ch);
  }, CH);
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(0.5));
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
      time: { frame: 30, seconds: 0.5, normalized: 0 },
    });
    return t ? t.position[0] : NaN;
  }))!;
}

test('agent setKeyframeInterp(back/out) overshoots the endpoint; render == read; linear reverts', async ({
  page,
}) => {
  await boot(page);
  expect(await renderX(page), 'baseline linear @0.5 → 5').toBeCloseTo(5, 6);

  // Agent re-interps every key to a Penner back-out easing via the five-gate path.
  const back = await page.evaluate((ch) => {
    return (window as unknown as W).__basher_dispatchMutator!(
      'mutator.timeline.setKeyframeInterp',
      { channelId: ch, scope: 'all', easing: 'back', ease: 'out' },
      'agent: make it snap with overshoot',
    );
  }, CH);
  expect(back.ok, back.ok ? '' : back.reason).toBe(true);

  await page.waitForFunction(
    () =>
      (window as unknown as W).__basher_dag.getState().state.nodes['p281c_ch'].params.keyframes?.[1]
        ?.easing === 'back',
  );
  // back-out overshoots past the endpoint (10) at t=0.5 → X > 10.
  await page.waitForFunction(
    () => (window as unknown as W).__basher_mesh_world_position!('n_box')![0] > 10,
  );
  const bRender = await renderX(page);
  const bRead = await readX(page);
  expect(bRender, 'back-out overshoots past 10').toBeGreaterThan(10);
  expect(bRender, 'render == read (H40)').toBeCloseTo(bRead, 3);

  // FALSIFY: agent flips back to linear → the straight 5 returns.
  const lin = await page.evaluate((ch) => {
    return (window as unknown as W).__basher_dispatchMutator!(
      'mutator.timeline.setKeyframeInterp',
      { channelId: ch, scope: 'all', easing: 'linear' },
      'agent: straighten it',
    );
  }, CH);
  expect(lin.ok, lin.ok ? '' : lin.reason).toBe(true);
  await page.waitForFunction(
    () => Math.abs((window as unknown as W).__basher_mesh_world_position!('n_box')![0] - 5) < 1e-6,
  );
  expect(await renderX(page), 'linear → back to straight 5 (falsify)').toBeCloseTo(5, 6);
});
