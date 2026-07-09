// p270 — the D1 extend / #275 Cycles-modifier UI authored from the INSPECTOR.
// #269 proved setParam → render. #270 added the per-side "Extend / Before / After"
// dropdown; #275 SPLIT it: the dropdown now authors only the EXTRAPOLATION (hold /
// slope), and the cycle family (repeat / repeat-offset / repeat-mirror) is authored
// as a Cycles F-Modifier card in the animate section (ChannelModifierControls).
//
// THIS spec drives the actual UI, not setParam, proving the NEW path end-to-end:
//   - the Extend dropdown enumerates just ['hold','slope'] and lives in the animate
//     section (not the raw bucket);
//   - adding a Cycles modifier (afterMode=repeat-offset) → the rendered box TRAVELS
//     to x=4 at t=4; setting afterMode=none clamps it back to x=2 (falsify);
//   - the Cycles COUNT (afterCycles) freezes the loop after N periods.
//
// REF: issues #270 / #275; vyapti V88 D1/D2; src/app/NPanel.tsx (ChannelExtendControls
//      + ChannelModifierControls + paramToSection 'animate' routing).

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

test.describe('#270/#275 — extend + Cycles modifier authored from the inspector', () => {
  test('the Extend dropdown enumerates just hold/slope and lives in the animate section', async ({
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
    // #275 — the dropdown is now just the extrapolation property (hold/slope); the
    // cycle family moved to the Cycles F-Modifier card below.
    const opts = await animateBody
      .getByTestId(`inspector-enum-${CH}-extendAfter`)
      .locator('option')
      .allTextContents();
    expect(opts).toEqual(['hold', 'slope']);
  });

  test('adding a Cycles modifier (repeat-offset) makes the box travel; afterMode=none clamps (falsify)', async ({
    page,
  }) => {
    const toggle = page.getByTestId('inspector-section-toggle-animate');
    if (await toggle.isVisible().catch(() => false)) await toggle.click();
    const body = page.getByTestId('inspector-section-body-animate');

    // Add a Cycles modifier from the stack's "+ cycles" button, then set the After
    // side to repeat-offset (travel) via its mode select.
    await body.getByTestId('channel-modifier-add-cycles').click();
    const afterMode = body.getByTestId('channel-modifier-0-afterMode');
    await expect(afterMode).toBeVisible({ timeout: 10_000 });
    await afterMode.selectOption('repeat-offset');

    // …and the LIVE render followed: at t=4 the box travels to x=4 (two +2 spans).
    await setTime(page, 4);
    await page.waitForFunction(() => {
      const p = (window as unknown as BasherWindow).__basher_mesh_world_position!('n_box');
      return p !== null && Math.abs(p[0] - 4) < 1e-2;
    });
    expect(await renderedX(page), 'UI cycles repeat-offset → render travels').toBeCloseTo(4, 2);

    // FALSIFY: afterMode → none → the After side falls back to hold → t=4 clamps to x=2.
    await afterMode.selectOption('none');
    await page.waitForFunction(() => {
      const p = (window as unknown as BasherWindow).__basher_mesh_world_position!('n_box');
      return p !== null && Math.abs(p[0] - 2) < 1e-2;
    });
    expect(await renderedX(page), 'UI afterMode none → render clamps').toBeCloseTo(2, 2);
  });

  test('the Cycles COUNT (afterCycles) freezes the loop after N periods (Blender FModifierCycles.count)', async ({
    page,
  }) => {
    const toggle = page.getByTestId('inspector-section-toggle-animate');
    if (await toggle.isVisible().catch(() => false)) await toggle.click();
    const body = page.getByTestId('inspector-section-body-animate');

    await body.getByTestId('channel-modifier-add-cycles').click();
    const afterMode = body.getByTestId('channel-modifier-0-afterMode');
    await expect(afterMode).toBeVisible({ timeout: 10_000 });
    await afterMode.selectOption('repeat-offset');
    // The count input appears once the side repeats.
    const count = body.getByTestId('channel-modifier-0-afterCycles');
    await expect(count).toBeVisible();

    // Infinite (count 0): at t=6 the box has travelled three +2 spans → x=6.
    await setTime(page, 6);
    await page.waitForFunction(() => {
      const p = (window as unknown as BasherWindow).__basher_mesh_world_position!('n_box');
      return p !== null && Math.abs(p[0] - 6) < 1e-2;
    });
    expect(await renderedX(page), 'infinite repeat-offset → x=6 at t=6').toBeCloseTo(6, 2);

    // Author count = 1 → the loop plays once then FREEZES at last + 1·delta = 4.
    // The SAME t=6 now renders x=4, not x=6.
    await count.fill('1');
    await count.blur();
    await page.waitForFunction(() => {
      const p = (window as unknown as BasherWindow).__basher_mesh_world_position!('n_box');
      return p !== null && Math.abs(p[0] - 4) < 1e-2;
    });
    expect(await renderedX(page), 'count=1 → frozen at x=4').toBeCloseTo(4, 2);
  });
});
