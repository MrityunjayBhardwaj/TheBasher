// p269 — per-channel EXTEND / extrapolation conditions (V88 D1).
//
// A free-floating position channel on n_box (keys [0,0,0]@t0 → [2,0,0]@t2) is
// sampled OUTSIDE its authored domain [0,2]. The per-side extend rule decides
// what happens past the last key:
//   - hold (default)  → clamps to [2,0,0]           (the pre-#269 behaviour)
//   - cycle           → teleports back to [0,0,0]    (repeat, seam jump)
//   - cycle-offset     → travels to [4,0,0]          (seamless loop that moves)
//
// THE observation is a boundary-pair at t=4 (well past the range):
//   Side A — the REAL rendered three.js world position (__basher_mesh_world_position).
//   Side B — resolveEvaluatedTransform(...).position at the same ctx.time
//            (__basher_evaluated_transform → the gizmo/inspector read path).
// A === B proves the extend rule lives in the ONE sample function both callers
// share (H40, one band two callers). The FALSIFICATION: with the default 'hold'
// rule the same t=4 clamps — so the travel is caused by the rule, nothing else.
//
// REF: issue #269; vyapti V88 D1; GROUND_TRUTH_HOUDINI_OPERATORS.md §3 D1;
//      src/nodes/keyframeInterp.ts (planExtend + sample*KeyframesExtended);
//      KeyframeChannelVec3/Vec2/Number (the extendBefore/After params).

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      dispatchAtomic: (ops: unknown[], source?: string, description?: string) => unknown;
    };
  };
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
  __basher_mesh_world_position?: (nodeId: string) => [number, number, number] | null;
  __basher_evaluated_transform?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { position: [number, number, number] } | null;
}

const ctxAt = (seconds: number) => ({
  time: { frame: Math.round(seconds * 60), seconds, normalized: 0 },
});

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
async function resolvedX(page: import('@playwright/test').Page, seconds: number) {
  return page.evaluate((c) => {
    const t = (window as unknown as BasherWindow).__basher_evaluated_transform!('n_box', c);
    return t ? t.position[0] : null;
  }, ctxAt(seconds));
}
async function setExtendAfter(page: import('@playwright/test').Page, rule: string) {
  await page.evaluate((r) => {
    (window as unknown as BasherWindow)
      .__basher_dag!.getState()
      .dispatchAtomic(
        [{ type: 'setParam', nodeId: 'p269_ch', paramPath: 'extendAfter', value: r }],
        'user',
        'p269-set-extend',
      );
  }, rule);
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
      w.__basher_mesh_world_position &&
      w.__basher_evaluated_transform,
    );
  });
  await page.waitForFunction(
    () => (window as unknown as BasherWindow).__basher_mesh_world_position!('n_box') !== null,
  );
  // Position channel on n_box: [0,0,0]@t0 → [2,0,0]@t2. Domain [0,2].
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_dag!.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'p269_ch',
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
      'p269-seed',
    );
  });
});

test.describe('#269 — per-channel extend / extrapolation', () => {
  test('cycle-offset makes the rendered position TRAVEL past the range; render == read (H40)', async ({
    page,
  }) => {
    await setExtendAfter(page, 'cycle-offset');

    // In-range (t=1) is unchanged: linear lerp → x=1.
    await setTime(page, 1);
    await page.waitForFunction(() => {
      const p = (window as unknown as BasherWindow).__basher_mesh_world_position!('n_box');
      return p !== null && Math.abs(p[0] - 1) < 1e-2;
    });
    expect(await renderedX(page)).toBeCloseTo(1, 2);
    expect(await resolvedX(page, 1)).toBeCloseTo(1, 2);

    // Past the range (t=4): cycle-offset accumulates the endpoint delta each
    // period → x = 4 (two spans of +2). The box keeps moving, not clamped.
    await setTime(page, 4);
    await page.waitForFunction(() => {
      const p = (window as unknown as BasherWindow).__basher_mesh_world_position!('n_box');
      return p !== null && Math.abs(p[0] - 4) < 1e-2;
    });
    const rA = await renderedX(page); // Side A: real rendered object
    const rB = await resolvedX(page, 4); // Side B: resolver (gizmo/inspector read)
    expect(rA, 'rendered@t=4').toBeCloseTo(4, 2);
    expect(rB, 'resolver@t=4').toBeCloseTo(4, 2);
    expect(rA!, 'render == read (H40)').toBeCloseTo(rB!, 3);
  });

  test('the rule alone drives it: hold clamps, cycle teleports, cycle-offset travels', async ({
    page,
  }) => {
    // FALSIFY: default 'hold' → the SAME t=4 clamps to the last key (x=2).
    await setTime(page, 4);
    await page.waitForFunction(() => {
      const p = (window as unknown as BasherWindow).__basher_mesh_world_position!('n_box');
      return p !== null && Math.abs(p[0] - 2) < 1e-2;
    });
    expect(await renderedX(page), 'hold clamps').toBeCloseTo(2, 2);

    // cycle → repeat: t=4 maps to t=0 → x=0 (the teleport).
    await setExtendAfter(page, 'cycle');
    await page.waitForFunction(() => {
      const p = (window as unknown as BasherWindow).__basher_mesh_world_position!('n_box');
      return p !== null && Math.abs(p[0] - 0) < 1e-2;
    });
    expect(await renderedX(page), 'cycle teleports').toBeCloseTo(0, 2);

    // cycle-offset → travel: t=4 → x=4 (seamless).
    await setExtendAfter(page, 'cycle-offset');
    await page.waitForFunction(() => {
      const p = (window as unknown as BasherWindow).__basher_mesh_world_position!('n_box');
      return p !== null && Math.abs(p[0] - 4) < 1e-2;
    });
    expect(await renderedX(page), 'cycle-offset travels').toBeCloseTo(4, 2);
  });
});
