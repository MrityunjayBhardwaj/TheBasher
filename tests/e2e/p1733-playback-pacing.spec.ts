// #1733 — playback keeps real time by dropping frames, or plays every frame and slows down.
//
// Blender's playback step (screen_ops.cc:6149-6191) has two modes. "Drop frames": the frame
// advances by the real time elapsed since the last step, in whole frames, the fraction carried
// to the next step — a slow scene skips frames and stays in time. "Play every frame": one frame
// per step — a slow scene plays slower, but shows every frame.
//
// The measurement: the playback-table fixture (N stress spheres, a keyed box, a keyed Group over
// a nested selected sphere) plus an optional busy-wait of LOAD_MS in each animation frame, so a
// frame can be made slower than the old 100 ms clamp. For each mode, over WINDOW_MS of playback:
//   - draws/s: animation frames per real second (what the screen got);
//   - speed: playhead seconds advanced per real second (1.00 = real time);
//   - frames/draw: how many scene frames each draw advanced, and how many draws showed no new frame.
//
// What must hold: in "drop frames" the speed is real time whatever the load; in "play every
// frame" each draw shows the next frame and none is skipped. Both are read off the playhead the
// time store holds, sampled in the animation frame itself.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';

const LEVELS = (process.env.P1733_OBJECTS ?? '400,800').split(',').map((n) => parseInt(n, 10));
const LOAD_MS = (process.env.P1733_LOAD_MS ?? '0,150').split(',').map((n) => parseFloat(n));
const WINDOW_MS = parseInt(process.env.P1733_WINDOW_MS ?? '4000', 10);
const FPS = 60;

interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene: { node: string } }; nodes: Record<string, unknown> };
      dispatchAtomic: (ops: unknown[], source?: string, description?: string) => unknown;
    };
  };
  __basher_time: {
    getState: () => {
      setTime: (s: number) => void;
      play: () => void;
      pause: () => void;
      filmSeconds: number;
      sync?: string;
      setSync?: (mode: string) => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_perf_stress: (opts: { meshes: number; segments?: number }) => unknown;
}

interface Row {
  objects: number;
  load: number;
  mode: string;
  draws: number;
  drawsPerSec: number;
  speed: number;
  stepMean: number;
  stepMax: number;
  stalled: number;
  readout: string | null;
}

async function stage(page: Page, objects: number): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* not present */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(w.__basher_dag && w.__basher_time && w.__basher_perf_stress);
  });
  await page.evaluate((objects) => {
    const w = window as unknown as W;
    w.__basher_perf_stress({ meshes: objects, segments: 8 });
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene.node;
    dag.dispatchAtomic(
      [
        { type: 'addNode', nodeId: 'pace_g', nodeType: 'Group', params: { position: [0, 2, 0] } },
        {
          type: 'addNode',
          nodeId: 'pace_sel_data',
          nodeType: 'SphereData',
          params: { radius: 0.3, widthSegments: 8, heightSegments: 8 },
        },
        {
          type: 'addNode',
          nodeId: 'pace_sel',
          nodeType: 'Object',
          params: { position: [0, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
        {
          type: 'connect',
          from: { node: 'pace_sel_data', socket: 'out' },
          to: { node: 'pace_sel', socket: 'data' },
        },
        {
          type: 'connect',
          from: { node: 'pace_sel', socket: 'out' },
          to: { node: 'pace_g', socket: 'children' },
        },
        {
          type: 'connect',
          from: { node: 'pace_g', socket: 'out' },
          to: { node: sceneId, socket: 'children' },
        },
        ...(
          [
            ['pace_ch_box', 'n_box', [0, 0, 150]],
            ['pace_ch_g', 'pace_g', [150, 2, 0]],
          ] as const
        ).map(([nodeId, target, to]) => ({
          type: 'addNode',
          nodeId,
          nodeType: 'KeyframeChannelVec3',
          params: {
            name: 'position',
            target,
            paramPath: 'position',
            keyframes: [
              { time: 0, value: [0, 2, 0], easing: 'linear' },
              { time: 60, value: to, easing: 'linear' },
            ],
          },
        })),
        // A long range, so the window never reaches End and loops.
        { type: 'setParam', nodeId: sceneId, paramPath: 'frameEnd', value: 3600 },
      ],
      'user',
      'p1733-pacing fixture',
    );
    w.__basher_selection.getState().select('pace_sel');
  }, objects);
  await page.waitForTimeout(500);
}

async function measure(page: Page, mode: string, load: number) {
  return page.evaluate(
    async ({ mode, load, windowMs }) => {
      const w = window as unknown as W;
      const time = w.__basher_time.getState();
      time.setSync?.(mode);
      time.setTime(0);
      for (let i = 0; i < 10; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const steps: number[] = [];
      const at: number[] = [];
      let running = true;
      // The busy frame and the sample share each animation frame; the sample is taken after the
      // clock's own callback (registered first, at mount), so it reads what this draw shows.
      const tick = () => {
        if (!running) return;
        const until = performance.now() + load;
        while (performance.now() < until) {
          /* busy frame */
        }
        steps.push(w.__basher_time.getState().filmSeconds);
        at.push(performance.now());
        requestAnimationFrame(tick);
      };
      time.play();
      // Skip the first steps: the clock's first delta is measured from before play.
      for (let i = 0; i < 3; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const t0 = performance.now();
      requestAnimationFrame(tick);
      await new Promise((r) => setTimeout(r, windowMs));
      running = false;
      const elapsed = (performance.now() - t0) / 1000;
      const readout =
        document.querySelector('[data-testid="timebar-fps"]')?.textContent?.trim() ?? null;
      w.__basher_time.getState().pause();
      return { steps, at, elapsed, readout, sync: w.__basher_time.getState().sync ?? 'none' };
    },
    { mode, load, windowMs: WINDOW_MS },
  );
}

test('#1733 playback pacing: drop frames keeps real time, every frame shows every frame', async ({
  page,
}) => {
  test.skip(!!process.env.CI, 'CI runners have no real GPU and noisy CPU; run locally');
  test.setTimeout(600_000);
  const rows: Row[] = [];
  for (const objects of LEVELS) {
    await stage(page, objects);
    for (const load of LOAD_MS) {
      for (const mode of ['drop', 'every']) {
        const m = await measure(page, mode, load);
        const frames = m.steps.map((s) => Math.round(s * FPS));
        const deltas = frames.slice(1).map((f, i) => f - frames[i]);
        // Speed between the first and last sample, each timed in its own animation frame.
        const advanced = m.steps[m.steps.length - 1] - m.steps[0];
        const spanned = (m.at[m.at.length - 1] - m.at[0]) / 1000;
        rows.push({
          objects,
          load,
          mode: m.sync,
          draws: m.steps.length,
          drawsPerSec: m.steps.length / m.elapsed,
          speed: advanced / spanned,
          stepMean: deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length),
          stepMax: Math.max(0, ...deltas),
          stalled: deltas.filter((d) => d === 0).length,
          readout: m.readout,
        });
      }
    }
  }
  const lines = [
    `\n[p1733 pacing] ${WINDOW_MS} ms of playback per row, nested sphere selected`,
    'objects | load ms | mode  | draws | draws/s | speed | frames/draw mean | max | no new frame | readout',
    '--------+---------+-------+-------+---------+-------+------------------+-----+--------------+--------',
  ];
  for (const r of rows) {
    lines.push(
      `${String(r.objects).padStart(7)} | ${String(r.load).padStart(7)} | ${r.mode.padEnd(5)} | ${String(
        r.draws,
      ).padStart(
        5,
      )} | ${r.drawsPerSec.toFixed(1).padStart(7)} | ${r.speed.toFixed(2).padStart(5)} | ${r.stepMean
        .toFixed(2)
        .padStart(16)} | ${String(r.stepMax).padStart(3)} | ${String(r.stalled).padStart(12)} | ${
        r.readout ?? '—'
      }`,
    );
  }
  console.log(lines.join('\n') + '\n');
  expect(rows.length).toBe(LEVELS.length * LOAD_MS.length * 2);
  for (const r of rows) {
    expect(r.draws, `${r.objects}/${r.load}/${r.mode}: the window drew`).toBeGreaterThan(3);
    if (process.env.P1733_BASELINE) continue;
    if (r.mode === 'drop') {
      // Real time, whatever the load: within 10% over the window.
      expect(r.speed, `${r.objects}/${r.load} drop: speed`).toBeGreaterThan(0.9);
      expect(r.speed, `${r.objects}/${r.load} drop: speed`).toBeLessThan(1.1);
    } else {
      // Every frame: no draw skips a frame (a draw may show the same frame on a fast display).
      expect(r.stepMax, `${r.objects}/${r.load} every: largest step`).toBe(1);
    }
    expect(
      r.readout,
      `${r.objects}/${r.load}/${r.mode}: the Timebar shows the achieved fps`,
    ).toMatch(/fps/);
  }
});
