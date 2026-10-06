// #1314 — the "Camera Path + AI Walk" example ran at ~3 fps, idle or playing: the camera's frustum
// follower re-resolved the camera's pose every frame with NO evaluator cache, and that pose (a
// Track-To on the walker's Hips, a Follow-Path) reads the character's pose — a `RetargetClip` that
// retargets the whole 10 s walk (~300 ms). With a cache it runs once per graph change.
//
// What is counted is the retarget itself (`__retargetRunsForTests`), over frames that change
// nothing in the graph: idle, playing, and playing with each kind of object selected (the gizmo
// re-resolves the selection per frame too), over 10 frames each. Any count above zero is a caller evaluating uncached.
// The walk is also checked to still move, so a zero cannot come from a scene that stopped drawing.

import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';

interface Win {
  __basher_time?: {
    getState: () => { setTime: (s: number) => void; play: () => void; pause: () => void };
  };
  __basher_selection?: { getState: () => { select: (id: string) => void; clear?: () => void } };
  __basher_armature?: { bones: number; matrices: number[][] };
  __basher_viewport?: {
    getState: () => { setViewLock: (lock: { nodeId: string; boneName: null } | null) => void };
  };
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string }> };
      dispatchAtomic: (ops: unknown[]) => unknown;
    };
  };
}

/** A driver on `target.paramPath` reading the camera's yaw. The camera aims at the walker's
 *  Hips, so evaluating the driver evaluates the walk's retarget. */
function cameraYawDriver(id: string, target: string, paramPath: string) {
  return {
    type: 'addNode',
    nodeId: id,
    nodeType: 'ParamDriver',
    params: {
      target,
      paramPath,
      blendMode: 'replace',
      order: 0,
      sourceTransform: { node: 'n_camera', channel: 'ry' },
    },
  };
}

/** Retarget runs over `frames` animation frames, after the given setup has settled. */
async function runsOver(page: Page, frames: number, playing: boolean): Promise<number> {
  return page.evaluate(
    async ({ frames, playing }) => {
      const m = await import('/src/nodes/RetargetClip.ts');
      const w = window as unknown as Win;
      const time = w.__basher_time!.getState();
      if (playing) time.play();
      // Let the change (a selection, play) settle. Selecting mounts panels; since #1315 they share
      // the viewport's cache and pay nothing (p1315 counts that), but a change may still settle over
      // a few frames, so wait until no retarget has run for 10 frames — at most 120. A per-frame caller never settles,
      // and its runs then land in the window below.
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      let quiet = 0;
      for (let i = 0; i < 120 && quiet < 10; i++) {
        const n = m.__retargetRunsForTests();
        await frame();
        quiet = m.__retargetRunsForTests() === n ? quiet + 1 : 0;
      }
      const before = m.__retargetRunsForTests();
      for (let i = 0; i < frames; i++) await frame();
      const after = m.__retargetRunsForTests();
      if (playing) time.pause();
      return after - before;
    },
    { frames, playing },
  );
}

