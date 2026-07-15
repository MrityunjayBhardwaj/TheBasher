// #339 — Follow-Path: the camera travels the curve while staying locked on its subject.
//
// THE ONE THING NO UNIT TEST CAN SEE (the same boundary pair #321/#322 ship an e2e for,
// now with Follow-Path as a third party): the point the constraint flies the object to is
// composed by the SEAM, multiplying `resolveWorldTransform`'s matrix. The place the object
// actually appears is composed by the RENDERER, posing a three.js <group>. Two paths over
// one TRS. Diverge, and the camera flies along a path the director cannot see — with every
// unit assertion green, reading as "the animation is wrong".
//
// So we sample the SEAM from the running app and compare it against the object's real
// matrixWorld in the LIVE three.js scene graph, under an offset + rotated + NON-UNIFORMLY
// scaled curve (the case where local arc length stops tracking world arc length).
//
// FALSIFIABILITY PROBE (run before trusting this file): drop the parent-local / world
// compose from `resolveConstraintPosition` and the boundary-pair test goes red while the
// unit suite stays green.
//
// It also drives the REAL panel affordance to add the constraint — not the store — because
// a test that reaches past the affordance cannot test the affordance (#327).

import { expect, test } from './_fixtures';

interface CurveSample {
  point: [number, number, number];
  tangent: [number, number, number];
  length: number;
}
interface UiWindow {
  __basher_dag: {
    getState(): {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      dispatch: (op: unknown) => void;
      dispatchAtomic: (ops: unknown[], src: string, d: string) => void;
    };
  };
  __basher_selection: { getState(): { select: (id: string) => void } };
  __basher_curve_sample: (nodeId: string, u: number) => CurveSample | null;
  __basher_mesh_world_position: (nodeId: string) => [number, number, number] | null;
  __basher_time?: { getState(): { setTime: (s: number) => void } };
}

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForSelector('canvas');
  await page.waitForFunction(() => Boolean((window as unknown as UiWindow).__basher_selection));
}

/** A curve wired into the scene, posed so the two compositions have something to disagree
 *  about: an offset, a rotation, and a NON-UNIFORM scale. */
async function addPosedCurve(page: import('@playwright/test').Page): Promise<string> {
  await page.evaluate(() => {
    const dag = (window as unknown as UiWindow).__basher_dag.getState();
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'n_path',
          nodeType: 'Curve',
          params: {
            points: [
              [0, 0, 0],
              [10, 0, 0],
              [11, 0, 0],
              [12, 0, 0],
            ],
            closed: false,
            resolution: 32,
            position: [1, 2, -3],
            rotation: [0, 35, 0],
            scale: [2, 1, 0.5],
          },
        },
        {
          type: 'connect',
          from: { node: 'n_path', socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        },
      ],
      'user',
      'add a posed path',
    );
  });
  await page.waitForTimeout(300);
  return 'n_path';
}

/** The world position of the object the renderer actually mounted — the pixels, not a
 *  re-derivation.
 *
 *  Via the EXISTING `__basher_mesh_world_position` seam, which walks to the inner MESH.
 *  That detail is load-bearing and this test learned it the hard way: the group named by
 *  the pick id is the SceneChildNode WRAPPER, and the wrapper is identity — the mesh
 *  inside carries the overlaid transform. Reading the wrapper reports [0,0,0] for every
 *  object in the scene, which looks exactly like "the constraint did nothing." */
async function renderedWorldPosition(
  page: import('@playwright/test').Page,
  pickId: string,
): Promise<[number, number, number] | null> {
  return page.evaluate(
    (id) => (window as unknown as UiWindow).__basher_mesh_world_position(id),
    pickId,
  );
}

test('the object RENDERS where the seam says the path is — offset + rotated + non-uniform scale', async ({
  page,
}) => {
  await boot(page);
  const curveId = await addPosedCurve(page);

  await page.evaluate((cid) => {
    (window as unknown as UiWindow).__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'n_fp',
          nodeType: 'FollowPath',
          params: { target: 'n_box', curve: cid, evalTime: 0.5, offset: 0, order: 0 },
        },
      ],
      'user',
      'follow the path',
    );
  }, curveId);
  await page.waitForTimeout(400);

  const seam = await page.evaluate(
    (cid) => (window as unknown as UiWindow).__basher_curve_sample(cid, 0.5),
    curveId,
  );
  const rendered = await renderedWorldPosition(page, 'n_box');

  expect(seam, 'the seam must resolve the posed curve').toBeTruthy();
  // NOT `if (rendered)` — a scene walk that quietly finds nothing would leave this test
  // green while proving nothing. The object must BE there.
  expect(rendered, 'the viewport must have mounted a group for the box').toBeTruthy();

  const p = seam!.point;
  const r = rendered!;
  const gap = Math.hypot(r[0] - p[0], r[1] - p[1], r[2] - p[2]);
  console.log(`[boundary-pair] seam=${JSON.stringify(p)} rendered=${JSON.stringify(r)}`);
  // Same point, both roads. The tolerance is float noise, not sampling slack: the object
  // is placed AT the seam's point, not near it.
  expect(gap).toBeLessThan(1e-3);
});

