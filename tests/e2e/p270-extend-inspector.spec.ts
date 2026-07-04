// p270 — the D1 extend rule authored from the INSPECTOR (issue #270, follow-up to
// #269). #269 proved setParam(extendAfter) → render. #270 adds the UI affordance:
// a per-side "Extend / Before / After" dropdown in the channel's animate section.
//
// THIS spec drives the actual <select> (selectOption), not setParam, so it proves
// the NEW path end-to-end: UI dropdown → setParam → DAG → LIVE render. A position
// channel on n_box (keys [0,0,0]@t0 → [2,0,0]@t2, domain [0,2]) is sampled at t=4:
//   - authoring 'cycle-offset' in the After dropdown → the rendered box TRAVELS to
//     x=4 (two spans of +2).
//   - FALSIFY: authoring 'hold' back → the SAME t=4 clamps to x=2.
// Plus a structural check: the control lives in the animate section (not the raw
// unrouted bucket) and carries the "Extend" grouping label.
//
// REF: issue #270; #269 / vyapti V88 D1; src/app/NPanel.tsx (ChannelExtendControls
//      + paramToSection 'animate' routing); src/app/inspectorSections.ts.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      dispatchAtomic: (ops: unknown[], source?: string, description?: string) => unknown;
    };
  };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
  __basher_mesh_world_position?: (nodeId: string) => [number, number, number] | null;
}

const CH = 'p270_ch';

async function setTime(page: import('@playwright/test').Page, seconds: number) {
  await page.evaluate((s) => {
    (window as unknown as BasherWindow).__basher_time!.getState().setTime(s);
  }, seconds);
}
async function renderedX(page: import('@playwright/test').Page) {
  const p = await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_mesh_world_position!('n_box'),
  );
  return p ? p[0] : null;
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
    return Boolean(
      w.__basher_dag && w.__basher_time && w.__basher_selection && w.__basher_mesh_world_position,
    );
  });
  await page.waitForFunction(
    () => (window as unknown as BasherWindow).__basher_mesh_world_position!('n_box') !== null,
  );
  // Position channel on n_box: [0,0,0]@t0 → [2,0,0]@t2. Domain [0,2].
  await page.evaluate((ch) => {
    const w = window as unknown as BasherWindow;
    w.__basher_dag!.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: ch,
          nodeType: 'KeyframeChannelVec3',
          params: {
            name: 'position',
            target: 'n_box',
            paramPath: 'position',
            keyframes: [
              { time: 0, value: [0, 0, 0], easing: 'linear' },
              { time: 2, value: [2, 0, 0], easing: 'linear' },
            ],
          },
        },
      ],
      'user',
      'p270-seed',
    );
    w.__basher_selection!.getState().select(ch);
  }, CH);
});

test.describe('#270 — extend rule authored from the inspector', () => {
  test('the Extend dropdown lives in the animate section (not the raw bucket)', async ({
    page,
  }) => {
    const toggle = page.getByTestId('inspector-section-toggle-animate');
    if (await toggle.isVisible().catch(() => false)) await toggle.click();

    const animateBody = page.getByTestId('inspector-section-body-animate');
    await expect(animateBody.getByTestId(`inspector-enum-${CH}-extendBefore`)).toBeVisible({
      timeout: 10_000,
    });
    await expect(animateBody.getByTestId(`inspector-enum-${CH}-extendAfter`)).toBeVisible();
    // Grouped under the "Extend" label, and NOT duplicated in the unrouted bucket.
    await expect(animateBody.getByText('Extend', { exact: true })).toBeVisible();
    await expect(
      page.getByTestId('inspector-unrouted-params').getByTestId(`inspector-enum-${CH}-extendAfter`),
    ).toHaveCount(0);
    // The dropdown enumerates CHANNEL_EXTEND_RULES in authoring order.
    const opts = await animateBody
      .getByTestId(`inspector-enum-${CH}-extendAfter`)
      .locator('option')
      .allTextContents();
    expect(opts).toEqual(['hold', 'cycle', 'cycle-offset', 'mirror', 'slope']);
  });

  test('authoring cycle-offset in the After dropdown makes the rendered box travel; hold clamps (falsify)', async ({
    page,
  }) => {
    const toggle = page.getByTestId('inspector-section-toggle-animate');
    if (await toggle.isVisible().catch(() => false)) await toggle.click();
    const after = page
      .getByTestId('inspector-section-body-animate')
      .getByTestId(`inspector-enum-${CH}-extendAfter`);
    await expect(after).toBeVisible({ timeout: 10_000 });
    await expect(after).toHaveValue('hold');

    // UI → setParam: pick cycle-offset from the dropdown.
    await after.selectOption('cycle-offset');
    await expect(after).toHaveValue('cycle-offset');

    // …and the LIVE render followed: at t=4 the box travels to x=4 (two +2 spans).
    await setTime(page, 4);
    await page.waitForFunction(() => {
      const p = (window as unknown as BasherWindow).__basher_mesh_world_position!('n_box');
      return p !== null && Math.abs(p[0] - 4) < 1e-2;
    });
    expect(await renderedX(page), 'UI cycle-offset → render travels').toBeCloseTo(4, 2);

    // FALSIFY: author 'hold' back in the SAME dropdown → the SAME t=4 clamps to x=2.
    await after.selectOption('hold');
    await expect(after).toHaveValue('hold');
    await page.waitForFunction(() => {
      const p = (window as unknown as BasherWindow).__basher_mesh_world_position!('n_box');
      return p !== null && Math.abs(p[0] - 2) < 1e-2;
    });
    expect(await renderedX(page), 'UI hold → render clamps').toBeCloseTo(2, 2);
  });
});
