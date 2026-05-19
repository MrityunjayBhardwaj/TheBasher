// P6 W9 acceptance — imperative TimelineCanvas hot-path (D-W9-2/3/4) +
// the dharana-flagged R3F-no-remount risk.
//
// The SVG Dopesheet was replaced by a canvas-2D surface that advances
// the playhead via an rAF loop touching NO React state (the D-W9-3
// escape hatch). Per D-W9-4 the canvas is NEVER pixel-diffed; the
// React-observable contract is the mirror-attr set on the host div:
//   data-frame-count / data-channel-count / data-rendered-keyframes
//   data-playhead-px / data-frame
//
// Coverage:
//   #1 scrub → data-playhead-px strictly increases AND
//      data-rendered-keyframes is CONSTANT across the scrub (diamonds
//      survive the playhead — the C4 strip-restore working). Also
//      exercises the C4 DAG/resize-repaint path: a mid-scrub DAG change
//      resets lastPlayheadXRef=-1 and the playhead must re-stroke.
//   #2 culling (D-W9-6): keyframes beyond the visible range are not
//      painted → rendered < total.
//   #3 ref↔store cross-check (D-W9-9): frame derived from
//      data-playhead-px == timeline-dock-frame-readout every sample.
//   #4 R3F-no-remount: reuse the acceptance #9 / P6.W7#8 Canvas-
//      preservation harness — toggle drawer 3x + tab Dopesheet↔Curve
//      (forcing TimelineCanvas remount) → R3F canvas DOM identity stable.
//
// REF: docs/UI-SPEC.md §9 (W9 wiring) + §10 W9 row; D-W9-2/3/4/6/8/9;
// acceptance #9 + p6-w7-floating-toolbar.spec.ts P6.W7#8 (harness reuse);
// memory/project_p6_w9_plan.md C5.

import { expect, test } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string }> };
      dispatch: (op: unknown) => void;
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_time?: {
    getState: () => {
      setTime: (s: number) => void;
      setDuration: (s: number) => void;
      seconds: number;
    };
  };
  __basher_viewport?: { getState: () => { timelineDrawerOpen: boolean } };
}

/**
 * Seed a realistic animation scene: one layer + N channels, each with
 * `kfPerChannel` keyframes spread across [0, span] seconds. Returns the
 * total keyframe count so the culling spec can compare.
 */
async function seedScene(
  page: import('@playwright/test').Page,
  channels: number,
  kfPerChannel: number,
  span: number,
): Promise<number> {
  return await page.evaluate(
    ({ channels, kfPerChannel, span }) => {
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
      let total = 0;
      for (let c = 0; c < channels; c++) {
        const id = `ch${c}`;
        const keyframes = [];
        for (let k = 0; k < kfPerChannel; k++) {
          keyframes.push({
            time: (k / (kfPerChannel - 1)) * span,
            value: k,
            easing: 'linear',
          });
          total++;
        }
        ops.push({
          type: 'addNode',
          nodeId: id,
          nodeType: 'KeyframeChannelNumber',
          params: { name: id, target: 'sun', paramPath: 'intensity', keyframes },
        });
        ops.push({
          type: 'connect',
          from: { node: timeId, socket: 'out' },
          to: { node: id, socket: 'time' },
        });
        ops.push({
          type: 'connect',
          from: { node: id, socket: 'out' },
          to: { node: 'layer', socket: 'animation' },
        });
      }
      dag.dispatchAtomic(ops, 'user', 'w9-seed');
      return total;
    },
    { channels, kfPerChannel, span },
  );
}

async function attr(page: import('@playwright/test').Page, name: string): Promise<string | null> {
  return await page.getByTestId('timeline-canvas').getAttribute(name);
}

test.beforeEach(async ({ page }) => {
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
    return Boolean(w.__basher_dag && w.__basher_time && w.__basher_viewport);
  });
  await page.getByTestId('mode-switcher').selectOption('animate');
});

