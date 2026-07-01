// DEEP CUBE ANIMATION — a headed, end-to-end observation of authoring AND
// rendering a keyframed primitive through the REAL director affordances.
//
// This is the Lokayata gate for "can a director animate a cube": no synthetic
// setParam, no hand-wired dispatch. We drive the SAME UI a user drives:
//   1. select the box → expand Transform
//   2. click the position / rotation / scale keyframe DIAMONDS at t=0 (seeds the
//      free-floating direct channels, #199/V57 — no AnimationLayer wrapper)
//   3. Auto-Key ON → scrub to t=2 → edit the inspector vec inputs (the #77
//      autoKeyCommit chokepoint appends a second key on the SAME channel)
//
// Then we OBSERVE the motion at 5 playhead times via the boundary-pair seams:
//   Side A — the REAL rendered three.js object's WORLD transform
//            (__basher_mesh_world_position / __basher_mesh_world_scale).
//   Side B — resolveEvaluatedTransform at the SAME ctx.time
//            (__basher_evaluated_transform — the read-side overlay the inspector
//            + gizmo consume, #197).
// Assert A === B (H40 — render == resolver) AND that the value MOVES across time
// (the resolver tracks the animation; a static read would be flat).
//
// vec3 channels default to cubic easing (smoothstep): smoothstep(0.5)=0.5, so at
// the midpoint t=1 of a t∈[0,2] ramp the value is exactly halfway.
//
// REF: p7 (authoring), p153 (H40 boundary-pair), V57 (direct-channel road),
//      H40 (render==resolver), H48 (snapshot time, never subscribe).

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
    };
  };
  __basher_time?: { getState: () => { setTime: (s: number) => void; seconds: number } };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_mesh_world_position?: (nodeId: string) => [number, number, number] | null;
  __basher_mesh_world_scale?: (nodeId: string) => [number, number, number] | null;
  __basher_evaluated_transform?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => {
    position?: [number, number, number];
    rotation?: [number, number, number];
    scale?: [number, number, number];
  } | null;
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

async function channelCount(page: Page) {
  return page.evaluate(() => {
    const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
    return Object.values(nodes).filter((n) => n.type.startsWith('KeyframeChannel')).length;
  });
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
      w.__basher_dag &&
      w.__basher_time &&
      w.__basher_selection &&
      w.__basher_evaluated_transform &&
      w.__basher_mesh_world_position &&
      w.__basher_mesh_world_scale,
    );
  });
  await page.waitForFunction(
    () => (window as unknown as BasherWindow).__basher_mesh_world_position!('n_box') !== null,
  );
});

