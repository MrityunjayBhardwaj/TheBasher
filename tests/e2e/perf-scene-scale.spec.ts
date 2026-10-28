// Scene-scale stress harness (issue #114). Answers two questions with
// measurement, not inference:
//
//   1. Where does the per-frame budget go — CPU eval vs React reconciliation
//      vs GPU — at increasing scene size?
//   2. How many polygons / draw calls can the engine hold at 60fps, separately
//      for two regimes:
//        - STATIC: idle scene, viewport rendering every frame (GPU-bound;
//          React + eval are ~0 because nothing re-renders).
//        - CHURN: an edit (setParam) per frame, forcing SceneFromDAG to
//          re-walk + reconcile every frame (CPU-bound: eval + React).
//
// The seam `__basher_perf_stress({ meshes, segments })` seeds N split-sphere
// nodes; `window.__basher_perf` drives the three-budget collector.
//
// IMPORTANT measurement caveats:
//   - Headless Chromium rasterizes via SwiftShader (software GL), so the
//     GPU-bound frame interval is PESSIMISTIC vs a real GPU. Run headed
//     (PWHEADED=1 / --headed) for the real-GPU polygon knee. The CPU budgets
//     (eval, React reconciliation) and the triangle/draw-call COUNTS are
//     accurate in either mode.
//   - This spec does not ASSERT a threshold — it is a measurement that always
//     passes and logs a table. The knee is read from the log.
//
// Skipped on CI (shared runners have no meaningful GPU and noisy CPU).

import { expect, test } from './_fixtures';

interface BudgetSummary {
  count: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}
interface PerfSummary {
  frame: BudgetSummary;
  react: BudgetSummary;
  reactOnly: BudgetSummary;
  eval: BudgetSummary;
  gpu: BudgetSummary;
  triangles: number;
  drawCalls: number;
  cacheHits: number;
  cacheMisses: number;
  evalCalls: number;
  commits: number;
  perFrame: Record<string, BudgetSummary>;
  commitsPerFrame: BudgetSummary;
}
interface PerfWindow {
  __basher_dag?: {
    getState: () => {
      state: { outputs: Record<string, { node: string }>; nodes: Record<string, unknown> };
      dispatch: (op: unknown) => void;
    };
  };
  __basher_perf?: {
    start: () => void;
    stop: () => PerfSummary;
    summary: () => PerfSummary;
  };
  __basher_perf_stress?: (opts: { meshes: number; segments?: number }) => {
    meshCount: number;
    segments: number;
    sceneId: string;
    firstMeshId: string | null;
  };
  __basher_perf_clear?: () => number;
  __basher_time?: {
    getState: () => { play: () => void; pause: () => void; setTime: (s: number) => void };
  };
  __basher_selection?: { getState: () => { select: (id: string | null) => void } };
}

// Ramp of scene sizes. Each level is a separate fresh page so OPFS / DAG state
// never leaks between levels. Override via PERF_MESHES="50,200,500".
const MESH_LEVELS = (process.env.PERF_MESHES ?? '50,200,500,1000,2000')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);
const SEGMENTS = parseInt(process.env.PERF_SEGMENTS ?? '24', 10);

interface LevelResult {
  meshes: number;
  triangles: number;
  drawCalls: number;
  staticFrameP95: number;
  staticFrameMean: number;
  churnFrameP95: number;
  churnReactP95: number;
  churnEvalP95: number;
  churnReactOnlyP95: number;
  cacheHitRate: number;
  evalCallsPerCommit: number;
}