test('P6.W9#1 scrub advances data-playhead-px monotonically; diamonds survive (count constant) incl. the C4 DAG-repaint path', async ({
  page,
}) => {
  await seedScene(page, 4, 6, 4);
  await page.getByTestId('timeline-drawer-toggle').click();
  await expect(page.getByTestId('timeline-canvas')).toBeVisible();

  // The rendered-keyframes count after the static layer first paints.
  // The rAF playhead must NOT change it while scrubbing (the whole
  // point of the cached static layer + strip restore — D-W9-3).
  await expect.poll(async () => attr(page, 'data-rendered-keyframes')).not.toBe(null);
  const baselineRendered = await attr(page, 'data-rendered-keyframes');
  expect(Number(baselineRendered)).toBe(24); // 4ch × 6kf, all in [0,4]

  const samples: number[] = [];
  for (let f = 0; f <= 8; f++) {
    const t = (f / 8) * 4; // 0 → 4s
    await page.evaluate((sec) => {
      const w = window as unknown as BasherWindow;
      w.__basher_time!.getState().setTime(sec);
    }, t);
    // The playhead moves on the rAF loop; poll until data-playhead-px
    // reflects the new time (it reads currentFrameRef/seconds each tick).
    await expect
      .poll(async () => Number(await attr(page, 'data-playhead-px')))
      .toBeGreaterThanOrEqual(samples.length ? samples[samples.length - 1] : 0);
    samples.push(Number(await attr(page, 'data-playhead-px')));
    // Diamonds must not be erased / re-counted by the playhead pass.
    expect(Number(await attr(page, 'data-rendered-keyframes'))).toBe(Number(baselineRendered));
  }
  // Strictly increasing overall (0s → 4s moves the playhead right).
  expect(samples[samples.length - 1]).toBeGreaterThan(samples[0]);

  // C4 path: a mid-scrub DAG change fully repaints the static layer and
  // resets lastPlayheadXRef=-1 so the next rAF tick re-strokes the
  // playhead even at an unchanged x. Add a 5th channel, then nudge time
  // — the playhead must re-appear (data-playhead-px stays a real px).
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag!.getState();
    const timeId =
      Object.entries(dag.state.nodes).find(([, n]) => n.type === 'TimeSource')?.[0] ?? 'time';
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'ch_extra',
          nodeType: 'KeyframeChannelNumber',
          params: {
            name: 'extra',
            target: 'sun',
            paramPath: 'intensity',
            keyframes: [
              { time: 0, value: 0, easing: 'linear' },
              { time: 4, value: 1, easing: 'linear' },
            ],
          },
        },
        {
          type: 'connect',
          from: { node: timeId, socket: 'out' },
          to: { node: 'ch_extra', socket: 'time' },
        },
        {
          type: 'connect',
          from: { node: 'ch_extra', socket: 'out' },
          to: { node: 'layer', socket: 'animation' },
        },
      ],
      'user',
      'w9-mid-scrub-dag',
    );
  });
  await expect.poll(async () => Number(await attr(page, 'data-rendered-keyframes'))).toBe(26); // 24 + 2 new keyframes, all in range
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_time!.getState().setTime(3.5);
  });
  await expect.poll(async () => Number(await attr(page, 'data-playhead-px'))).toBeGreaterThan(0);
});

test('P6.W9#2 culling — keyframes beyond the visible range are not painted (D-W9-6)', async ({
  page,
}) => {
  // Seed channels with keyframes spread over 12s, but duration is 4s.
  // The static layer's visible range is [0, durationSeconds] (C3), so
  // keyframes past 4s are culled — rendered < total.
  const total = await seedScene(page, 3, 8, 12);
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_time!.getState().setDuration(4);
  });
  await page.getByTestId('timeline-drawer-toggle').click();
  await expect(page.getByTestId('timeline-canvas')).toBeVisible();

  await expect
    .poll(async () => {
      const r = Number(await attr(page, 'data-rendered-keyframes'));
      return Number.isFinite(r) && r > 0 ? r : null;
    })
    .not.toBe(null);
  const rendered = Number(await attr(page, 'data-rendered-keyframes'));
  expect(rendered).toBeGreaterThan(0);
  expect(rendered).toBeLessThan(total); // culling is real

  // Widen the duration → the visible range grows → more diamonds paint.
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_time!.getState().setDuration(12);
  });
  await expect
    .poll(async () => Number(await attr(page, 'data-rendered-keyframes')))
    .toBeGreaterThan(rendered);
});

