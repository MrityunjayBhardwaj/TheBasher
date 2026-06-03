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
  __basher_evaluate?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => {
    value: { sampleTarget?: (s: number) => { size?: [number, number, number] } | null };
  };
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

/** The single AnimationLayer node id (the gizmo first-key composite wraps the
 *  target in one). The size channel only "works" if it evaluates THROUGH this
 *  layer — reading the channel's keyframes proves authoring, not playback. */
async function layerNodeId(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag!.getState().state.nodes;
    const entry = Object.entries(nodes).find(([, n]) => n.type === 'AnimationLayer');
    if (!entry) throw new Error('no AnimationLayer node — gizmo first-key did not wrap the target');
    return entry[0];
  });
}

/** Evaluated (rendered) box size at time `s`, read through the AnimationLayer's
 *  `sampleTarget(seconds)` patched clone — the SAME value the renderer draws
 *  (`<boxGeometry args={value.size}/>`). This is the observation, not the
 *  authored channel. */
async function evaluatedBoxSize(
  page: import('@playwright/test').Page,
  layerId: string,
  s: number,
): Promise<number[] | undefined> {
  return page.evaluate(
    ({ id, sec }) => {
      const w = window as unknown as BasherWindow;
      const v = w.__basher_evaluate!(id, {
        time: { frame: Math.round(sec * 60), seconds: sec, normalized: 0 },
      }).value;
      return v.sampleTarget?.(sec)?.size;
    },
    { id: layerId, sec: s },
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
  await page.getByTestId('mode-switcher').selectOption('animate');
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

  // #141 follow-up — the scale branch (Gizmo.tsx:373) was wired symmetrically
  // with translate/rotate but never OBSERVED end-to-end. For a BoxMesh the
  // scale gizmo keys `params.size` (scaleParamPath==='size', NOT 'scale').
  // Recording a keyframe is only half the contract: the question this test
  // answers is whether a `size` KeyframeChannel actually EVALUATES through the
  // AnimationLayer — i.e. drives the rendered box, not just sits in the DAG.
  // The AnimationLayer patch (`patchTarget`/`writeAt`) is paramPath-agnostic,
  // so a `size` channel patches `clone.size` exactly as `position` patches
  // `clone.position`; this converts that code-trace into a real observation.
  test('arm Auto-Key, drag the scale gizmo at two times → records a size channel that EVALUATES through the AnimationLayer', async ({
    page,
  }) => {
    await selectBoxAndArmGizmo(page);

    await page.getByTestId('autokey-toggle').click();
    await expect(page.getByTestId('timebar')).toHaveAttribute('data-autokey', 'on');

    expect(await channelNodes(page)).toHaveLength(0);

    // t=0 → scale to 2×, t=1 → scale to 4×. The gizmo writes g.scale into the
    // box's `size` param (the BoxMesh "scale" is its geometry size, pre-unified
    // TRS — v0.6 #1).
    await setTime(page, 0);
    await gizmoGrabScale(page, [2, 2, 2]);
    await setTime(page, 1);
    await gizmoGrabScale(page, [4, 4, 4]);

    // Authoring half: exactly one `size` channel on n_box with two keyframes.
    const chs = await channelNodes(page);
    expect(chs, 'gizmo scale drag with Auto-Key ON should create a size channel').toHaveLength(1);
    expect(chs[0].target).toBe('n_box');
    expect(chs[0].paramPath).toBe('size');
    expect(chs[0].keyframes).toHaveLength(2);
    const byTime = [...chs[0].keyframes].sort((a, b) => a.time - b.time);
    expect((byTime[0].value as number[])[0]).toBeCloseTo(2, 5);
    expect((byTime[1].value as number[])[0]).toBeCloseTo(4, 5);

    // Evaluation half (the actual follow-up): the size channel must drive the
    // RENDERED box. Read the evaluated size THROUGH the AnimationLayer at the
    // two key times and at the midpoint — linear interpolation @0.5 ⇒ 3×.
    const layerId = await layerNodeId(page);
    const at0 = await evaluatedBoxSize(page, layerId, 0);
    const atMid = await evaluatedBoxSize(page, layerId, 0.5);
    const at1 = await evaluatedBoxSize(page, layerId, 1);
    expect(at0, 'size channel must evaluate through the layer @t=0').toBeDefined();
    expect(at0![0]).toBeCloseTo(2, 4);
    expect(atMid![0]).toBeCloseTo(3, 4);
    expect(at1![0]).toBeCloseTo(4, 4);
  });
});
