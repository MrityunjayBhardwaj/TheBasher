// Fox-duplication playback benchmark (issue #114) — the v0.7 perf benchmark.
//
// Load the Khronos Fox.glb (skinned + animated), duplicate it N times (each
// import is the SAME bytes under a DIFFERENT assetRef → N independent fox
// subtrees, all wired to the same default `n_time` TimeSource), call
// `useTimeStore.play()`, profile ~5s of real playback, read the three budgets.
//
// Why this benchmark, separate from `perf-scene-scale.spec.ts`:
//   - perf-scene-scale measures the synthetic SphereMesh case: pure-evaluator
//     cache hits ≈100%, `eval p95 = 0`, so the React budget dominates.
//   - This spec measures the SKINNED + ANIMATED case: TransformClip is
//     time-dependent (its hash flips with the TimeSource), so its evaluate()
//     misses cache every frame. EXPECT eval ≠ 0 here. Whether it dominates
//     or React reconciliation does is the question the benchmark answers
//     (B13 predicts React still wins — let the measurement say).
//
// Fixture: Fox.glb is the canonical Khronos sample (KhronosGroup/glTF-Sample-
// Models, Fox/glTF-Binary/Fox.glb — 162KB, self-contained, three clips:
// Survey/Walk/Run). It is NOT committed to the repo (binary). The spec
// looks for it at PERF_FOX_PATH (default `/tmp/real-gltf/Fox.glb`) and
// skips with a clear message if absent. Bytes are served to the page via
// `page.route` so no `public/` write happens.
//
// Skipped on CI (shared runners have no meaningful GPU). Run headed
// (`PWHEADED=1` / `--headed`) for real-GPU numbers — headless Chromium
// rasterizes via SwiftShader.
//
// REF: src/perf/frameProfiler.ts, src/perf/PerfProbe.tsx, src/app/boot.ts
// (`__basher_importGltf` + `__basher_writeOpfsBytes` + `__basher_perf` seams),
// src/core/import/gltfImportChain.ts:307-349 (the auto-wire that joins every
// imported clip to the same `n_time`), src/app/Clock.tsx + timeStore.tick
// (playback driver; `play()` must be called for tick to advance), [[H48]],
// dharana [[B13]] (SceneFromDAG render-reconciliation boundary). Issue #114.

import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from './_fixtures';

const FOX_PATH = process.env.PERF_FOX_PATH ?? '/tmp/real-gltf/Fox.glb';
const FOX_COUNTS = (process.env.PERF_FOX_COUNTS ?? '2,4,6,8')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);
const PLAYBACK_SECONDS = parseFloat(process.env.PERF_FOX_SECONDS ?? '5');

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
interface SkinHandle {
  boneCount: number;
  bound: boolean;
  vertex: (i: number) => [number, number, number];
}
interface PerfWindow {
  __basher_dag?: { getState: () => { state: { outputs: Record<string, { node: string }> } } };
  __basher_perf?: { start: () => void; stop: () => PerfSummary; summary: () => PerfSummary };
  __basher_importGltf?: (buffer: ArrayBuffer, assetRef: string) => Promise<unknown>;
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_time?: {
    getState: () => {
      play: () => void;
      pause: () => void;
      setTime: (s: number) => void;
      seconds: number;
    };
  };
  __basher_gltf_skin?: () => SkinHandle | null;
}

interface LevelResult {
  foxes: number;
  triangles: number;
  drawCalls: number;
  frameP95: number;
  frameMean: number;
  reactP95: number;
  reactOnlyP95: number;
  evalP95: number;
  evalCallsPerCommit: number;
  cacheHitRate: number;
  commits: number;
}

