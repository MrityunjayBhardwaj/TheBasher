// P6 W9 GOAL-BACKWARD GATE — 240-frame scrub holds 60fps (D-W9-6).
//
// This is THE phase acceptance: the entire W9 thesis is "advance the
// playhead via an rAF loop that touches no React state so the static
// geometry is not re-rendered 60×/sec." The proof is not "the code
// looks right" — it is a measured frame budget over a realistic scene.
//
// Method: seed ≥8 channels × ≥20 keyframes, open the drawer, drive
// setTime across 0→240 frames (4s @ 60fps) while an in-page collector
// records requestAnimationFrame deltas. Assert p95 frame interval
// ≤ 16.6ms AND no single interval > 33ms (no dropped-frame spike).
//
// If this FAILS: do NOT weaken the threshold and do NOT add a second
// perf workaround (base-layer rule — a second workaround means the
// frame is wrong). The escalation path is D-W9-6 (dirty-rect / offscreen
// tiling) as a separate documented decision needing a user checkpoint.
//
// Skipped on CI (no GPU / shared runners make the budget meaningless —
// same posture as acceptance #8). Measured locally on the M1 baseline.
//
// REF: docs/UI-SPEC.md §10 W9 row ("240-frame scrub holds 60fps on M1
// baseline"); memory/project_p6_w9_plan.md C5 goal-backward acceptance.

import { expect, test } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string }> };
      dispatch: (op: unknown) => void;
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
}

test('P6.W9-perf 240-frame scrub holds 60fps on M1 (p95 ≤ 16.6ms, max ≤ 33ms)', async ({
  page,
}) => {
  test.skip(!!process.env.CI, 'CI runners lack a real GPU; perf baseline measured locally');

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
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('basher.timelineDock.v1');
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_time);
  });
  await page.getByTestId('mode-switcher').selectOption('animate');

  // Seed a realistic-heavy scene: 10 channels × 24 keyframes = 240
  // diamonds across the static layer (exceeds the ≥8×≥20 floor).
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag!.getState();
    if (!Object.values(dag.state.nodes).some((n) => n.type === 'TimeSource')) {
      dag.dispatch({ type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} });
    }
    const timeId =
      Object.entries(dag.state.nodes).find(([, n]) => n.type === 'TimeSource')?.[0] ?? 'time';
    const ops: unknown[] = [
      {
        type: 'addNode',
        nodeId: 'sun',
        nodeType: 'DirectionalLight',
        params: {
          intensity: 7,
          position: [5, 5, 5],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          color: '#ffffff',
        },
      },
      {
        type: 'addNode',
        nodeId: 'layer',
        nodeType: 'AnimationLayer',
        params: { name: 'L', mute: false, solo: false, weight: 1, boneMask: [] },
      },
    ];
    for (let c = 0; c < 10; c++) {
      const id = `pch${c}`;
      const keyframes = [];
      for (let k = 0; k < 24; k++) {
        keyframes.push({ time: (k / 23) * 4, value: k, easing: 'linear' });
      }
      ops.push({
        type: 'addNode',
        nodeId: id,
        nodeType: 'KeyframeChannelNumber',
        params: { name: id, target: 'sun', paramPath: 'intensity', keyframes },
      });
      // P7.12 D-04: channel has no `time` socket — connect removed.
      ops.push({
        type: 'connect',
        from: { node: id, socket: 'out' },
        to: { node: 'layer', socket: 'animation' },
      });
    }
    dag.dispatchAtomic(ops, 'user', 'w9-perf-seed');
  });

  await page.getByTestId('timeline-drawer-toggle').click();
  await expect(page.getByTestId('timeline-canvas')).toBeVisible();

  // Drive 240 setTime steps (0 → 4s, i.e. frame 0 → 240) while an
  // in-page rAF collector records the interval between every animation
  // frame. The collector runs INSIDE the page so it measures the same
  // rAF cadence the TimelineCanvas playhead loop is competing for.
  const stats = await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const intervals: number[] = [];
    let last = performance.now();
    let running = true;
    function collect() {
      const now = performance.now();
      intervals.push(now - last);
      last = now;
      if (running) requestAnimationFrame(collect);
    }
    requestAnimationFrame(collect);

    // Step the clock once per animation frame so the scrub is paced like
    // a real drag, not a tight synchronous loop (which would not give
    // the rAF playhead a chance to run).
    for (let f = 0; f <= 240; f++) {
      w.__basher_time!.getState().setTime((f / 240) * 4);
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    running = false;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    // Drop the first 5 warm-up intervals (mount + first static paint).
    const measured = intervals.slice(5).sort((a, b) => a - b);
    const p = (q: number) =>
      measured[Math.min(measured.length - 1, Math.floor(q * measured.length))];
    return {
      count: measured.length,
      p50: p(0.5),
      p95: p(0.95),
      max: measured[measured.length - 1],
    };
  });

  // Surface the actual numbers in the test log regardless of pass/fail.
  // eslint-disable-next-line no-console
  console.log(
    `\n[P6.W9-perf] samples=${stats.count} p50=${stats.p50.toFixed(2)}ms ` +
      `p95=${stats.p95.toFixed(2)}ms max=${stats.max.toFixed(2)}ms\n`,
  );

  expect(stats.count).toBeGreaterThan(100);
  // 60fps frame budget = 16.6ms. p95 must hold it; no spike past 2 frames.
  expect(stats.p95).toBeLessThanOrEqual(16.6);
  expect(stats.max).toBeLessThanOrEqual(33);
});
