// #212 / item 2 (seam B) — animating the SCENE ENVIRONMENT end-to-end.
//
// The Scene inspector's Environment controls (envIntensity / envRotationY) gained
// keyframe diamonds (the shared useAnimatableField spine). But <SceneEnvironment>
// renders the STATIC evaluated env (SceneFromDAG evaluates at frozen ctx.time=0),
// so a diamond alone would resolve-but-not-render — the H40 gap seam A closed for
// lights. Seam B (SceneEnvChannelsR) re-applies the env channels onto the live
// scene each frame. This OBSERVES that boundary-pair on the live app:
//   1. select the Scene node, bind a file HDRI (env mounts, drei sets the base)
//   2. key envIntensity at t=0 via the inspector diamond
//   3. Auto-Key ON → scrub to t=2 → set intensity to 4 (second key)
//   4. assert resolver AND live scene.environmentIntensity both track 1 → 4
//
// REF: src/app/SceneEnvironmentControls.tsx (diamonds), src/viewport/SceneFromDAG
//      (SceneEnvChannelsR — seam B), useAnimatableField, V57, H40.

import { expect, test } from './_fixtures';

interface EnvWindow {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<string, { type: string; params?: Record<string, unknown> }>;
      };
    };
  };
  __basher_three: {
    getState: () => {
      scene: { environment: unknown | null; environmentIntensity?: number } | null;
    };
  };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
  __basher_autokey?: { getState: () => { toggle: () => void } };
  __basher_evaluated_param?: (
    nodeId: string,
    paramPath: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { value: unknown } | null;
}

const ctxAt = (seconds: number) => ({
  time: { frame: Math.round(seconds * 60), seconds, normalized: 0 },
});
type Page = import('@playwright/test').Page;

async function setTime(page: Page, seconds: number) {
  await page.evaluate((s) => {
    (window as unknown as EnvWindow).__basher_time!.getState().setTime(s);
  }, seconds);
}

async function resolved(page: Page, sceneId: string, seconds: number): Promise<number | null> {
  return page.evaluate(
    ({ sceneId, c }) => {
      const r = (window as unknown as EnvWindow).__basher_evaluated_param!(
        sceneId,
        'envIntensity',
        c,
      );
      return r && typeof r.value === 'number' ? r.value : null;
    },
    { sceneId, c: ctxAt(seconds) },
  );
}

async function liveIntensity(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const i = (window as unknown as EnvWindow).__basher_three.getState().scene
      ?.environmentIntensity;
    return typeof i === 'number' ? i : null;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) {
    await starter.click();
  }
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as EnvWindow;
    return Boolean(
      w.__basher_dag &&
      w.__basher_three &&
      w.__basher_selection &&
      w.__basher_time &&
      w.__basher_autokey &&
      w.__basher_evaluated_param &&
      w.__basher_dag.getState().state.outputs.scene,
    );
  });
});

test.describe('#212 seam B — scene environment animates end-to-end', () => {
  test('keyframe envIntensity → resolver AND live scene.environmentIntensity track 1 → 4', async ({
    page,
  }) => {
    // select the Scene node → its Environment section renders
    const sceneId = await page.evaluate(() => {
      const w = window as unknown as EnvWindow;
      const id = w.__basher_dag.getState().state.outputs.scene!.node;
      w.__basher_selection!.getState().select(id);
      return id;
    });
    await expect(page.getByTestId(`inspector-environment-${sceneId}`)).toBeVisible({
      timeout: 10_000,
    });

    // bind a file HDRI so the env mounts (drei sets the base environmentIntensity)
    await page
      .getByTestId(`inspector-env-file-${sceneId}`)
      .setInputFiles('public/fixtures/env/test.hdr');
    await page.waitForFunction(
      () => Boolean((window as unknown as EnvWindow).__basher_three.getState().scene?.environment),
      null,
      { timeout: 15_000 },
    );

    // key envIntensity (base = 1) at t=0 via the inspector diamond
    await setTime(page, 0);
    const diamond = page.getByTestId(`inspector-diamond-${sceneId}-envIntensity`);
    await expect(diamond).toBeVisible();
    await expect(diamond).toHaveAttribute('data-anim-state', 'none');
    await diamond.click();
    await expect(diamond).toHaveAttribute('data-anim-state', 'on-key');

    // Auto-Key ON, scrub to t=2, set intensity 4 → second key
    await page.evaluate(() => {
      (window as unknown as EnvWindow).__basher_autokey!.getState().toggle();
    });
    await expect(page.getByTestId('timebar')).toHaveAttribute('data-autokey', 'on');
    await setTime(page, 2);
    const input = page.getByTestId(`inspector-env-intensity-${sceneId}`);
    await input.fill('4');
    await input.press('Tab');

    const keys = await page.evaluate((id) => {
      const nodes = (window as unknown as EnvWindow).__basher_dag.getState().state.nodes;
      const c = Object.values(nodes).find(
        (n) =>
          n.type.startsWith('KeyframeChannel') &&
          (n.params as { target?: string }).target === id &&
          (n.params as { paramPath?: string }).paramPath === 'envIntensity',
      );
      return c ? ((c.params as { keyframes?: unknown[] }).keyframes ?? []).length : 0;
    }, sceneId);
    expect(keys, 'envIntensity channel has 2 keys').toBe(2);

    // OBSERVE resolver AND live render (scene.environmentIntensity) across time
    const rows: { t: number; resolved: number | null; live: number | null }[] = [];
    for (const t of [0, 2]) {
      await setTime(page, t);
      await page.waitForTimeout(120); // let the seam-B useFrame apply
      rows.push({ t, resolved: await resolved(page, sceneId, t), live: await liveIntensity(page) });
    }
    console.log(
      `\n[p212 ENV] environmentIntensity by time:` +
        rows.map((r) => `\n  t=${r.t}  resolver=${r.resolved}  live=${r.live}`).join('') +
        `\n`,
    );

    expect(rows[0].resolved).toBeCloseTo(1, 1);
    expect(rows[1].resolved).toBeCloseTo(4, 1);
    // render == resolver (seam B re-applies the channel onto the live scene)
    expect(rows[0].live).toBeCloseTo(rows[0].resolved!, 1);
    expect(rows[1].live).toBeCloseTo(rows[1].resolved!, 1);
    expect(rows[1].live).not.toBeCloseTo(rows[0].live ?? 0, 1);
  });
});
