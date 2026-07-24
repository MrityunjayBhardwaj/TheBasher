// DEEP LIGHT-STUDIO ANIMATION — a headed, end-to-end observation of authoring
// AND rendering a keyframed LIGHT created through the Light Studio.
//
// Mirror of deep-cube-animation, one boundary further out: a light is wired into
// scene.lights (NOT scene.children). Seam A (#211, V57) closed the gap where a
// light flowed through the read-side resolver but NOT the renderer — LightNode now
// overlays its free-floating channels per-frame through DirectChannelsLightR (the
// light analogue of SceneChildNode → DirectChannelsR). This test asserts that
// boundary-pair end-to-end through the real UI:
//   1. open the Light Studio tab → "+ Light" (adds an AreaLight + Track-To)
//   2. the new light is selected → its inspector shows an `intensity` row
//   3. click the intensity DIAMOND at t=0 (seeds a free-floating KeyframeChannel)
//   4. Auto-Key ON → scrub to t=2 → set intensity to 50 (autoKeyCommit appends)
//
// Then assert at 3 playhead times that BOTH sides track the keyframes (5 → 50):
//   Side B (resolver) — __basher_evaluated_param(lid, 'intensity', t). The GENERIC
//          channel resolver; matches by (target, paramPath) for ANY node kind.
//   Side A (render)   — the live three.js RectAreaLight.intensity (the renderer).
//          PlainAreaLightR sets intensity={value.intensity} with no scalePower, so
//          for a default-scale light side A == side B once the renderer applies the
//          channel (which DirectChannelsLightR now does).
//
// HARD on both sides — this is a true render==resolver boundary-pair (H40) for
// lights. Before seam A the side-A checks were expect.soft (documenting the gap);
// the live render now follows, so they are hard.
//
// REF: p206 (Light Studio panel), p7/p153 (authoring + boundary-pair),
//      SceneFromDAG DirectChannelsLightR (the seam-A overlay), resolveEvaluatedParam,
//      V57 (direct-channel road), H40 (render==resolver).

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: {
        nodes: Record<
          string,
          {
            type: string;
            params: Record<string, unknown>;
            inputs?: { data?: { node?: string } };
          }
        >;
      };
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

/** The Objects posing an Area LightData — #386 C3 split the fused `AreaLight` node into an
 *  `Object` (pose) + a `LightData` (shading), so "the light" is the Object whose `data` input
 *  reaches an area LightData, not a node whose `type` is `'AreaLight'`. */
async function areaLightIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
    return Object.entries(nodes)
      .filter(([, n]) => {
        if (n.type !== 'Object') return false;
        const d = n.inputs?.data?.node;
        const dn = d ? nodes[d] : undefined;
        return dn?.type === 'LightData' && dn.params.lightKind === 'Area';
      })
      .map(([id]) => id);
  });
}

/** The LightData half of a split light — the node that owns intensity/colour, and so the
 *  node the inspector keys its shading rows to (LinkedDataSections renders the Object Data
 *  tab keyed by the DATA node's id) and the node a shading channel targets. */
async function shadingId(page: Page, objectId: string): Promise<string> {
  return page.evaluate((id) => {
    const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
    return nodes[id]?.inputs?.data?.node ?? id;
  }, objectId);
}

async function channelCount(page: Page) {
  return page.evaluate(() => {
    const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
    return Object.values(nodes).filter((n) => n.type.startsWith('KeyframeChannel')).length;
  });
}

/** The resolver-evaluated intensity at `seconds` (side B). */
async function resolvedIntensity(page: Page, lid: string, seconds: number): Promise<number | null> {
  return page.evaluate(
    ({ lid, c }) => {
      const r = (window as unknown as BasherWindow).__basher_evaluated_param!(lid, 'intensity', c);
      return r && typeof r.value === 'number' ? r.value : null;
    },
    { lid, c: ctxAt(seconds) },
  );
}

/** The live RectAreaLight nearest `pos`, read straight off the rendered scene (side A). */
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