test('the example evaluates its retarget once, not every frame', async ({ page }) => {
  test.setTimeout(300_000);
  await page.route(/:8600\//, (route) => route.abort());
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('basher.lastProjectId');
    } catch {
      /* storage disabled */
    }
  });
  await page.goto('/');
  await page.getByTestId('home-open-example_camera_path_ai_walk').click();
  await page.waitForFunction(
    () => ((window as unknown as Win).__basher_armature?.bones ?? 0) > 10,
    null,
    { timeout: 60_000 },
  );

  // The positive control first: the counter counts. Load ran the retarget at least once.
  const loaded = await page.evaluate(async () =>
    (await import('/src/nodes/RetargetClip.ts')).__retargetRunsForTests(),
  );
  expect(loaded, 'the counter saw the load retarget').toBeGreaterThan(0);

  const select = (id: string) =>
    page.evaluate((id) => (window as unknown as Win).__basher_selection!.getState().select(id), id);

  const rows: [string, number][] = [];
  const row = async (name: string, playing: boolean) => {
    rows.push([name, await runsOver(page, 10, playing)]);
    console.log(`[1314] ${name}: ${rows[rows.length - 1][1]} retarget runs over 10 frames`);
  };
  await row('idle', false);
  await row('playing', true);
  for (const id of [
    'n_camera',
    'n_nativeGrp_e6d386f1',
    'n_nativeSkeleton_35c8723b_object',
    'n_nativeObject_843e4bd5',
    'obj_mujimesy_zbsm',
  ]) {
    await select(id);
    await row(`playing, ${id} selected`, true);
  }

  // #1387 — the inspector's Slots section (collapsed by default) resolves the selection's slot
  // table in its render body, which follows the playhead. Open, it must not re-run the walk.
  for (const id of ['n_nativeObject_843e4bd5', 'n_nativeSkeleton_35c8723b_object']) {
    await select(id);
    const section = page.getByTestId('inspector-section-slots');
    await expect(section).toBeVisible();
    if ((await section.getAttribute('data-collapsed')) !== null)
      await page.getByTestId('inspector-section-toggle-slots').click();
    await expect(
      page.locator(
        `[data-testid="inspector-object-slots-${id}"],[data-testid="inspector-slots-none-${id}"]`,
      ),
    ).toBeVisible();
    await row(`playing, ${id} selected, Slots open`, true);
  }

  // #1388 — a view lock rescans the scene every 15th frame, playing or not. Locked to the
  // camera, the scan still walks the character.
  for (const id of ['n_camera', 'n_nativeObject_843e4bd5']) {
    await select(id);
    await page.evaluate(
      (id) =>
        (window as unknown as Win).__basher_viewport!.getState().setViewLock({
          nodeId: id,
          boneName: null,
        }),
      id,
    );
    // 30 frames, so at least one rescan (every 15th) lands in the window.
    rows.push([`paused, view lock on ${id}`, await runsOver(page, 30, false)]);
    console.log(
      `[1314] paused, view lock on ${id}: ${rows[rows.length - 1][1]} retarget runs over 30 frames`,
    );
    await page.evaluate(() =>
      (window as unknown as Win).__basher_viewport!.getState().setViewLock(null),
    );
  }
  const dispatch = (ops: unknown[]) =>
    page.evaluate(
      (ops) => (window as unknown as Win).__basher_dag!.getState().dispatchAtomic(ops),
      ops,
    );

  // #1389 — an animatable field follows the playhead. Driven through the camera, each read
  // evaluates the walk: 40 retargets per 10 frames with the Scene's environment fields
  // mounted, before each field held a cache.
  await dispatch([cameraYawDriver('drv_1389_env', 'n_scene', 'envIntensity')]);
  await select('n_scene');
  await expect(page.getByTestId('inspector-environment-n_scene')).toBeVisible();
  await row('playing, Scene selected, env intensity driven by the camera', true);
  await dispatch([{ type: 'removeNode', nodeId: 'drv_1389_env' }]);

  // #1389 — the composite viewer re-reads its layers per frame. A layer's opacity driven
  // through the camera evaluates the walk on every read.
  await page.getByTestId('menu-file-button').click();
  await page.getByTestId('menu-file-new-composition').click();
  await expect(page.getByTestId('video-mode-viewer')).toBeVisible();
  const compId = await page.evaluate(() => {
    const nodes = (window as unknown as Win).__basher_dag!.getState().state.nodes;
    return Object.keys(nodes).find((id) => nodes[id].type === 'Composition')!;
  });
  await dispatch([
    { type: 'addNode', nodeId: 'layer_1389', nodeType: 'Layer', params: {} },
    {
      type: 'connect',
      from: { node: 'layer_1389', socket: 'out' },
      to: { node: compId, socket: 'layers' },
    },
    cameraYawDriver('drv_1389_layer', 'layer_1389', 'opacity'),
  ]);
  await row('playing, composite viewer, layer opacity driven by the camera', true);

  // #1389 — the composition export walks the same layer reads once per frame. Over a 6-frame
  // comp the walk may run once (its cache starts empty), not once per frame.
  await dispatch([{ type: 'setParam', nodeId: compId, paramPath: 'durationFrames', value: 6 }]);
  const exported = await page.evaluate(async () => {
    const rc = await import('/src/nodes/RetargetClip.ts');
    const ex = await import('/src/app/video/exportCompositionAction.ts');
    const before = rc.__retargetRunsForTests();
    const result = await ex.exportCompositionToFile('png');
    return { ok: result.ok, frames: result.frameCount, runs: rc.__retargetRunsForTests() - before };
  });
  expect(exported, 'the export ran 6 frames').toMatchObject({ ok: true, frames: 6 });
  console.log(`[1314] composition export, 6 frames: ${exported.runs} retarget runs`);
  rows.push(['composition export, 6 frames (1 allowed)', Math.max(0, exported.runs - 1)]);
  await page.getByTestId('space-switch-view3d').click();

  expect(rows.filter(([, n]) => n > 0)).toEqual([]);

  // The walk still moves: the Hips' drawn matrix differs between two times.
  const hipsAt = (t: number) =>
    page.evaluate(async (sec) => {
      const w = window as unknown as Win;
      w.__basher_time!.getState().setTime(sec);
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
      return w.__basher_armature!.matrices[1].slice(12, 15);
    }, t);
  const a = await hipsAt(0);
  const b = await hipsAt(3);
  expect(Math.hypot(...a.map((v, i) => v - b[i])), 'the walk moves').toBeGreaterThan(0.2);
});