// SCOPE, STATED HONESTLY (#341): the ADD and the MUTE below are real affordances — real
// clicks on real buttons. The BIND is not: it goes through an op, because the inspector
// currently offers NO field for `curve` at all (a string param renders as read-only text,
// so an unset ref renders as nothing). That is a family-wide gap — `TrackTo.aimNode` has
// the same hole, hidden only by the bespoke camera look-at dropdown — and it is filed as
// #341, not fixed here.
//
// Saying so in place matters: this test reaches past the affordance for exactly the step
// that HAS no affordance, which is #327's lesson recurring. An unlabelled `dispatchAtomic`
// here would read as "the panel road is covered" when the panel road is broken.
test('the director adds Follow Path from the panel; it binds and bypasses (bind via op — see #341)', async ({
  page,
}) => {
  await boot(page);
  const curveId = await addPosedCurve(page);

  const before = await renderedWorldPosition(page, 'n_box');
  expect(before).toBeTruthy();

  // The REAL affordance: select the object, open its Constraints section, press + Add.
  await page.evaluate(() =>
    (window as unknown as UiWindow).__basher_selection.getState().select('n_box'),
  );
  await page.getByTestId('inspector-section-toggle-constraint').click();
  const stack = page.getByTestId('constraint-stack');
  await expect(stack).toBeVisible();
  await page.getByTestId('constraint-add-FollowPath').click();

  const rows = stack.locator('[data-testid^="constraint-row-"]');
  await expect(rows).toHaveCount(1);
  const fpId = (await rows.first().getAttribute('data-testid'))!.replace('constraint-row-', '');

  // A freshly added Follow-Path has no curve — it is DEGENERATE and must move nothing.
  // (An unbound constraint that yanked the object to the origin would be worse than none.)
  const unbound = await renderedWorldPosition(page, 'n_box');
  expect(
    Math.hypot(unbound![0] - before![0], unbound![1] - before![1], unbound![2] - before![2]),
  ).toBeLessThan(1e-6);

  // Bind it to the path — through an OP, because there is no field to type into (#341).
  // When #341 lands this becomes a click on the picker, and this comment goes away.
  await page.evaluate(
    ([id, cid]) => {
      const dag = (window as unknown as UiWindow).__basher_dag.getState();
      dag.dispatchAtomic(
        [
          { type: 'setParam', nodeId: id, paramPath: 'curve', value: cid },
          { type: 'setParam', nodeId: id, paramPath: 'evalTime', value: 1 },
        ],
        'user',
        'bind the path',
      );
    },
    [fpId, curveId],
  );
  await page.waitForTimeout(400);

  const seamEnd = await page.evaluate(
    (cid) => (window as unknown as UiWindow).__basher_curve_sample(cid, 1),
    curveId,
  );
  const onPath = await renderedWorldPosition(page, 'n_box');
  const gap = Math.hypot(
    onPath![0] - seamEnd!.point[0],
    onPath![1] - seamEnd!.point[1],
    onPath![2] - seamEnd!.point[2],
  );
  expect(gap).toBeLessThan(1e-3);

  // And the row can be bypassed — the object returns to where it was authored.
  await page.getByTestId(`constraint-mute-${fpId}`).click();
  await expect(page.getByTestId(`constraint-mute-${fpId}`)).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(300);
  const muted = await renderedWorldPosition(page, 'n_box');
  expect(
    Math.hypot(muted![0] - before![0], muted![1] - before![1], muted![2] - before![2]),
  ).toBeLessThan(1e-6);
});

test('a keyframed evalTime flies the object along the path as the playhead moves', async ({
  page,
}) => {
  await boot(page);
  const curveId = await addPosedCurve(page);

  await page.evaluate((cid) => {
    (window as unknown as UiWindow).__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'n_fp',
          nodeType: 'FollowPath',
          params: { target: 'n_box', curve: cid, evalTime: 0, offset: 0, order: 0 },
        },
        {
          type: 'addNode',
          nodeId: 'ch_eval',
          nodeType: 'KeyframeChannelNumber',
          params: {
            name: 'evalTime',
            target: 'n_fp',
            paramPath: 'evalTime',
            keyframes: [
              { time: 0, value: 0, easing: 'linear' },
              { time: 2, value: 1, easing: 'linear' },
            ],
          },
        },
      ],
      'user',
      'animate along the path',
    );
  }, curveId);
  await page.waitForTimeout(400);

  const at = async (seconds: number) => {
    await page.evaluate((s) => {
      (window as unknown as UiWindow).__basher_time?.getState().setTime(s);
    }, seconds);
    await page.waitForTimeout(300);
    return renderedWorldPosition(page, 'n_box');
  };

  const start = await at(0);
  const mid = await at(1);
  const end = await at(2);
  console.log(
    `[flight] 0s=${JSON.stringify(start)} 1s=${JSON.stringify(mid)} 2s=${JSON.stringify(end)}`,
  );

  // Each rendered position must sit on the path where the seam says that evalTime is —
  // the keyframe is honoured on the RENDER road, not just in the resolver.
  for (const [seconds, pos] of [
    [0, start],
    [1, mid],
    [2, end],
  ] as const) {
    const u = seconds / 2;
    const s = await page.evaluate(
      ([cid, uu]) =>
        (window as unknown as UiWindow).__basher_curve_sample(cid as string, uu as number),
      [curveId, u] as [string, number],
    );
    const gap = Math.hypot(pos![0] - s!.point[0], pos![1] - s!.point[1], pos![2] - s!.point[2]);
    expect(gap, `at ${seconds}s the object must render at u=${u}`).toBeLessThan(1e-3);
  }

  // And it actually TRAVELLED (a frozen object would satisfy nothing above if the seam
  // were also frozen — this is the independent check that the playhead did something).
  expect(Math.hypot(end![0] - start![0], end![1] - start![1], end![2] - start![2])).toBeGreaterThan(
    1,
  );
});
