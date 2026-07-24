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
