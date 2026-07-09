// p273 (#273) — per-keyframe bézier HANDLE TYPES. On a rise-then-hold (0→10→10):
//   • 'auto'         overshoots above 10 on the hold segment (smooth C1 tangent),
//   • 'auto-clamped' flattens at the peak → holds ≈10 (no overshoot — Blender default).
// Two boundary-pairs: (A) direct-seed proves render == read (H40); (B) the curve-editor
// handle PICKER drives the same render (UI → setParam → render). auto vs auto-clamped
// is the falsify pair.
import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { params: { keyframes?: { handleType?: string }[] } }> };
      dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void;
    };
  };
  __basher_viewport: { getState: () => { setTimelineDrawerOpen: (v: boolean) => void } };
  __basher_timeline_dock: { getState: () => { setActiveTab: (t: string) => void } };
  __basher_timeline_selection: {
    getState: () => {
      setActiveChannel: (id: string | null) => void;
      setActiveKeyframe: (r: { channelId: string; time: number } | null) => void;
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_mesh_world_position?: (id: string) => [number, number, number] | null;
  __basher_evaluated_transform?: (
    id: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { position: [number, number, number] } | null;
}

const RISE_HOLD = (handleType: 'auto' | 'auto-clamped') => [
  { time: 0, value: [0, 0, 0], easing: 'cubic', handleType },
  { time: 1, value: [10, 0, 0], easing: 'cubic', handleType },
  { time: 2, value: [10, 0, 0], easing: 'cubic', handleType },
];

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
}

async function renderX(page: import('@playwright/test').Page): Promise<number> {
  return (await page.evaluate(
    () => (window as unknown as W).__basher_mesh_world_position!('n_box')![0],
  ))!;
}

test('auto overshoots, auto-clamped holds — render == read (H40)', async ({ page }) => {
  await boot(page);
  // AUTO — smooth tangent overshoots above the destination on the hold segment.
  await page.evaluate((kf) => {
    (window as unknown as W).__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'tmp273_ch',
          nodeType: 'KeyframeChannelVec3',
          params: { name: 'pos', target: 'n_box', paramPath: 'position', keyframes: kf },
        },
      ],
      'e2e',
      'p273-auto',
    );
  }, RISE_HOLD('auto'));
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(1.5));
  await page.waitForFunction(
    () => (window as unknown as W).__basher_mesh_world_position!('n_box')![0] > 10,
  );
  const autoRender = await renderX(page);
  const autoRead = await page.evaluate(() => {
    const t = (window as unknown as W).__basher_evaluated_transform!('n_box', {
      time: { frame: 90, seconds: 1.5, normalized: 0 },
    });
    return t ? t.position[0] : null;
  });
  expect(autoRender, 'auto overshoots').toBeGreaterThan(10);
  expect(autoRead!, 'read overshoots too').toBeGreaterThan(10);
  expect(autoRender, 'render == read (H40)').toBeCloseTo(autoRead!, 3);

  // AUTO-CLAMPED (falsify) — same keys, no overshoot: flattens at the extremum.
  await page.evaluate((kf) => {
    (window as unknown as W).__basher_dag
      .getState()
      .dispatchAtomic(
        [{ type: 'setParam', nodeId: 'tmp273_ch', paramPath: 'keyframes', value: kf }],
        'e2e',
        'p273-clamped',
      );
  }, RISE_HOLD('auto-clamped'));
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(1.5));
  await page.waitForFunction(
    () => (window as unknown as W).__basher_mesh_world_position!('n_box')![0] <= 10.001,
  );
  const clampedRender = await renderX(page);
  const clampedRead = await page.evaluate(() => {
    const t = (window as unknown as W).__basher_evaluated_transform!('n_box', {
      time: { frame: 90, seconds: 1.5, normalized: 0 },
    });
    return t ? t.position[0] : null;
  });
  expect(clampedRender, 'auto-clamped does not overshoot').toBeLessThanOrEqual(10.001);
  expect(clampedRender, 'auto-clamped holds ~10').toBeCloseTo(10, 2);
  expect(clampedRender, 'render == read (H40)').toBeCloseTo(clampedRead!, 3);
});

test('curve-editor handle picker drives the render', async ({ page }) => {
  await boot(page);
  const CH = 'tmp273b_ch';
  await page.evaluate(
    ({ id, kf }) => {
      const w = window as unknown as W;
      w.__basher_dag.getState().dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: id,
            nodeType: 'KeyframeChannelVec3',
            params: { name: 'pos', target: 'n_box', paramPath: 'position', keyframes: kf },
          },
        ],
        'user',
        'p273b seed',
      );
      w.__basher_viewport.getState().setTimelineDrawerOpen(true);
      w.__basher_timeline_dock.getState().setActiveTab('curve');
      w.__basher_timeline_selection.getState().setActiveChannel(id);
      // Select the MIDDLE key (t=1) — its OUT handle governs the hold segment.
      w.__basher_timeline_selection.getState().setActiveKeyframe({ channelId: id, time: 1 });
    },
    {
      id: CH,
      kf: [
        { time: 0, value: [0, 0, 0], easing: 'cubic' },
        { time: 1, value: [10, 0, 0], easing: 'cubic' },
        { time: 2, value: [10, 0, 0], easing: 'cubic' },
      ],
    },
  );

  await expect(page.getByTestId('curve-editor')).toBeVisible();
  const handle = page.getByTestId('curve-handle-select');
  await expect(handle).toBeVisible({ timeout: 10_000 });
  await expect(handle).toHaveValue('default');

  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(1.5));

  // Pick 'auto' → the middle key gets handleType 'auto' → render overshoots.
  await handle.selectOption('auto');
  await expect
    .poll(async () => {
      const kf = await page.evaluate(
        (id) =>
          (window as unknown as W).__basher_dag.getState().state.nodes[id].params.keyframes![1]
            .handleType,
        CH,
      );
      return kf;
    })
    .toBe('auto');
  await page.waitForFunction(
    () => (window as unknown as W).__basher_mesh_world_position!('n_box')![0] > 10,
  );
  expect(await renderX(page), 'auto → render overshoots').toBeGreaterThan(10);

  // Falsify: pick 'auto-clamped' → no overshoot.
  await handle.selectOption('auto-clamped');
  await page.waitForFunction(
    () => (window as unknown as W).__basher_mesh_world_position!('n_box')![0] <= 10.001,
  );
  expect(await renderX(page), 'auto-clamped → no overshoot').toBeLessThanOrEqual(10.001);
});
