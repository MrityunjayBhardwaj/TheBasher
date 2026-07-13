// p316 — the Drivers panel: the THIRD binding of the shared stack rows.
//
// What was impossible before this: two drivers on ONE param both folded, in an order the
// director could not see or control, and neither could be bypassed. This drives the panel
// and asserts the ENGINE moved each time — the rows are not decoration, they are the stack.
//
// One stack PER BAND: the fold groups by paramPath, so a driver on `position` and one on
// `material.metalness` never contend, and the panel must not imply they do.

import { test, expect } from '@playwright/test';

interface W {
  __basher_dag: {
    getState: () => {
      dispatch: (op: unknown) => void;
      state: { outputs: { scene?: { node: string } } };
    };
  };
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_evaluated_param?: (id: string, path: string) => { value: unknown } | null;
}

const METAL = 'material.metalness';

/** The read road — what the param actually resolves to after the fold. */
async function metalness(page: import('@playwright/test').Page) {
  return page.evaluate(
    () =>
      (window as unknown as W).__basher_evaluated_param?.('n_box', 'material.metalness')?.value ??
      null,
  );
}

test('the Drivers panel drives the stack: order / mute / remove', async ({ page }) => {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_selection));

  // TWO drivers on the metalness band (0.2 @ order 0, 0.8 @ order 1) + one on roughness
  // (a DIFFERENT band — it must get its own stack, and never reorder against these).
  await page.evaluate(
    ({ METAL }) => {
      const w = window as unknown as W;
      const d = (op: unknown) => w.__basher_dag.getState().dispatch(op);
      for (const [id, min] of [
        ['c_a', 0.2],
        ['c_b', 0.8],
        ['c_r', 0.5],
      ] as const) {
        d({ type: 'addNode', nodeId: id, nodeType: 'Clamp', params: { min, max: 1 } });
      }
      for (const [id, path, order] of [
        ['d_a', METAL, 0],
        ['d_b', METAL, 1],
        ['d_r', 'material.roughness', 0],
      ] as const) {
        d({
          type: 'addNode',
          nodeId: id,
          nodeType: 'ParamDriver',
          params: { target: 'n_box', paramPath: path, blendMode: 'replace', order },
        });
      }
      for (const [from, to] of [
        ['c_a', 'd_a'],
        ['c_b', 'd_b'],
        ['c_r', 'd_r'],
      ] as const) {
        d({ type: 'connect', from: { node: from, socket: 'out' }, to: { node: to, socket: 'in' } });
      }
      w.__basher_selection.getState().select('n_box');
    },
    { METAL },
  );

  // Open the Drivers section (inspector sections start collapsed).
  await page.getByTestId('inspector-section-toggle-driver').click();

  // The panel shows the two bands, each as its own stack — and the rows are named by their
  // SOURCE (both drivers are "ParamDriver"; only the source tells them apart).
  await expect(page.getByTestId(`driver-band-${METAL}`)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('driver-band-material.roughness')).toBeVisible();
  await expect(page.getByTestId('driver-row-d_a')).toContainText('c_a');
  await expect(page.getByTestId('driver-row-d_b')).toContainText('c_b');

  // TOP of the band wins.
  await expect.poll(async () => await metalness(page)).toBeCloseTo(0.8, 1);

  // REORDER — lift the bottom driver above the top one. The fold winner must follow.
  await page.getByTestId('driver-up-d_a').click();
  await expect.poll(async () => await metalness(page)).toBeCloseTo(0.2, 1);

  // MUTE the (now) winning driver → the band falls to the one below it.
  await page.getByTestId('driver-mute-d_a').click();
  await expect.poll(async () => await metalness(page)).toBeCloseTo(0.8, 1);
  await expect(page.getByTestId('driver-mute-d_a')).toHaveAttribute('aria-pressed', 'true');

  // The bypassed row is STILL THERE — that is the whole point of rendering muted members.
  await expect(page.getByTestId('driver-row-d_a')).toBeVisible();

  // UN-MUTE → it takes the band back.
  await page.getByTestId('driver-mute-d_a').click();
  await expect.poll(async () => await metalness(page)).toBeCloseTo(0.2, 1);

  // The other band never moved through any of this.
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as unknown as W).__basher_evaluated_param?.('n_box', 'material.roughness')
            ?.value ?? null,
      ),
    )
    .toBeCloseTo(0.5, 1);

  // REMOVE the winner → the band hands back to the survivor.
  await page.getByTestId('driver-remove-d_a').click();
  await expect(page.getByTestId('driver-row-d_a')).toHaveCount(0);
  await expect.poll(async () => await metalness(page)).toBeCloseTo(0.8, 1);

  // Remove the last one → the band disappears and the param falls back to its base.
  await page.getByTestId('driver-remove-d_b').click();
  await expect(page.getByTestId(`driver-band-${METAL}`)).toHaveCount(0);
  await expect.poll(async () => await metalness(page)).toBeNull();
});
