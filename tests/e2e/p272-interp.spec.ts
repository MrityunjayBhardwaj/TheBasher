// p272 (#272) — a per-keyframe equation interpolation (back-out) makes the
// rendered box OVERSHOOT past its target mid-segment; render == read (H40).
import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => { dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_mesh_world_position?: (id: string) => [number, number, number] | null;
  __basher_evaluated_transform?: (
    id: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { position: [number, number, number] } | null;
}

test('back-out interpolation overshoots on render+read', async ({ page }) => {
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
  // Position 0→10 over t[0,2], destination key eases with back-OUT (overshoot past 10).
  await page.evaluate(() => {
    (window as unknown as W).__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'tmp272_ch',
          nodeType: 'KeyframeChannelVec3',
          params: {
            name: 'position',
            target: 'n_box',
            paramPath: 'position',
            keyframes: [
              { time: 0, value: [0, 0, 0], easing: 'linear' },
              { time: 2, value: [10, 0, 0], easing: 'back', ease: 'out' },
            ],
          },
        },
      ],
      'e2e',
      'tmp272-seed',
    );
  });
  // t=1.7 (u=0.85): back-out is well past 10 (overshoot); linear would give 8.5.
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(1.7));
  await page.waitForFunction(() => {
    const p = (window as unknown as W).__basher_mesh_world_position!('n_box');
    return p !== null && p[0] > 10;
  });
  const render = (await page.evaluate(() =>
    (window as unknown as W).__basher_mesh_world_position!('n_box'),
  ))![0];
  const read = await page.evaluate(() => {
    const t = (window as unknown as W).__basher_evaluated_transform!('n_box', {
      time: { frame: 102, seconds: 1.7, normalized: 0 },
    });
    return t ? t.position[0] : null;
  });
  expect(render, 'back-out overshoots past target').toBeGreaterThan(10);
  expect(read!, 'read overshoots too').toBeGreaterThan(10);
  expect(render, 'render == read (H40)').toBeCloseTo(read!, 3);
});
