// #212 / item 2 — keyframing a light's emission from the LIGHT STUDIO PANEL.
//
// The Light Studio panel's per-light controls (intensity/color/width/height) used
// to be bare <input> + setParam — no keyframe affordance, so a director could not
// animate a light from the panel. Item 2 wired each control onto the shared
// useAnimatableField spine (the H104 affordance the inspector material rows use)
// plus a ParamDiamond. This OBSERVES, on the live app, that authoring through the
// PANEL (not the inspector) creates a free-floating channel AND renders it (via
// seam A / DirectChannelsLightR):
//   1. open the Light Studio → "+ Light"
//   2. click the PANEL intensity diamond (studio-diamond-<id>-intensity) at t=0
//   3. Auto-Key ON → scrub to t=2 → set the PANEL intensity input to 40
//   4. assert the resolver AND the live RectAreaLight both track 5 → 40
//
// The panel diamond uses a DISTINCT testid (studio-diamond-…) from the inspector's
// (inspector-diamond-…) so the two never collide when both are visible (H95).
//
// REF: src/timeline/LightStudioPanel.tsx (StudioLightControls), useAnimatableField,
//      deep-light-studio-animation (the inspector-authored sibling), V57, H40.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
    };
  };
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
  __basher_autokey?: { getState: () => { toggle: () => void; enabled: boolean } };
  __basher_evaluated_param?: (
    nodeId: string,
    paramPath: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { value: unknown } | null;
  __basher_three?: {
    getState: () => {
      scene: {
        traverse: (
          cb: (o: {
            type: string;
            intensity?: number;
            position: { x: number; y: number; z: number };
          }) => void,
        ) => void;
      } | null;
    };
  };
}

const ctxAt = (seconds: number) => ({
  time: { frame: Math.round(seconds * 60), seconds, normalized: 0 },
});
type Page = import('@playwright/test').Page;

async function setTime(page: Page, seconds: number) {
  await page.evaluate((s) => {
    (window as unknown as BasherWindow).__basher_time!.getState().setTime(s);
  }, seconds);
}

async function areaLightIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
    return Object.entries(nodes)
      .filter(([, n]) => n.type === 'AreaLight')
      .map(([id]) => id);
  });
}

async function resolvedIntensity(page: Page, lid: string, seconds: number): Promise<number | null> {
  return page.evaluate(
    ({ lid, c }) => {
      const r = (window as unknown as BasherWindow).__basher_evaluated_param!(lid, 'intensity', c);
      return r && typeof r.value === 'number' ? r.value : null;
    },
    { lid, c: ctxAt(seconds) },
  );
}

async function liveIntensity(page: Page, pos: [number, number, number]): Promise<number | null> {
  return page.evaluate((p) => {
    const three = (window as unknown as BasherWindow).__basher_three!.getState().scene;
    if (!three) return null;
    let best: number | null = null;
    let bestD = Infinity;
    three.traverse((o) => {
      if (o.type !== 'RectAreaLight' || typeof o.intensity !== 'number') return;
      const d = Math.hypot(o.position.x - p[0], o.position.y - p[1], o.position.z - p[2]);
      if (d < bestD) {
        bestD = d;
        best = o.intensity;
      }
    });
    return best;
  }, pos);
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
      w.__basher_dag && w.__basher_time && w.__basher_evaluated_param && w.__basher_three,
    );
  });
});

test.describe('#212 — keyframing a light from the Light Studio panel', () => {
  test('panel diamond + Auto-Key author a channel that RENDERS (panel == render == resolver)', async ({
    page,
  }) => {
    // open the Light Studio + add a light
    const drawer = page.getByTestId('timeline-drawer');
    if ((await drawer.getAttribute('data-open')) !== 'true') {
      await page.getByTestId('timeline-drawer-toggle').click();
    }
    await page.getByTestId('timeline-tab-lightStudio').click();
    await expect(page.getByTestId('light-studio-panel')).toBeVisible();

    const before = await areaLightIds(page);
    await page.getByTestId('light-studio-add').click();
    await expect(page.locator('[data-testid^="light-studio-controls-"]')).toBeVisible();
    const after = await areaLightIds(page);
    const lid = after.find((id) => !before.includes(id))!;
    expect(lid, 'a new AreaLight was created').toBeTruthy();

    const lightPos = await page.evaluate((id) => {
      const n = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes[id];
      return (n.params.position ?? null) as [number, number, number] | null;
    }, lid);
    expect(lightPos).not.toBeNull();

    // key intensity at t=0 via the PANEL diamond (distinct testid from the inspector)
    await setTime(page, 0);
    const diamond = page.getByTestId(`studio-diamond-${lid}-intensity`);
    await expect(diamond).toBeVisible();
    await expect(diamond).toHaveAttribute('data-anim-state', 'none');
    await diamond.click();
    await expect(diamond).toHaveAttribute('data-anim-state', 'on-key');

    // Auto-Key ON (store seam — the panel z-overlaps the timebar), scrub, set 40
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_autokey!.getState().toggle();
    });
    await expect(page.getByTestId('timebar')).toHaveAttribute('data-autokey', 'on');
    await setTime(page, 2);
    const input = page.getByTestId(`light-intensity-${lid}`);
    await input.fill('40');
    await input.press('Tab');

    // the panel intensity channel now carries two keys (5 → 40)
    const keys = await page.evaluate((id) => {
      const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
      const c = Object.values(nodes).find(
        (n) =>
          n.type.startsWith('KeyframeChannel') &&
          (n.params as { target?: string }).target === id &&
          (n.params as { paramPath?: string }).paramPath === 'intensity',
      );
      return c ? ((c.params as { keyframes?: unknown[] }).keyframes ?? []).length : 0;
    }, lid);
    expect(keys, 'panel diamond authored a 2-key intensity channel').toBe(2);

    // OBSERVE resolver AND live render track across time
    const rows: { t: number; resolved: number | null; live: number | null }[] = [];
    for (const t of [0, 2]) {
      await setTime(page, t);
      await page.waitForTimeout(80);
      rows.push({
        t,
        resolved: await resolvedIntensity(page, lid, t),
        live: await liveIntensity(page, lightPos!),
      });
    }
    console.log(
      `\n[p212 PANEL] intensity by time:` +
        rows.map((r) => `\n  t=${r.t}  resolver=${r.resolved}  liveRender=${r.live}`).join('') +
        `\n`,
    );

    expect(rows[0].resolved).toBeCloseTo(5, 1);
    expect(rows[1].resolved).toBeCloseTo(40, 1);
    // render == resolver (seam A overlays the channel onto the live light)
    expect(rows[0].live).toBeCloseTo(rows[0].resolved!, 1);
    expect(rows[1].live).toBeCloseTo(rows[1].resolved!, 1);
    expect(rows[1].live).not.toBeCloseTo(rows[0].live ?? 0, 1);
  });
});
