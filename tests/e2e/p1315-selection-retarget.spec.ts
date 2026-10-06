// #1315 — selecting the "Camera Path + AI Walk" example's armature stalled ~0.8 s: every panel and
// gizmo that mounted on the selection re-ran the walk's whole-clip retarget through its OWN
// evaluator cache (12–26 retargets per selection), although the viewport had computed that exact
// result a frame earlier. The long-lived UI readers now share one bounded cache, so a selection
// finds the result already there.
//
// What is counted is the retarget itself (`__retargetRunsForTests`), from the selection until no
// retarget has run for 15 frames, and it must be ZERO: the viewport already holds the result in
// the shared cache. The issue's bar was "at most once", but that bar cannot see half the fix:
// with the readers back on their own caches and only the predicates sharing, each selection
// still cost exactly 1. Each object is selected twice, from an empty selection.

import { expect, test } from './_fixtures';

interface Win {
  __basher_selection?: { getState: () => { select: (id: string) => void; clear: () => void } };
  __basher_armature?: { bones: number };
}

test('selecting an object re-uses the walk the viewport already evaluated', async ({ page }) => {
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
  const loaded = await page.evaluate(async () =>
    (await import('/src/nodes/RetargetClip.ts')).__retargetRunsForTests(),
  );
  expect(loaded, 'the counter saw the load retarget').toBeGreaterThan(0);

  const rows: [string, number][] = [];
  for (const rep of [1, 2]) {
    for (const id of [
      'n_nativeSkeleton_35c8723b_object',
      'n_nativeObject_843e4bd5',
      'n_camera',
      'n_nativeGrp_e6d386f1',
      'obj_mujimesy_zbsm',
    ]) {
      const runs = await page.evaluate(async (id) => {
        const rc = await import('/src/nodes/RetargetClip.ts');
        const sel = (window as unknown as Win).__basher_selection!.getState();
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        sel.clear();
        for (let i = 0; i < 10; i++) await frame();
        const before = rc.__retargetRunsForTests();
        sel.select(id);
        let quiet = 0;
        for (let i = 0; i < 180 && quiet < 15; i++) {
          const n = rc.__retargetRunsForTests();
          await frame();
          quiet = rc.__retargetRunsForTests() === n ? quiet + 1 : 0;
        }
        return rc.__retargetRunsForTests() - before;
      }, id);
      console.log(`[1315] select ${id} (pass ${rep}): ${runs} retarget runs`);
      rows.push([`${id} pass ${rep}`, runs]);
    }
  }
  expect(rows.filter(([, n]) => n > 0)).toEqual([]);
});
