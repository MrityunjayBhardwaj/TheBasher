// #341 — a constraint's object reference is bindable from the inspector, by MOUSE.
//
// Before this, a director could add a Follow-Path and then not bind it by any means: a
// string ref param rendered as read-only text, so an unset `curve` rendered as NOTHING.
// The same hole sat under `TrackTo.aimNode`, hidden only by the bespoke camera look-at
// dropdown. This spec drives the general node-ref picker — the REAL <select>, not an op —
// for both members of the family.
//
// This is the affordance p339's panel test could not test: it bound the curve through
// `dispatchAtomic` because there was no field, and said so in place. Here the bind IS the
// affordance under test. A test that reaches past the affordance cannot test it (#327).
//
// The shape assertion is load-bearing: the constraint family stores refs as PLAIN STRING
// ids (the enumeration compares `p.target`/reads `curve` raw), so the picker must write a
// string — not the `{node}` object the geometry-query family uses. Writing an object here
// would fold nothing and break silently, with the picker looking bound.

import { expect, test } from './_fixtures';

interface CurveSample {
  point: [number, number, number];
}
interface UiWindow {
  __basher_dag: {
    getState(): {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      dispatchAtomic: (ops: unknown[], src: string, d: string) => void;
    };
  };
  __basher_selection: { getState(): { select: (id: string) => void } };
  __basher_curve_sample: (nodeId: string, u: number) => CurveSample | null;
  __basher_mesh_world_position: (nodeId: string) => [number, number, number] | null;
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

/** A curve wired into the scene, offset + rotated + non-uniformly scaled (so binding it
 *  visibly moves the object away from its authored spot). Named `n_path`. */
async function addPosedCurve(page: import('@playwright/test').Page): Promise<string> {
  await page.evaluate(() => {
    (window as unknown as UiWindow).__basher_dag.getState().dispatchAtomic(
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

async function renderedWorldPosition(page: import('@playwright/test').Page, pickId: string) {
  return page.evaluate(
    (id) => (window as unknown as UiWindow).__basher_mesh_world_position(id),
    pickId,
  );
}

async function paramOf(page: import('@playwright/test').Page, nodeId: string, path: string) {
  return page.evaluate(
    ([id, p]) =>
      (window as unknown as UiWindow).__basher_dag.getState().state.nodes[id]?.params[p] ?? null,
    [nodeId, path] as [string, string],
  );
}

/** Add a constraint of `type` on n_box through the REAL panel, and select it so its own
 *  inspector (with the ref picker) is showing. Returns the new node's id. */
async function addAndSelectConstraint(
  page: import('@playwright/test').Page,
  type: 'FollowPath' | 'TrackTo',
): Promise<string> {
  await page.evaluate(() =>
    (window as unknown as UiWindow).__basher_selection.getState().select('n_box'),
  );
  await page.getByTestId('inspector-section-toggle-constraint').click();
  const stack = page.getByTestId('constraint-stack');
  await expect(stack).toBeVisible();
  await page.getByTestId(`constraint-add-${type}`).click();

  const rows = stack.locator('[data-testid^="constraint-row-"]');
  await expect(rows).toHaveCount(1);
  const id = (await rows.first().getAttribute('data-testid'))!.replace('constraint-row-', '');
  // The real affordance to edit a constraint: click its row → it becomes the selection →
  // its inspector (with the ref picker) shows.
  await rows.first().locator('button').first().click();
  return id;
}

test('a director binds a Follow-Path to a curve with the picker — string shape, and it flies', async ({
  page,
}) => {
  await boot(page);
  const curveId = await addPosedCurve(page);

  const before = await renderedWorldPosition(page, 'n_box');
  expect(before).toBeTruthy();

  const fpId = await addAndSelectConstraint(page, 'FollowPath');

  // The picker exists and is populated — the field that DID NOT EXIST before #341.
  const picker = page.getByTestId(`inspector-noderef-${fpId}-curve`);
  await expect(picker).toBeVisible();

  // Bind by CHOOSING the curve in the real <select>. No dispatchAtomic.
  await picker.selectOption(curveId);
  await page.waitForTimeout(400);

  // The param must be the raw string id, NOT a {node} object — the constraint family's shape.
  expect(await paramOf(page, fpId, 'curve')).toBe(curveId);

  // And the RENDER road obeys it: the box now sits on the path at evalTime 0 (the default).
  const seamStart = await page.evaluate(
    (cid) => (window as unknown as UiWindow).__basher_curve_sample(cid, 0),
    curveId,
  );
  const onPath = await renderedWorldPosition(page, 'n_box');
  const gap = Math.hypot(
    onPath![0] - seamStart!.point[0],
    onPath![1] - seamStart!.point[1],
    onPath![2] - seamStart!.point[2],
  );
  expect(gap, 'binding via the picker must move the object onto the path').toBeLessThan(1e-3);
  // It genuinely LEFT its authored spot (else a frozen object would pass a stale seam).
  expect(
    Math.hypot(onPath![0] - before![0], onPath![1] - before![1], onPath![2] - before![2]),
  ).toBeGreaterThan(0.5);

  // Clearing to "— none —" writes the empty STRING (the param's inert default), not
  // undefined — and the object returns to where it was authored.
  await picker.selectOption('');
  await page.waitForTimeout(400);
  expect(await paramOf(page, fpId, 'curve')).toBe('');
  const cleared = await renderedWorldPosition(page, 'n_box');
  expect(
    Math.hypot(cleared![0] - before![0], cleared![1] - before![1], cleared![2] - before![2]),
  ).toBeLessThan(1e-6);
});

test('the SAME picker binds a Track-To aim target — the family half, string shape (#341/H157)', async ({
  page,
}) => {
  await boot(page);
  // A transformable to aim at (the posed curve carries a position; so does the default Null).
  const curveId = await addPosedCurve(page);

  const ttId = await addAndSelectConstraint(page, 'TrackTo');

  // Track-To's aim target got the identical hole; the identical picker now fills it.
  const picker = page.getByTestId(`inspector-noderef-${ttId}-aimNode`);
  await expect(picker).toBeVisible();

  await picker.selectOption(curveId);
  await page.waitForTimeout(300);

  // Plain string, so the enumeration and the aim resolver read it directly (a {node} object
  // here would be silently ignored — the exact family-split option 2 was rejected to avoid).
  expect(await paramOf(page, ttId, 'aimNode')).toBe(curveId);
});