test('perf fox-duplication playback: skinned+animated three-budget sweep', async ({ page }) => {
  test.skip(!!process.env.CI, 'CI runners have no real GPU and noisy CPU; run locally');
  test.skip(
    !existsSync(FOX_PATH),
    `Fox.glb missing at ${FOX_PATH}. Download KhronosGroup/glTF-Sample-Models ` +
      `Fox/glTF-Binary/Fox.glb (162KB) to that path, or set PERF_FOX_PATH.`,
  );
  test.setTimeout(240_000);

  const foxBytes = readFileSync(FOX_PATH);
  // Serve Fox.glb to the page without touching public/. Route persists across
  // page.goto + reload within the test.
  await page.route('**/__perf_fox.glb', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'model/gltf-binary',
      body: foxBytes,
    }),
  );

  const results: LevelResult[] = [];

  for (const foxCount of FOX_COUNTS) {
    // Fresh page per level so OPFS / DAG state never leaks between levels.
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
        w.__basher_dag &&
        w.__basher_perf &&
        w.__basher_importGltf &&
        w.__basher_writeOpfsBytes &&
        w.__basher_time,
      );
    });

    // Import N foxes — same bytes, N different OPFS paths. Each import
    // auto-wires its TransformClip chain to the same `n_time` TimeSource
    // (gltfImportChain.ts:249, 333), so all N foxes will animate together
    // when timeStore.play() is called. Stacked at origin (no per-instance
    // position in the seam) — all in-frustum by construction; overdraw is
    // a controlled distortion identical at every level, so it does not
    // distort the React-reconciliation knee we are measuring.
    await page.evaluate(
      async ({ count }) => {
        const w = window as unknown as PerfWindow;
        const buf = await fetch('/__perf_fox.glb').then((r) => r.arrayBuffer());
        const u8 = new Uint8Array(buf);
        for (let i = 0; i < count; i++) {
          const ref = `assets/perf-fox-${i}.glb`;
          await w.__basher_writeOpfsBytes!(ref, u8);
          await w.__basher_importGltf!(buf, ref);
        }
      },
      { count: foxCount },
    );

    // Validity gate 1 — at least one fox registered a bound SkinnedMesh.
    // (`__basher_gltf_skin` is a global "last mounted" seam — N foxes all
    // call register; we only need ONE proven bound to trust the numbers.)
    await page.waitForFunction(
      () => {
        const w = window as unknown as PerfWindow;
        return Boolean(w.__basher_gltf_skin && w.__basher_gltf_skin() !== null);
      },
      { timeout: 30_000 },
    );

    // Validity gate 2 — a vertex actually moves between t=0 and a mid-clip
    // tick. The H46 lesson applied to perf: don't infer that the fox is
    // animating from "import returned" — observe the rendered surface.
    // If this delta is zero, the playback measurement that follows would
    // be the wrong cost (a frozen scene's reconciliation, not a playing
    // scene's). The Fox "Survey" clip drives head/body joint rotations,
    // so a tip vertex weighted to any animated bone will move.
    const vertexDelta = await page.evaluate(async () => {
      const w = window as unknown as PerfWindow;
      w.__basher_time!.getState().pause();
      w.__basher_time!.getState().setTime(0);
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const v0 = w.__basher_gltf_skin!()!.vertex(0);
      w.__basher_time!.getState().setTime(0.3);
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const v1 = w.__basher_gltf_skin!()!.vertex(0);
      return Math.hypot(v0[0] - v1[0], v0[1] - v1[1], v0[2] - v1[2]);
    });
    expect(
      vertexDelta,
      `fox @ count=${foxCount} did not deform (delta=${vertexDelta}); ` +
        'playback measurement would be of a frozen scene — bug somewhere upstream',
    ).toBeGreaterThan(0);

    // Reset time to 0 and let the scene settle a few frames before measuring.
    await page.evaluate(() => {
      const w = window as unknown as PerfWindow;
      w.__basher_time!.getState().pause();
      w.__basher_time!.getState().setTime(0);
    });
    await page.waitForTimeout(300);

    // PLAYBACK MEASUREMENT — start the profiler, call play() so the real
    // Clock.tsx rAF loop drives timeStore.tick (the same code path users
    // hit), wait PLAYBACK_SECONDS of real time, pause, stop.
    const summary = await page.evaluate(async (seconds) => {
      const w = window as unknown as PerfWindow;
      w.__basher_perf!.start();
      w.__basher_time!.getState().play();
      await new Promise<void>((r) => setTimeout(r, seconds * 1000));
      w.__basher_time!.getState().pause();
      return w.__basher_perf!.stop();
    }, PLAYBACK_SECONDS);

    const cacheTotal = summary.cacheHits + summary.cacheMisses;
    results.push({
      foxes: foxCount,
      triangles: summary.triangles,
      drawCalls: summary.drawCalls,
      frameP95: summary.frame.p95,
      frameMean: summary.frame.mean,
      reactP95: summary.react.p95,
      reactOnlyP95: summary.reactOnly.p95,
      evalP95: summary.eval.p95,
      evalCallsPerCommit: summary.commits > 0 ? summary.evalCalls / summary.commits : 0,
      cacheHitRate: cacheTotal > 0 ? summary.cacheHits / cacheTotal : 0,
      commits: summary.commits,
    });
  }

  // Emit the table to the test log regardless of pass/fail.
  const fmt = (n: number) => n.toFixed(2).padStart(8);
  const lines = [
    `\n[perf fox-benchmark] playback=${PLAYBACK_SECONDS}s ` +
      '(headless=SwiftShader unless --headed)',
    'foxes |    tris | draws | frame.p95 | frame.mean | react.p95 | reactOnly.p95 |  eval.p95 | evalCalls/commit | cacheHit% | commits',
    '------+---------+-------+-----------+------------+-----------+---------------+-----------+------------------+-----------+--------',
  ];
  for (const r of results) {
    lines.push(
      `${String(r.foxes).padStart(5)} | ${String(r.triangles).padStart(7)} | ${String(
        r.drawCalls,
      ).padStart(5)} | ${fmt(r.frameP95)}  | ${fmt(r.frameMean)}   | ${fmt(r.reactP95)}  | ${fmt(
        r.reactOnlyP95,
      )}      | ${fmt(r.evalP95)}  | ${r.evalCallsPerCommit.toFixed(1).padStart(16)} | ${(
        r.cacheHitRate * 100
      )
        .toFixed(1)
        .padStart(8)}% | ${String(r.commits).padStart(7)}`,
    );
  }
  console.log(lines.join('\n') + '\n');

  expect(results.length).toBe(FOX_COUNTS.length);
});
