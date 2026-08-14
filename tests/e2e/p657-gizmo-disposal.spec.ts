// #657 — selecting and deselecting does not leak the transform gizmo's GPU resources.
//
// drei's `TransformControls` cleans up with `controls.detach()` and never calls `dispose()`,
// so every mount/unmount cycle stranded the gizmo's geometries and materials on the GPU.
// Measured before the fix, selecting and deselecting one object and touching nothing else:
//
//   gl:  7 → 24 → 41 → 58 → 75 → 92        (+17 per cycle, exactly linear, unbounded)
//
// `renderer.info.memory.geometries` falls only on a real `dispose()`, which is why it is the
// instrument here and why it is trustworthy for THIS question — the scene is otherwise
// untouched for the whole test, so the counter has nothing else to respond to. (It is a poor
// instrument for attributing cost to an authoring action, which is a different question and
// the subject of #656.)
//
// ⚠️ THE GIZMO'S PRESENCE IS ASSERTED INSIDE THE LOOP, and that is not decoration. If
// selection silently stopped mounting a gizmo, nothing would be built, nothing would leak,
// and a bare "the number stayed flat" would pass while the feature was dead. The cycle has
// to be shown to CONSTRUCT the thing whose disposal is under test.
//
// REF: src/app/TransformGizmo.tsx (the owner that adds the disposal);
//      src/app/transformGizmoOwnership.gate.test.ts (the census keeping it the only door);
//      node_modules/three/examples/jsm/controls/TransformControls.js:535 (`dispose`);
//      issue #657.

import { expect, test } from './_fixtures';

interface Obj {
  name?: string;
  type?: string;
  children?: Obj[];
}

interface W {
  __basher_three: {
    getState: () => {
      scene: unknown;
      gl: { info: { memory: { geometries: number } } } | null;
    };
  };
  __basher_selection: {
    getState: () => { select: (id: string | null) => void };
  };
}

const CYCLES = 5;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_three && w.__basher_selection && w.__basher_three.getState().scene);
  });
});

test('selecting and deselecting repeatedly leaves no gizmo geometry behind', async ({ page }) => {
  const probe = () =>
    page.evaluate(() => {
      const w = window as unknown as W;
      const scene = w.__basher_three.getState().scene as Obj | null;
      let gizmos = 0;
      const walk = (o: Obj): void => {
        if (/TransformControlsGizmo/.test(`${o.type ?? ''} ${o.name ?? ''}`)) gizmos++;
        (o.children ?? []).forEach(walk);
      };
      if (scene) walk(scene);
      return { gizmos, gl: w.__basher_three.getState().gl?.info.memory.geometries ?? -1 };
    });
  const select = (id: string | null) =>
    page.evaluate((v) => {
      (window as unknown as W).__basher_selection.getState().select(v);
    }, id);

  await page.waitForTimeout(1200);
  const baseline = await probe();
  expect(baseline.gizmos, 'nothing is selected, so no gizmo should be mounted').toBe(0);
  expect(baseline.gl, 'the GL counter must be readable').toBeGreaterThan(0);

  for (let i = 1; i <= CYCLES; i++) {
    await select('n_box');
    await page.waitForFunction(
      () => {
        const w = window as unknown as W;
        const scene = w.__basher_three.getState().scene as Obj | null;
        let found = false;
        const walk = (o: Obj): void => {
          if (/TransformControlsGizmo/.test(`${o.type ?? ''} ${o.name ?? ''}`)) found = true;
          (o.children ?? []).forEach(walk);
        };
        if (scene) walk(scene);
        return found;
      },
      undefined,
      { timeout: 10_000 },
    );

    await select(null);
    await page.waitForTimeout(600);
    const after = await probe();
    expect(after.gizmos, `cycle ${i}: the gizmo should be gone after deselect`).toBe(0);
    // The whole point: the population returns to where it started, every cycle, rather than
    // climbing by a gizmo's worth of geometry each time.
    expect(after.gl, `cycle ${i}: GL geometries leaked (baseline ${baseline.gl})`).toBe(
      baseline.gl,
    );
  }
});