test('P6.W9#3 ref↔store cross-check — playhead frame == frame readout every sample (D-W9-9)', async ({
  page,
}) => {
  await seedScene(page, 2, 5, 4);
  await page.getByTestId('timeline-drawer-toggle').click();
  await expect(page.getByTestId('timeline-canvas')).toBeVisible();

  for (let f = 0; f <= 6; f++) {
    const sec = (f / 6) * 4;
    await page.evaluate((s) => {
      const w = window as unknown as BasherWindow;
      w.__basher_time!.getState().setTime(s);
    }, sec);
    const expectedFrame = Math.round(sec * 60);
    // The dock readout is "frame / total"; its frame is timeStore.frame.
    await expect
      .poll(async () =>
        (await page.getByTestId('timeline-dock-frame-readout').textContent())?.trim(),
      )
      .toMatch(new RegExp(`^${expectedFrame} / `));
    // The canvas rAF loop writes data-frame from currentFrameRef.current
    // — the escape-hatch mirror. It must equal timeStore.frame (D-W9-9
    // never-diverge invariant: written at the timeStore chokepoint).
    await expect.poll(async () => Number(await attr(page, 'data-frame'))).toBe(expectedFrame);
  }
});

test('P6.W9#4 R3F Canvas does NOT remount across drawer toggles + Dopesheet↔Curve tab churn (dharana top risk, V8/K1#6)', async ({
  page,
}) => {
  // Reuse the acceptance #9 / P6.W7#8 Canvas-preservation harness: stamp
  // the R3F viewport canvas, then perform every operation that could
  // remount TimelineCanvas (which lives in a structurally-disjoint
  // subtree). If the React trees were entangled, the stamp is gone.
  await expect(page.getByTestId('viewport')).toBeVisible();
  const tag = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="viewport"] canvas') as HTMLCanvasElement | null;
    if (!c) throw new Error('R3F canvas missing');
    (c as unknown as { __basherTag: string }).__basherTag = 'w9-before';
    return (c as unknown as { __basherTag: string }).__basherTag;
  });
  expect(tag).toBe('w9-before');

  for (let i = 0; i < 3; i++) {
    // Open drawer (mounts TimelineCanvas), churn tabs (Curve forces the
    // canvas pane hidden; Dopesheet re-shows it — exercises mount/show
    // churn), close drawer (unmounts TimelineCanvas entirely).
    await page.getByTestId('timeline-drawer-toggle').click();
    await expect(page.getByTestId('timeline-canvas-pane')).toBeVisible();
    await page.getByTestId('timeline-tab-curve').click();
    await expect(page.getByTestId('curve-editor-pane')).toHaveAttribute('data-active', 'true');
    await page.getByTestId('timeline-tab-dopesheet').click();
    await expect(page.getByTestId('timeline-canvas-pane')).toHaveAttribute('data-active', 'true');
    await page.getByTestId('timeline-drawer-toggle').click();
  }

  const tagAfter = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="viewport"] canvas') as HTMLCanvasElement | null;
    return (c as unknown as { __basherTag?: string } | null)?.__basherTag ?? null;
  });
  // Same DOM node → same WebGL context → V8/K1#6 holds. If this fails,
  // W9 is structurally wrong (TimelineCanvas mount entangled with the
  // R3F tree) — NOT a patch-the-canvas situation.
  expect(tagAfter).toBe('w9-before');
});
