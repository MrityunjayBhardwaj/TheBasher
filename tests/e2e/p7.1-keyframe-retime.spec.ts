// P7.1 GOAL-BACKWARD GATE — keyframe drag-to-move-time (D-W9-7).
//
// THIS green = the phase GOAL met: a director drags a keyframe diamond
// horizontally on the TimelineCanvas dopesheet; it retimes to the
// dropped sub-frame second PRESERVING value AND easing, committed as ONE
// undo entry through the P7 seam; the evaluated transform reflects the
// NEW timing; and the P7 inspector diamond still reads on-key after a
// sub-frame drop (D-05).
//
// H35/H28 discipline: the load-bearing assertion is the EVALUATED rendered
// rotation (`__basher_evaluated_transform`, the V57 direct-channel resolver)
// returning a value that is ONLY correct if the keyframe MOVED — an OBSERVED
// evaluated delta, NEVER a dopesheet row / data-*-count / screenshot
// (TimelineCanvas is never screenshot-asserted — D-W9-8).
//
// REF: .planning/phases/07.1-keyframe-retime/PLAN.md Wave 3 Task 6;
//      CONTEXT D-01..D-07; boot.ts:508 (__basher_evaluated_transform seam).

import { expect, test } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      dispatch: (op: unknown) => void;
      dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void;
      undo: () => unknown;
      undoStack: unknown[];
    };
  };
  __basher_time?: {
    getState: () => { setTime: (s: number) => void; seconds: number; durationSeconds: number };
  };
  // V57 direct channels (#199): the animation overlay lives in the
  // renderer/resolver, not the node's evaluate() value. Read the rendered
  // rotation through the SAME resolveEvaluatedTransform the renderer consumes.
  __basher_evaluated_transform?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { rotation?: [number, number, number] | null } | null;
}

// Geometry mirrors TimelineCanvas.tsx (reze-fidelity dopesheet, UX #11):
// 84px label gutter, 10px diamond, a 17px frame ruler above the rows.
const LABEL_GUTTER = 84;
const DIAMOND = 10;
const INSET = 4;
const RULER_H = 17;

/** Center-x (canvas CSS px) of a keyframe at time t — the SAME math
 *  keyframeToRect uses, so the test is geometry-derived, not a magic
 *  pixel. */
function diamondCx(t: number, durationSeconds: number, canvasW: number): number {
  const trackWidth = Math.max(canvasW - LABEL_GUTTER, 0);
  const span = Math.max(durationSeconds, 0.0001);
  const inset = Math.max(INSET, DIAMOND / 2);
  const innerW = trackWidth - 2 * inset;
  const tt = Math.min(Math.max(t, 0), span);
  return innerW > 0
    ? LABEL_GUTTER + inset + (tt / span) * innerW
    : LABEL_GUTTER + (tt / span) * trackWidth;
}