test('perf scene-scale: three-budget knee sweep', async ({ page }) => {
  test.skip(!!process.env.CI, 'CI runners have no real GPU and noisy CPU; run locally');
  test.setTimeout(180_000);

  const results: LevelResult[] = [];

  for (const meshes of MESH_LEVELS) {
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
      const w = window as unknown as PerfWindow;
      return Boolean(w.__basher_dag && w.__basher_perf && w.__basher_perf_stress);
    });

    // Seed the scene.
    const seed = await page.evaluate(
      ({ meshes, segments }) => {
        const w = window as unknown as PerfWindow;
        return w.__basher_perf_stress!({ meshes, segments });
      },
      { meshes, segments: SEGMENTS },
    );

    // Let the scene mount + settle a few frames before measuring.
    await page.waitForTimeout(500);

    // REGIME 1 — STATIC: idle, viewport renders every frame, no edits.
    const staticSummary = await page.evaluate(async () => {
      const w = window as unknown as PerfWindow;
      w.__basher_perf!.start();
      // ~90 idle frames.
      for (let i = 0; i < 90; i++) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
      return w.__basher_perf!.stop();
    });

    // REGIME 2 — CHURN: one setParam per frame on the first stress mesh,
    // forcing SceneFromDAG to re-walk + reconcile every frame.
    const churnSummary = await page.evaluate(async (firstMeshId) => {
      const w = window as unknown as PerfWindow;
      const dag = w.__basher_dag!.getState();
      w.__basher_perf!.start();
      for (let i = 0; i < 90; i++) {
        // Nudge the mesh position so the changed node's cache key flips.
        dag.dispatch({
          type: 'setParam',
          nodeId: firstMeshId,
          paramPath: 'position',
          value: [Math.sin(i / 5) * 0.2, 0, 0],
        });
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
      return w.__basher_perf!.stop();
    }, seed.firstMeshId);

    const cacheTotal = churnSummary.cacheHits + churnSummary.cacheMisses;
    results.push({
      meshes,
      triangles: staticSummary.triangles,
      drawCalls: staticSummary.drawCalls,
      staticFrameP95: staticSummary.frame.p95,
      staticFrameMean: staticSummary.frame.mean,
      churnFrameP95: churnSummary.frame.p95,
      churnReactP95: churnSummary.react.p95,
      churnReactOnlyP95: churnSummary.reactOnly.p95,
      churnEvalP95: churnSummary.eval.p95,
      cacheHitRate: cacheTotal > 0 ? churnSummary.cacheHits / cacheTotal : 0,
      evalCallsPerCommit:
        churnSummary.commits > 0 ? churnSummary.evalCalls / churnSummary.commits : 0,
    });

    // Clean up before the next level (also proves the clear seam works).
    await page.evaluate(() => {
      const w = window as unknown as PerfWindow;
      w.__basher_perf_clear!();
    });
  }

  // Emit the table to the test log regardless of pass/fail.
  const fmt = (n: number) => n.toFixed(2).padStart(8);
  const lines = [
    '\n[perf scene-scale] segments/mesh=' + SEGMENTS + ' (headless=SwiftShader unless --headed)',
    'meshes |    tris | draws | STATIC f.p95 | STATIC f.mean | CHURN f.p95 | CHURN react.p95 | CHURN reactOnly | CHURN eval.p95 | cacheHit% | evalCalls/commit',
    '-------+---------+-------+--------------+---------------+-------------+-----------------+-----------------+----------------+-----------+-----------------',
  ];
  for (const r of results) {
    lines.push(
      `${String(r.meshes).padStart(6)} | ${String(r.triangles).padStart(7)} | ${String(
        r.drawCalls,
      ).padStart(5)} | ${fmt(r.staticFrameP95)}     | ${fmt(r.staticFrameMean)}      | ${fmt(
        r.churnFrameP95,
      )}    | ${fmt(r.churnReactP95)}        | ${fmt(r.churnReactOnlyP95)}        | ${fmt(
        r.churnEvalP95,
      )}       | ${(r.cacheHitRate * 100).toFixed(1).padStart(8)}% | ${r.evalCallsPerCommit
        .toFixed(1)
        .padStart(8)}`,
    );
  }
  console.log(lines.join('\n') + '\n');

  expect(results.length).toBe(MESH_LEVELS.length);
});

// #1727 — PLAYBACK regime. The table every frame-pipeline change (#1728–#1731) is judged by: the
// scene playing, at N = 100 / 200 / 400 / 800 static objects, two keyed nodes, with something
// selected and with nothing selected, timed per stage per frame (`__basher_perf().perFrame`).
//
// The two keyed nodes are the default box (a position channel) and a Group (a position channel)
// that holds a Group that holds the object the "selected" run selects — a nested object under an
// animated ancestor, the shape that sends the selected object's gizmo through the parent-world
// read on every playhead change (#1729). The stress objects are top-level and static.
//
// Columns, all per animation frame: the frame interval (p50 / p95); the stages' p50 — eval, the
// scene's React commits (`react`), the gizmo's (`react:gizmo`), the world-transform reads
// (`world`, also p95) and the CPU side of `renderer.render`; and React commits per frame (mean).
// Stages overlap — eval runs inside react and inside world — so they do not add up to the frame.
//
// Override the levels with PERF_PLAYBACK_OBJECTS="100,800". Run against a production build with
// `npm run perf:prod` (vite.perf.config.ts: production React, dev seams on).
const PLAYBACK_LEVELS = (process.env.PERF_PLAYBACK_OBJECTS ?? '100,200,400,800')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);
const PLAYBACK_FRAMES = parseInt(process.env.PERF_PLAYBACK_FRAMES ?? '120', 10);
const NESTED_ID = 'perfplay_selected';

interface PlaybackRow {
  objects: number;
  nodes: number;
  selected: boolean;
  s: PerfSummary;
}

