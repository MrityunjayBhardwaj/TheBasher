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
}

/** Retarget runs over `frames` animation frames, after the given setup has settled. */
async function runsOver(page: Page, frames: number, playing: boolean): Promise<number> {
  return page.evaluate(
    async ({ frames, playing }) => {
      const m = await import('/src/nodes/RetargetClip.ts');
      const w = window as unknown as Win;
      const time = w.__basher_time!.getState();
      if (playing) time.play();
      // Let the change (a selection, play) settle. Selecting mounts panels, and each mounted
      // reader pays ONE retarget through its fresh cache (#1315's cost, not this one's), so wait
      // until no retarget has run for 10 frames — at most 120. A per-frame caller never settles,
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