test.describe('DEEP — animating a cube end-to-end through the real UI', () => {
  test('author position+rotation+scale via diamonds + Auto-Key; rendered == resolver and the motion tracks', async ({
    page,
  }) => {
    // ── 1. Select the box and reach the Transform inputs ──────────────────
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_selection!.getState().select('n_box');
    });
    await expect(page.getByTestId('inspector')).toBeVisible();
    await page.getByTestId('inspector-section-toggle-transform').click();
    await expect(page.getByTestId('inspector-section-body-transform')).toBeVisible();

    expect(await channelCount(page)).toBe(0);

    // ── 2. Seed the t=0 keys via the REAL keyframe diamonds ───────────────
    await setTime(page, 0);
    for (const param of ['position', 'rotation', 'scale']) {
      const diamond = page.getByTestId(`inspector-diamond-n_box-${param}`);
      await expect(diamond).toBeVisible();
      await expect(diamond).toHaveAttribute('data-anim-state', 'none');
      await diamond.click();
    }
    await expect.poll(() => channelCount(page)).toBe(3); // 3 free-floating channels

    // ── 3. Auto-Key ON, scrub to t=2, edit the vec inputs → second keys ───
    await page.getByTestId('autokey-toggle').click();
    await expect(page.getByTestId('timebar')).toHaveAttribute('data-autokey', 'on');
    await setTime(page, 2);

    const edit = async (param: string, axis: string, v: string) => {
      const input = page.getByTestId(`inspector-vec-n_box-${param}-${axis}`);
      await expect(input).toBeVisible();
      await input.fill(v);
      await input.press('Tab');
    };
    // Position → [4, 0, 0] ; Rotation → [0, 360, 0] ; Scale → [3, 3, 3].
    await edit('position', 'x', '4');
    await edit('rotation', 'y', '360');
    await edit('scale', 'x', '3');
    await edit('scale', 'y', '3');
    await edit('scale', 'z', '3');

    // Still exactly 3 channels — autoKeyCommit appended to the SAME channels.
    expect(await channelCount(page)).toBe(3);

    // ── 4. OBSERVE the motion: rendered (A) == resolver (B), and it moves ──
    const sample = async (seconds: number) => {
      await setTime(page, seconds);
      // Wait for the render commit to flow the animated transform onto the object.
      await page.waitForFunction(
        ({ s }) => {
          const w = window as unknown as BasherWindow;
          const r = w.__basher_mesh_world_position!('n_box');
          const e = w.__basher_evaluated_transform!('n_box', {
            time: { frame: Math.round(s * 60), seconds: s, normalized: 0 },
          });
          return r !== null && e?.position != null && Math.abs(r[0] - e.position[0]) < 1e-2;
        },
        { s: seconds },
      );
      const renderedPos = await page.evaluate(() =>
        (window as unknown as BasherWindow).__basher_mesh_world_position!('n_box'),
      );
      const renderedScale = await page.evaluate(() =>
        (window as unknown as BasherWindow).__basher_mesh_world_scale!('n_box'),
      );
      const resolved = await page.evaluate(
        (c) => (window as unknown as BasherWindow).__basher_evaluated_transform!('n_box', c),
        ctxAt(seconds),
      );
      return { renderedPos, renderedScale, resolved };
    };

    const t0 = await sample(0);
    const t1 = await sample(1);
    const t2 = await sample(2);

    // Verbatim observed numbers (the GOAL is met only if these advance).
    console.log(
      `\n[DEEP CUBE] pos.x  t0=${t0.renderedPos![0].toFixed(3)} t1=${t1.renderedPos![0].toFixed(3)} t2=${t2.renderedPos![0].toFixed(3)}` +
        `\n[DEEP CUBE] scale  t0=${t0.renderedScale![0].toFixed(3)} t1=${t1.renderedScale![0].toFixed(3)} t2=${t2.renderedScale![0].toFixed(3)}` +
        `\n[DEEP CUBE] rotY   t0=${t0.resolved!.rotation?.[1]} t1=${t1.resolved!.rotation?.[1]} t2=${t2.resolved!.rotation?.[1]}\n`,
    );

    // H40 — rendered WORLD == resolver, at every time, position + scale.
    for (const t of [t0, t1, t2]) {
      for (let i = 0; i < 3; i++) {
        expect(t.renderedPos![i]).toBeCloseTo(t.resolved!.position![i], 2);
        expect(t.renderedScale![i]).toBeCloseTo(t.resolved!.scale![i], 2);
      }
    }

    // Endpoints: the authored keys are reached exactly.
    expect(t0.renderedPos![0]).toBeCloseTo(0, 2);
    expect(t2.renderedPos![0]).toBeCloseTo(4, 2);
    expect(t0.renderedScale![0]).toBeCloseTo(1, 2);
    expect(t2.renderedScale![0]).toBeCloseTo(3, 2);

    // Midpoint: cubic smoothstep(0.5)=0.5 → exact halfway.
    expect(t1.renderedPos![0]).toBeCloseTo(2, 1);
    expect(t1.renderedScale![0]).toBeCloseTo(2, 1);
    expect(t1.resolved!.rotation![1]).toBeCloseTo(180, 1);

    // The DELTA: strictly advancing — a static read (the regression) would be flat.
    expect(t1.renderedPos![0]).toBeGreaterThan(t0.renderedPos![0]);
    expect(t2.renderedPos![0]).toBeGreaterThan(t1.renderedPos![0]);
    expect(t2.renderedScale![0]).toBeGreaterThan(t1.renderedScale![0]);
    expect(t2.resolved!.rotation![1]).toBeGreaterThan(t1.resolved!.rotation![1]);
  });
});