test('perf playback: per-stage frame table, selection on and off', async ({ page }) => {
  test.skip(!!process.env.CI, 'CI runners have no real GPU and noisy CPU; run locally');
  test.setTimeout(600_000);
  const rows: PlaybackRow[] = [];

  for (const objects of PLAYBACK_LEVELS) {
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
      const w = window as unknown as PerfWindow;
      return Boolean(
        w.__basher_dag && w.__basher_perf && w.__basher_perf_stress && w.__basher_time,
      );
    });

    const nodes = await page.evaluate(
      ({ objects, nestedId }) => {
        const w = window as unknown as PerfWindow;
        w.__basher_perf_stress!({ meshes: objects, segments: 8 });
        const dag = w.__basher_dag!.getState();
        const sceneId = dag.state.outputs.scene.node;
        const ops: unknown[] = [
          {
            type: 'addNode',
            nodeId: 'perfplay_g1',
            nodeType: 'Group',
            params: { position: [0, 2, 0] },
          },
          {
            type: 'addNode',
            nodeId: 'perfplay_g2',
            nodeType: 'Group',
            params: { position: [1, 0, 0] },
          },
          {
            type: 'addNode',
            nodeId: `${nestedId}_data`,
            nodeType: 'SphereData',
            params: { radius: 0.3, widthSegments: 8, heightSegments: 8 },
          },
          {
            type: 'addNode',
            nodeId: nestedId,
            nodeType: 'Object',
            params: { position: [0, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
          {
            type: 'connect',
            from: { node: `${nestedId}_data`, socket: 'out' },
            to: { node: nestedId, socket: 'data' },
          },
          {
            type: 'connect',
            from: { node: nestedId, socket: 'out' },
            to: { node: 'perfplay_g2', socket: 'children' },
          },
          {
            type: 'connect',
            from: { node: 'perfplay_g2', socket: 'out' },
            to: { node: 'perfplay_g1', socket: 'children' },
          },
          {
            type: 'connect',
            from: { node: 'perfplay_g1', socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ];
        for (const [id, target, to] of [
          ['perfplay_ch_box', 'n_box', [0, 0, 150]],
          ['perfplay_ch_g1', 'perfplay_g1', [150, 2, 0]],
        ] as const) {
          ops.push({
            type: 'addNode',
            nodeId: id,
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
          });
        }
        (
          dag as unknown as { dispatchAtomic: (o: unknown[], s: string, d: string) => void }
        ).dispatchAtomic(ops, 'user', 'perf-playback fixture');
        return Object.keys(w.__basher_dag!.getState().state.nodes).length;
      },
      { objects, nestedId: NESTED_ID },
    );
    await page.waitForTimeout(500);

    for (const selected of [false, true]) {
      const s = await page.evaluate(
        async ({ selected, nestedId, frames }) => {
          const w = window as unknown as PerfWindow;
          const time = w.__basher_time!.getState();
          time.setTime(0);
          w.__basher_selection!.getState().select(selected ? nestedId : null);
          for (let i = 0; i < 10; i++)
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
          time.play();
          w.__basher_perf!.start();
          for (let i = 0; i < frames; i++)
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
          const out = w.__basher_perf!.stop();
          time.pause();
          return out;
        },
        { selected, nestedId: NESTED_ID, frames: PLAYBACK_FRAMES },
      );
      rows.push({ objects, nodes, selected, s });
    }
  }

  const f = (n: number | undefined) => (n ?? 0).toFixed(2).padStart(7);
  // A stage that never ran prints "—"; one that ran below the timer's resolution (the browser
  // coarsens performance.now() to 0.1 ms) prints "<0.1", never 0.00.
  const st = (r: PlaybackRow, k: string, q: 'p50' | 'p95' = 'p50') => {
    const v = r.s.perFrame[k]?.[q];
    if (v === undefined) return '—'.padStart(7);
    return v < 0.1 ? '<0.1'.padStart(7) : f(v);
  };
  const lines = [
    `\n[perf playback] ${PLAYBACK_FRAMES} frames playing, 2 keyed (n_box, a Group over the selected object), ms per frame`,
    'objects | nodes | sel | frame p50 | frame p95 |  eval  |  react | r:gizmo |  world | world p95 | render | sh:inputs | sh:mark | commits/f',
    '--------+-------+-----+-----------+-----------+--------+--------+---------+--------+-----------+--------+-----------+---------+----------',
  ];
  for (const r of rows) {
    lines.push(
      `${String(r.objects).padStart(7)} | ${String(r.nodes).padStart(5)} | ${r.selected ? 'yes' : ' no'} | ${f(
        r.s.frame.p50,
      )}   | ${f(r.s.frame.p95)}   |${st(r, 'eval')} |${st(r, 'react')} | ${st(r, 'react:gizmo')} |${st(
        r,
        'world',
      )} |   ${st(r, 'world', 'p95')} |${st(r, 'render')} |   ${st(r, 'shadow:inputs')} | ${st(r, 'shadow:mark')} | ${r.s.commitsPerFrame.mean.toFixed(2).padStart(8)}`,
    );
  }
  console.log(lines.join('\n') + '\n');
  // A measurement, not a threshold — but a table of zeros measured nothing.
  expect(rows.length).toBe(PLAYBACK_LEVELS.length * 2);
  for (const r of rows) {
    expect(r.s.frame.count, `${r.objects}/${r.selected}: frames sampled`).toBeGreaterThan(
      PLAYBACK_FRAMES / 2,
    );
    expect(
      r.s.perFrame.render?.p50 ?? 0,
      `${r.objects}/${r.selected}: render timed`,
    ).toBeGreaterThan(0);
  }
  const sel = rows.filter((r) => r.selected);
  for (const r of sel) {
    // The selected object's gizmo reads its parent's world on every playhead change: the stage was
    // timed, however short it was.
    expect(
      r.s.perFrame.world,
      `${r.objects}: the selected object's world reads timed`,
    ).toBeDefined();
  }
});