test.describe('DEEP — animating a Light Studio light end-to-end through the real UI', () => {
  test('author intensity via diamond + Auto-Key; resolver tracks — OBSERVE whether the rendered light follows', async ({
    page,
  }) => {
    // ── 1. Open the Light Studio and add a light ──────────────────────────
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
    const lid = after.find((id) => !before.includes(id));
    expect(lid, 'a new split area light was created by "+ Light"').toBeTruthy();
    const sid = await shadingId(page, lid!);
    expect(sid, 'the new light is split — it has a LightData half').not.toBe(lid);

    const lightPos = await page.evaluate((id) => {
      const n = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes[id];
      return (n.params.position ?? null) as [number, number, number] | null;
    }, lid!);
    expect(lightPos).not.toBeNull();
    console.log(`\n[DEEP LIGHT] new light ${lid} at position ${JSON.stringify(lightPos)}`);

    // ── 2. Author intensity on the light via the REAL inspector affordance ─
    // The added light is selected → its inspector renders. intensity is a scalar
    // NumericField with a keyframe diamond.
    // H189 GATE: selecting the split light's OBJECT must still surface its shading rows —
    // the inspector renders the LightData's `light` section through LinkedDataSections,
    // keyed by the DATA node's id. No row here = the split light is uneditable.
    await expect(page.getByTestId('inspector')).toBeVisible();
    await setTime(page, 0);
    const diamond = page.getByTestId(`inspector-diamond-${sid}-intensity`);
    await expect(diamond).toBeVisible();
    await expect(diamond).toHaveAttribute('data-anim-state', 'none');
    await diamond.click();
    await expect.poll(() => channelCount(page)).toBeGreaterThanOrEqual(1);

    // ── 3. Auto-Key ON, scrub to t=2, set intensity 50 → second key ───────
    // Drive Auto-Key through the store seam (mode-independent, the same pattern
    // p7 uses for __basher_selection / __basher_time): the open Light Studio panel
    // z-overlaps the Timebar in the floating-islands layout, so the toggle button
    // isn't hit-testable — but the store toggle is the same code path the click runs.
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_autokey!.getState().toggle();
    });
    await expect(page.getByTestId('timebar')).toHaveAttribute('data-autokey', 'on');
    await setTime(page, 2);
    const input = page.getByTestId(`inspector-input-${sid}-intensity`);
    await expect(input).toBeVisible();
    await input.fill('50');
    await input.press('Tab');

    // The intensity channel now carries two keys (5 → 50).
    const ch = await page.evaluate((id) => {
      const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
      const c = Object.values(nodes).find(
        (n) =>
          n.type.startsWith('KeyframeChannel') &&
          (n.params as { target?: string }).target === id &&
          (n.params as { paramPath?: string }).paramPath === 'intensity',
      );
      return c ? ((c.params as { keyframes?: unknown[] }).keyframes ?? []).length : 0;
    }, sid);
    expect(ch, 'intensity channel has 2 keys, on the LightData').toBe(2);

    // ── 4. OBSERVE the resolver (B) AND the live rendered light (A) ────────
    const rows: { t: number; resolved: number | null; live: number | null }[] = [];
    for (const t of [0, 1, 2]) {
      await setTime(page, t);
      // Give the render loop a beat to react (if it reacts at all).
      await page.waitForTimeout(80);
      rows.push({
        t,
        resolved: await resolvedIntensity(page, lid!, t),
        live: await liveIntensity(page, lightPos!),
      });
    }
    console.log(
      `\n[DEEP LIGHT] intensity by time (resolver = side B, live render = side A):` +
        rows.map((r) => `\n  t=${r.t}  resolver=${r.resolved}  liveRender=${r.live}`).join('') +
        `\n`,
    );

    // ── HARD: authoring + resolver are correct (the channel was created and the
    //    generic resolver samples it 5 → ~27.5 → 50 over t∈[0,2], cubic) ──────
    expect(rows[0].resolved).toBeCloseTo(5, 1);
    expect(rows[2].resolved).toBeCloseTo(50, 1);
    expect(rows[1].resolved!).toBeGreaterThan(rows[0].resolved!);
    expect(rows[2].resolved!).toBeGreaterThan(rows[1].resolved!);

    // ── HARD: the RENDERED light follows (the H40 boundary-pair for lights) ──
    // Seam A wired LightNode → DirectChannelsLightR, so the live RectAreaLight
    // applies the channel each frame — side A == side B, and the light moves over
    // time. (Before seam A these were expect.soft, documenting the gap.)
    expect(rows[0].live, 'live render @ t=0 matches resolver').toBeCloseTo(rows[0].resolved!, 1);
    expect(rows[1].live, 'live render @ t=1 matches resolver').toBeCloseTo(rows[1].resolved!, 1);
    expect(rows[2].live, 'live render @ t=2 matches resolver').toBeCloseTo(rows[2].resolved!, 1);
    expect(rows[2].live, 'live render moved across time').not.toBeCloseTo(rows[0].live ?? 0, 1);
  });
});