test('P7.1 — drag retimes a keyframe: evaluated delta reflects new timing, value+easing preserved, ONE undo, D-05 on-key', async ({
  page,
}) => {
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
    return Boolean(w.__basher_dag && w.__basher_time && w.__basher_evaluated_transform);
  });

  // Seed (V57 direct channels): BoxMesh + ONE free-floating
  // KeyframeChannelVec3 on `rotation` with TWO linear samples — value at a
  // probe time DEPENDS on where the t=2 key sits. The channel targets the
  // box DIRECTLY (target = box dagId); NO AnimationLayer wraps it, the box
  // stays its own scene child. `overlayChannels` overlays the sampled value.
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag!.getState();
    if (!Object.values(dag.state.nodes).some((n) => n.type === 'TimeSource')) {
      dag.dispatch({ type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} });
    }
    const sceneId = Object.entries(dag.state.nodes).find(([, n]) => n.type === 'Scene')?.[0];
    if (!sceneId) throw new Error('p7.1-seed: no Scene node');
    const ops: unknown[] = [
      {
        type: 'addNode',
        nodeId: 'sun',
        nodeType: 'BoxMesh',
        params: {
          size: [1, 1, 1],
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          material: { name: 'default', color: '#ff0000' },
        },
      },
      // V57: the box IS its own scene child (no AnimationLayer wrapper to slot
      // between it and the scene) — wire it directly into scene.children.
      {
        type: 'connect',
        from: { node: 'sun', socket: 'out' },
        to: { node: sceneId, socket: 'children' },
      },
      {
        type: 'addNode',
        nodeId: 'ch',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'rotation',
          target: 'sun',
          paramPath: 'rotation',
          keyframes: [
            { time: 0, value: [0, 0, 0], easing: 'linear' },
            { time: 2, value: [0, 10, 0], easing: 'linear' },
          ],
        },
      },
    ];
    dag.dispatchAtomic(ops, 'user', 'p7.1-seed');
  });

  await page.getByTestId('floating-toolbar-timeline').click();
  const host = page.getByTestId('timeline-canvas');
  await expect(host).toBeVisible();
  const canvas = host.locator('canvas');
  await expect(canvas).toBeVisible();

  const durationSeconds = await page.evaluate(
    () => (window as unknown as BasherWindow).__basher_time!.getState().durationSeconds,
  );

  // PRE-RETIME evaluated value at probe t=1.5: keys 0@t0, 10@t2, linear
  // → lerp = 1.5/2 * 10 = 7.5.
  const evalAt = (s: number) =>
    page.evaluate(
      ({ sec }) => {
        const w = window as unknown as BasherWindow;
        // V57 direct channels (#199): the box is its own scene child; the
        // channel's sampled rotation is overlaid by the renderer/resolver, NOT
        // the node's raw evaluate() value. Read the rendered rotation.y through
        // the SAME resolveEvaluatedTransform the renderer consumes.
        const t = w.__basher_evaluated_transform!('sun', {
          time: { frame: Math.round(sec * 60), seconds: sec, normalized: 0 },
        });
        return { intensity: t?.rotation?.[1] };
      },
      { sec: s },
    );

  const preProbe = await evalAt(1.5);
  // eslint-disable-next-line no-console
  console.log('[P7.1] pre-retime eval@1.5 =', JSON.stringify(preProbe));
  expect(preProbe.intensity).toBeCloseTo(7.5, 3);

  // DRAG the t=2 diamond left to a sub-frame second (~1.3333, off the
  // 60fps grid: 1.3333*60 = 79.998). Geometry-derived pixels.
  const box = (await canvas.boundingBox())!;
  const startX = box.x + diamondCx(2, durationSeconds, box.width);
  const startY = box.y + RULER_H + 12; // row 0 center (ruler 17 + rowTop 0 + 24/2)
  const targetSeconds = 1.3333;
  const targetX = box.x + diamondCx(targetSeconds, durationSeconds, box.width);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(startX + (targetX - startX) * (i / 8), startY);
    await page.waitForTimeout(25);
  }
  await page.mouse.up();
  await page.waitForTimeout(120);

  // (1) DAG observation: no sample at t≈2.0, a sample at t≈1.3333
  //     (±1px-worth-of-seconds), value 10, easing 'linear'.
  const onePxSec = (durationSeconds / Math.max(box.width - LABEL_GUTTER, 1)) * 2;
  const kfs = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const ch = w.__basher_dag!.getState().state.nodes['ch'];
    return (ch.params.keyframes ?? []) as {
      time: number;
      value: unknown;
      easing: string;
    }[];
  });
  // eslint-disable-next-line no-console
  console.log('[P7.1] post-retime keyframes =', JSON.stringify(kfs));
  const moved = kfs.find((k) => k.time !== 0);
  expect(moved).toBeDefined();
  expect(kfs.some((k) => Math.abs(k.time - 2.0) < 1e-6)).toBe(false);
  expect(Math.abs(moved!.time - targetSeconds)).toBeLessThan(onePxSec);
  expect(moved!.value).toEqual([0, 10, 0]); // D-01 value preserved
  expect(moved!.easing).toBe('linear'); // D-01 easing preserved

  // (2) GOAL-BACKWARD: evaluated value at t=1.5 now DIFFERS — the moved
  //     key ends the 0→10 ramp BEFORE 1.5, so the value is clamped to
  //     10 (it was 7.5 pre-retime). This is only correct if the
  //     evaluator sees the NEW timing — the observed delta proof.
  const postProbe = await evalAt(1.5);
  // eslint-disable-next-line no-console
  console.log('[P7.1] post-retime eval@1.5 =', JSON.stringify(postProbe));
  expect(postProbe.intensity).toBeCloseTo(10, 3);
  expect(postProbe.intensity).not.toBeCloseTo(7.5, 1);

  // (3) ONE atomic undo restores the sample to t≈2.0.
  const undoLenBefore = await page.evaluate(
    () => (window as unknown as BasherWindow).__basher_dag!.getState().undoStack.length,
  );
  await page.evaluate(() => (window as unknown as BasherWindow).__basher_dag!.getState().undo());
  const restored = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const ch = w.__basher_dag!.getState().state.nodes['ch'];
    return (ch.params.keyframes ?? []) as { time: number; value: unknown }[];
  });
  // eslint-disable-next-line no-console
  console.log('[P7.1] undoStackLen=' + undoLenBefore + ' restored =', JSON.stringify(restored));
  expect(restored.some((k) => Math.abs(k.time - 2.0) < 1e-6)).toBe(true);
  expect(restored.some((k) => k.time === 0)).toBe(true);
  // Re-apply (redo via re-running the eval expectation) — re-do the drag
  // is not needed; the single-entry restore IS the atomicity proof.

  // (4) D-05: re-apply the retime (drag again), then read
  //     paramAnimationState against the LIVE DAG at the nearest integer
  //     frame of the sub-frame key → 'on-key' (the sub-frame key still
  //     lights end-to-end).
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(startX + (targetX - startX) * (i / 8), startY);
    await page.waitForTimeout(25);
  }
  await page.mouse.up();
  await page.waitForTimeout(120);

  const d05 = await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const ch = w.__basher_dag!.getState().state.nodes['ch'];
    const kf = (ch.params.keyframes as { time: number }[]).find((k) => k.time !== 0)!;
    const nearestFrame = Math.round(kf.time * 60);
    const { paramAnimationState } = await import('/src/app/animate/paramAnimationState.ts');
    const state = w.__basher_dag!.getState().state;
    return {
      kfTime: kf.time,
      nearestFrame,
      onKey: paramAnimationState(state, 'sun', 'rotation', nearestFrame),
      twoAway: paramAnimationState(state, 'sun', 'rotation', nearestFrame + 2),
    };
  });
  // eslint-disable-next-line no-console
  console.log('[P7.1] D-05 =', JSON.stringify(d05));
  expect(d05.onKey).toBe('on-key'); // sub-frame key still lights (D-05)
  expect(d05.twoAway).toBe('animated');
});
