// REPRODUCTION — "animate the box by dragging the position gizmo with record
// (Auto-Key) on" does not work end-to-end.
//
// User report (2026-06-03): with Auto-Key armed, dragging the position gizmo
// moves the proxy but it "snaps right back" and no animation is recorded.
//
// Root cause under test: the gizmo grab path is NOT symmetric with the NPanel
// inspector commit path. The inspector commits a raw setParam AND THEN calls
// `autoKeyCommit` (which runs `dispatchFirstKeyComposite` for an un-animated
// param — the "Animate this" first key). The gizmo's `onObjectChange` only
// calls `routeAnimatedGrab` (which returns false and does NOTHING for an
// un-animated param) and then a raw setParam — it never calls `autoKeyCommit`.
// So a gizmo drag with Auto-Key ON on a fresh box records ZERO keyframes; and
// once a param IS animated, a drag with Auto-Key OFF hits the zero-ops reject
// (`autoKeyCommit.ts:78-83`) and the re-seeded proxy snaps back.
//
// These tests drive the REAL gizmo code path via the DEV `__basher_gizmo_grab`
// seam (which invokes the real `onObjectChange` — Gizmo.tsx:378, the same
// stance p7.3 takes because TransformControls pointer-drag is fragile in
// headless Chromium). They are EXPECTED TO FAIL until the gizmo gains the
// first-key path; that green is the fix's regression gate.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
    };
  };
  __basher_time?: { getState: () => { setTime: (s: number) => void; seconds: number } };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_gizmo_grab?: (
    mode: 'translate' | 'rotate' | 'scale',
    target: [number, number, number],
  ) => void;
  // #199 — a keyframed native mesh is driven by a free-floating direct channel
  // (no AnimationLayer), so the rendered transform is read through the SAME
  // resolveEvaluatedTransform seam (which overlays the direct channel, #197).
  __basher_evaluated_transform?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { scale?: [number, number, number]; position?: [number, number, number] } | null;
}

/** All KeyframeChannel* nodes in the DAG — the byte-identical motion observable
 *  (we assert on recorded keyframes, never on a dopesheet row or a count). */
async function channelNodes(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag!.getState().state.nodes;
    return Object.entries(nodes)
      .filter(([, n]) => n.type.startsWith('KeyframeChannel'))
      .map(([id, n]) => ({
        id,
        type: n.type,
        target: n.params.target,
        paramPath: n.params.paramPath,
        keyframes: (n.params.keyframes ?? []) as { time: number; value: unknown }[],
      }));
  });
}

async function boxPosition(page: import('@playwright/test').Page): Promise<number[]> {
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return w.__basher_dag!.getState().state.nodes['n_box'].params.position as number[];
  });
}

async function setTime(page: import('@playwright/test').Page, s: number) {
  await page.evaluate(
    ({ sec }) => (window as unknown as BasherWindow).__basher_time!.getState().setTime(sec),
    { sec: s },
  );
}

/** Select n_box (mode-independent store driver) and wait for the gizmo to mount
 *  so its DEV `__basher_gizmo_grab` seam is installed. */
async function selectBoxAndArmGizmo(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => Boolean((window as unknown as BasherWindow).__basher_selection));
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_selection!.getState().select('n_box');
  });
  await page.waitForFunction(() =>
    Boolean((window as unknown as BasherWindow).__basher_gizmo_grab),
  );
}

async function gizmoGrabTranslate(
  page: import('@playwright/test').Page,
  target: [number, number, number],
) {
  await page.evaluate(
    ({ t }) => (window as unknown as BasherWindow).__basher_gizmo_grab!('translate', t),
    { t: target },
  );
}

async function gizmoGrabScale(
  page: import('@playwright/test').Page,
  target: [number, number, number],
) {
  await page.evaluate(
    ({ t }) => (window as unknown as BasherWindow).__basher_gizmo_grab!('scale', t),
    { t: target },
  );
}

/** Evaluated (rendered) box SCALE at time `s`, read through the SAME
 *  `resolveEvaluatedTransform` the renderer's DirectChannelsR consumes (#197) —
 *  the read-side overlay of the free-floating scale channel onto n_box. This is
 *  the observation (where it renders), not the authored channel. */
async function evaluatedScale(
  page: import('@playwright/test').Page,
  s: number,
): Promise<number[] | undefined> {
  return page.evaluate(
    ({ sec }) => {
      const w = window as unknown as BasherWindow;
      const t = w.__basher_evaluated_transform!('n_box', {
        time: { frame: Math.round(sec * 60), seconds: sec, normalized: 0 },
      });
      return t?.scale;
    },
    { sec: s },
  );
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
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_time);
  });
  await page.getByTestId('floating-toolbar-timeline').click();
});

