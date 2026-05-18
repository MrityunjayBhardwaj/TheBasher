// P7 Animation Authoring — e2e observation gate for the "Animate this"
// director affordance.
//
// Wave D scope (this file, this wave): D2 Auto-Key indicator unmissability +
// D4 Auto-Key commit-handler interception. Wave E adds the rotation-delta
// motion test to this same spec file later.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
    };
  };
  __basher_viewport?: { getState: () => { timelineDrawerOpen: boolean } };
  __basher_time?: { getState: () => { setTime: (s: number) => void; seconds: number } };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
}

/** All KeyframeChannel* nodes currently in the DAG (the byte-identical /
 *  motion observable — we assert on these, never on a row or count). */
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

async function selectBoxAndOpenTransform(page: import('@playwright/test').Page) {
  // beforeEach puts us in Animate mode where the SceneTree row is not the
  // active surface; drive selection through __basher_selection (mode-
  // independent, the same store driver acceptance.spec.ts:123 uses). The
  // input edit still goes through Playwright .fill() so React's controlled
  // input sees real input/change events (a raw DOM .value set does not).
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_selection);
  });
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_selection!.getState().select('n_box');
  });
  await expect(page.getByTestId('inspector')).toBeVisible();
  // BoxMesh: Mesh is the primary domain; Transform is default-collapsed
  // (§5.8). Position lives in Transform — expand it to reach the input.
  await page.getByTestId('inspector-section-toggle-transform').click();
  await expect(page.getByTestId('inspector-section-body-transform')).toBeVisible();
}

async function editPositionX(page: import('@playwright/test').Page, v: string) {
  // .fill() + Tab dispatches the input/change events React tracks (mirrors
  // acceptance.spec.ts:127-128) — the inspector onChange fires for real,
  // which is exactly the D4 commit chokepoint under test.
  const input = page.getByTestId('inspector-vec-n_box-position-x');
  await expect(input).toBeVisible();
  await input.fill(v);
  await input.press('Tab');
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
    return Boolean(w.__basher_dag && w.__basher_viewport);
  });
  // Timebar lives in the layout's persistent timeline slot; Animate mode is
  // where keyframe authoring happens (D-UX-1).
  await page.getByTestId('mode-switcher').selectOption('animate');
});

test.describe('P7 D2 — Auto-Key indicator is unmissable (footgun mitigation)', () => {
  test('OFF by default: no record-armed treatment', async ({ page }) => {
    const bar = page.getByTestId('timebar');
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('data-autokey', 'off');
    // The dot exists but is the hollow idle ring — NOT the armed filled dot.
    const dot = page.getByTestId('autokey-dot');
    await expect(dot).not.toHaveClass(/bg-record/);
    await expect(page.getByTestId('autokey-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  test('toggle ON → red dot + tinted header, visible across panel focus changes', async ({ page }) => {
    await page.getByTestId('autokey-toggle').click();

    const bar = page.getByTestId('timebar');
    await expect(bar).toHaveAttribute('data-autokey', 'on');
    // Tinted header treatment present (record-tinted bg + border).
    await expect(bar).toHaveClass(/bg-record\/15/);
    await expect(bar).toHaveClass(/border-record/);
    // Filled, pulsing red record dot.
    const dot = page.getByTestId('autokey-dot');
    await expect(dot).toHaveClass(/bg-record/);
    await expect(dot).toHaveClass(/animate-pulse/);
    await expect(page.getByTestId('autokey-toggle')).toHaveAttribute('aria-pressed', 'true');

    // Move focus into a different panel (the scene tree / inspector area):
    // the indicator must REMAIN — it is global, not focus-scoped.
    await page.getByTestId('timebar-scrub').focus();
    await page.keyboard.press('Tab');
    await expect(bar).toHaveAttribute('data-autokey', 'on');
    await expect(bar).toHaveClass(/bg-record\/15/);
    await expect(dot).toHaveClass(/bg-record/);
  });

  test('toggle OFF again → treatment fully removed', async ({ page }) => {
    const toggle = page.getByTestId('autokey-toggle');
    await toggle.click();
    await expect(page.getByTestId('timebar')).toHaveAttribute('data-autokey', 'on');
    await toggle.click();
    const bar = page.getByTestId('timebar');
    await expect(bar).toHaveAttribute('data-autokey', 'off');
    await expect(bar).not.toHaveClass(/bg-record\/15/);
    await expect(page.getByTestId('autokey-dot')).not.toHaveClass(/bg-record/);
  });
});

test.describe('P7 D4 — Auto-Key commit-handler interception (single chokepoint)', () => {
  test('Auto-Key OFF → edit Position creates ZERO channels (byte-identical to pre-P7)', async ({
    page,
  }) => {
    await selectBoxAndOpenTransform(page);
    // Auto-Key is OFF by default — do NOT toggle it.
    expect(await channelNodes(page)).toHaveLength(0);

    await editPositionX(page, '2.5');

    // The raw setParam landed (pre-P7 behaviour) but ZERO KeyframeChannel
    // nodes were created — the seam was never entered. Byte-identical.
    const after = await channelNodes(page);
    expect(after).toHaveLength(0);
    const boxPos = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      return w.__basher_dag!.getState().state.nodes['n_box'].params.position;
    });
    expect((boxPos as number[])[0]).toBe(2.5); // raw setParam only
  });

  test('Auto-Key ON → first-key composite then single keyframe on the SAME channel', async ({
    page,
  }) => {
    await selectBoxAndOpenTransform(page);
    await page.getByTestId('autokey-toggle').click();
    await expect(page.getByTestId('timebar')).toHaveAttribute('data-autokey', 'on');

    // Scrub to frame 30 (0.5s @ 60fps) and edit Position → first-key
    // composite: a layer + a channel + ONE keyframe at 0.5s.
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_time!.getState().setTime(0.5);
    });
    await editPositionX(page, '1');

    let chs = await channelNodes(page);
    expect(chs).toHaveLength(1);
    expect(chs[0].target).toBe('n_box');
    expect(chs[0].paramPath).toBe('position');
    expect(chs[0].keyframes).toHaveLength(1);
    expect(chs[0].keyframes[0].time).toBeCloseTo(0.5, 5);
    const channelId = chs[0].id;

    // Scrub to frame 60 (1.0s) and edit again → a SINGLE keyframe
    // appended to the SAME channel (no second layer/channel).
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_time!.getState().setTime(1.0);
    });
    await editPositionX(page, '3');

    chs = await channelNodes(page);
    expect(chs).toHaveLength(1); // still ONE channel
    expect(chs[0].id).toBe(channelId); // the SAME channel
    expect(chs[0].keyframes).toHaveLength(2);
    const times = chs[0].keyframes.map((k) => k.time).sort((a, b) => a - b);
    expect(times[0]).toBeCloseTo(0.5, 5);
    expect(times[1]).toBeCloseTo(1.0, 5);
  });
});