test.describe('Gizmo + Auto-Key — drag-to-record an animation (REPRO: not working)', () => {
  test('arm Auto-Key, drag the position gizmo at two times → records a position channel with two keyframes', async ({
    page,
  }) => {
    await selectBoxAndArmGizmo(page);

    // Arm record.
    await page.getByTestId('autokey-toggle').click();
    await expect(page.getByTestId('timebar')).toHaveAttribute('data-autokey', 'on');

    // No animation yet.
    expect(await channelNodes(page)).toHaveLength(0);

    // t=0 → drag the box to x=1, then t=1 → drag to x=2. Exactly the flow a
    // director performs to author a slide.
    await setTime(page, 0);
    await gizmoGrabTranslate(page, [1, 0, 0]);
    await setTime(page, 1);
    await gizmoGrabTranslate(page, [2, 0, 0]);

    // EXPECTATION (the fix's contract): one position channel, two keyframes,
    // one at each playhead time with the dragged value. This FAILS today —
    // the gizmo never enters the Auto-Key seam, so zero channels exist.
    const chs = await channelNodes(page);
    expect(chs, 'gizmo drag with Auto-Key ON should create a keyframe channel').toHaveLength(1);
    expect(chs[0].target).toBe('n_box');
    expect(chs[0].paramPath).toBe('position');
    expect(chs[0].keyframes).toHaveLength(2);

    const byTime = [...chs[0].keyframes].sort((a, b) => a.time - b.time);
    expect(byTime[0].time).toBeCloseTo(0, 5);
    expect((byTime[0].value as number[])[0]).toBeCloseTo(1, 5);
    expect(byTime[1].time).toBeCloseTo(1, 5);
    expect((byTime[1].value as number[])[0]).toBeCloseTo(2, 5);
  });

  test('snap-back characterization: the dragged value must be committed, not reverted', async ({
    page,
  }) => {
    await selectBoxAndArmGizmo(page);
    await page.getByTestId('autokey-toggle').click();
    await expect(page.getByTestId('timebar')).toHaveAttribute('data-autokey', 'on');

    await setTime(page, 0);
    await gizmoGrabTranslate(page, [1, 2, 3]);

    // After the grab the box's authored/evaluated position must reflect the
    // drag. If it reads back [0,0,0] the commit was rejected/reverted — the
    // visible "snaps right back". (Today: raw setParam lands [1,2,3] but no
    // keyframe is recorded — so this assertion documents which half fails.)
    const pos = await boxPosition(page);
    expect(pos[0]).toBeCloseTo(1, 5);
    expect(pos[1]).toBeCloseTo(2, 5);
    expect(pos[2]).toBeCloseTo(3, 5);
  });

  // #141 follow-up, MIGRATED for v0.6 #1 (#150). DELIBERATE CONTRACT CHANGE, not
  // a regression: pre-v0.6 the BoxMesh scale gizmo keyed `params.size` (the
  // geometry WAS the scale). v0.6 #1 unified the mesh model — every primitive now
  // carries a real `transform.scale` band SEPARATE from `size`, and
  // `getManipulable` resolves `scaleParamPath` to 'scale' (NOT 'size') because
  // `p.scale` is now a vec3 (C-5: the param add flips the path automatically; THIS
  // assertion is the observation that proves the flip). Recording a keyframe is
  // half the contract; the other half is that the `scale` channel EVALUATES
  // through the AnimationLayer to drive the rendered box (patchTarget is
  // paramPath-agnostic → patches `clone.scale`). See PLAN.md Wave 4 (H25/H46
  // fixture-migration family).
  test('arm Auto-Key, drag the scale gizmo at two times → records a transform.scale channel that EVALUATES through the AnimationLayer', async ({
    page,
  }) => {
    await selectBoxAndArmGizmo(page);

    await page.getByTestId('autokey-toggle').click();
    await expect(page.getByTestId('timebar')).toHaveAttribute('data-autokey', 'on');

    expect(await channelNodes(page)).toHaveLength(0);

    // t=0 → scale to 2×, t=1 → scale to 4×. v0.6 #1: the gizmo writes g.scale into
    // the box's `scale` transform band, NOT its geometry `size`.
    await setTime(page, 0);
    await gizmoGrabScale(page, [2, 2, 2]);
    await setTime(page, 1);
    await gizmoGrabScale(page, [4, 4, 4]);

    // Authoring half: exactly one `scale` channel on n_box with two keyframes.
    const chs = await channelNodes(page);
    expect(chs, 'gizmo scale drag with Auto-Key ON should create a scale channel').toHaveLength(1);
    expect(chs[0].target).toBe('n_box');
    expect(chs[0].paramPath).toBe('scale'); // v0.6 #1 — was 'size'
    expect(chs[0].keyframes).toHaveLength(2);
    const byTime = [...chs[0].keyframes].sort((a, b) => a.time - b.time);
    expect((byTime[0].value as number[])[0]).toBeCloseTo(2, 5);
    expect((byTime[1].value as number[])[0]).toBeCloseTo(4, 5);

    // Evaluation half: the scale channel must drive the RENDERED box. Read the
    // evaluated transform.scale THROUGH resolveEvaluatedTransform (the direct
    // channel's read-side overlay, #197) at the two key times and the midpoint —
    // linear interpolation @0.5 ⇒ 3×.
    const at0 = await evaluatedScale(page, 0);
    const atMid = await evaluatedScale(page, 0.5);
    const at1 = await evaluatedScale(page, 1);
    expect(
      at0,
      'scale channel must evaluate through the direct-channel resolver @t=0',
    ).toBeDefined();
    expect(at0![0]).toBeCloseTo(2, 4);
    expect(atMid![0]).toBeCloseTo(3, 4);
    expect(at1![0]).toBeCloseTo(4, 4);

    // The geometry `size` param is UNCHANGED — the gizmo touched the transform
    // band, not the geometry capability (the v0.6 #1 size-vs-scale distinction).
    const size = await page.evaluate(
      () =>
        (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes['n_box'].params
          .size,
    );
    expect(size).toEqual([1, 1, 1]);
  });
});
