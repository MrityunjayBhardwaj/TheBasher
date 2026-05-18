// P7.3 — gizmo tracks the EVALUATED transform (issue #68).
//
// THE PHASE OBSERVATION GATE (D-06, non-deferrable). #68 shipped because
// P7's E2 asserted the EVALUATOR output and never the GIZMO proxy — only
// one side of the boundary was observed. This spec observes BOTH sides:
//   (a) the evaluated render-walk transform (render → scene.children[i] →
//       AnimationLayer → .target.position — OUR side, already trusted), and
//   (b) the GIZMO PROXY transform (the FLAG-C dev mirror — the side never
//       observed, the #68 gap).
// ASSERT (a) === (b) at ≥2 distinct playhead times for box-select AND
// layer-select. Plus grab→Auto-Key (ON keys / OFF rejects zero ops) and
// paused-vs-playing interactivity (D-02/D-03).
//
// Observation over inference: every assertion reads the ACTUAL evaluated
// + proxy values, never "the effect should have run".

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: {
        nodes: Record<string, { type: string; params: Record<string, unknown> }>;
        outputs: { render?: { node: string; socket: string } };
      };
    };
  };
  __basher_time?: {
    getState: () => {
      setTime: (s: number) => void;
      seconds: number;
      play: () => void;
      pause: () => void;
      playing: boolean;
    };
  };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_autokey?: { getState: () => { enabled: boolean; toggle: () => void; set?: (v: boolean) => void } };
  __basher_evaluate?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { value: unknown; hash: string };
  __basher_gizmo?: () => {
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
  } | null;
  __basher_gizmo_grab?: (
    mode: 'translate' | 'rotate' | 'scale',
    target: [number, number, number],
  ) => void;
}

const V = (a: number[] | null) => JSON.stringify(a);

/** The evaluated render-walk position for the wrapped cube (OUR side —
 *  the same render → scene.children → AnimationLayer → .target walk P7's
 *  E2 used). Returns the layer's patched-clone position. */
async function evalWalkPosition(
  page: import('@playwright/test').Page,
  seconds: number,
): Promise<[number, number, number] | null> {
  return page.evaluate(
    ({ s }) => {
      const w = window as unknown as BasherWindow;
      const root = w.__basher_dag!.getState().state.outputs.render;
      if (!root) throw new Error('no outputs.render');
      const out = w.__basher_evaluate!(root.node, {
        time: { frame: Math.round(s * 60), seconds: s, normalized: 0 },
      }).value as { scene?: { children: Array<Record<string, unknown>> } };
      const scene = out.scene ?? (out as unknown as { children?: unknown[] });
      const children = (scene as { children: Array<Record<string, unknown>> }).children;
      const layer = children.find(
        (c) => (c as { kind?: string }).kind === 'AnimationLayer',
      ) as { target?: { position?: [number, number, number] } } | undefined;
      return layer?.target?.position ?? null;
    },
    { s: seconds },
  );
}

async function gizmoProxyPosition(
  page: import('@playwright/test').Page,
): Promise<[number, number, number] | null> {
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const g = w.__basher_gizmo?.();
    return g ? g.position : null;
  });
}

/** Seed an animated cube via the REAL Wave-C diamond → Wave-A composite
 *  seam (NOT a synthetic dispatch): select n_box, click the POSITION
 *  diamond at t=0 (first-key composite = addLayer + addChannel + keyframe;
 *  the composite rewires Scene.children to the layer), scrub to t=2, edit
 *  position via the inspector vec input, click the diamond again → second
 *  key. Result: n_box wrapped in an AnimationLayer with a position channel
 *  [0,0,0]@0 and [4,0,0]@2. */
async function seedAnimatedCube(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_selection && w.__basher_dag);
  });
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_selection!.getState().select('n_box');
  });
  await expect(page.getByTestId('inspector')).toBeVisible();
  await page.getByTestId('inspector-section-toggle-transform').click();
  await expect(page.getByTestId('inspector-section-body-transform')).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_time!.getState().setTime(0);
  });
  const posDiamond = page.getByTestId('inspector-diamond-n_box-position');
  await expect(posDiamond).toBeVisible();
  await expect(posDiamond).toHaveAttribute('data-anim-state', 'none');
  await posDiamond.click();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const w = window as unknown as BasherWindow;
        return Object.values(w.__basher_dag!.getState().state.nodes).filter((n) =>
          n.type.startsWith('KeyframeChannel'),
        ).length;
      }),
    )
    .toBe(1);

  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_time!.getState().setTime(2);
  });
  const posX = page.getByTestId('inspector-vec-n_box-position-x');
  await expect(posX).toBeVisible();
  await posX.fill('4');
  await posX.press('Tab');
  await expect(posDiamond).toHaveAttribute('data-anim-state', 'animated');
  await posDiamond.click();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const w = window as unknown as BasherWindow;
        const ch = Object.values(w.__basher_dag!.getState().state.nodes).find((n) =>
          n.type.startsWith('KeyframeChannel'),
        );
        return ((ch?.params.keyframes ?? []) as unknown[]).length;
      }),
    )
    .toBe(2);
  // Resolve the layer + channel ids for later select-by-layer / op asserts.
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag!.getState().state.nodes;
    const layerId = Object.entries(nodes).find(([, n]) => n.type === 'AnimationLayer')?.[0];
    const chId = Object.entries(nodes).find(([, n]) =>
      n.type.startsWith('KeyframeChannel'),
    )?.[0];
    return { layerId, chId };
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
    return Boolean(w.__basher_dag);
  });
  await page.getByTestId('mode-switcher').selectOption('animate');
});

test.describe('P7.3 D-06 — gizmo proxy == evaluated render-walk (the #68 boundary-pair)', () => {
  test('boundary-pair: proxy position == evaluated walk at ≥2 playhead times, box AND layer select', async ({
    page,
  }) => {
    const { layerId } = await seedAnimatedCube(page);
    expect(layerId).toBeTruthy();

    // Pause so the gizmo is in its steady display-follow state.
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_time!.getState().pause();
    });

    for (const sel of ['n_box', layerId!]) {
      await page.evaluate((id) => {
        (window as unknown as BasherWindow).__basher_selection!.getState().select(id);
      }, sel);

      for (const t of [0.5, 1.5]) {
        await page.evaluate((s) => {
          (window as unknown as BasherWindow).__basher_time!.getState().setTime(s);
        }, t);

        // Poll the proxy until it matches the evaluated walk (the FLAG-C
        // tail write guarantees a committed value; poll absorbs the React
        // effect settle without an arbitrary sleep).
        const evalPos = await evalWalkPosition(page, t);
        await expect
          .poll(async () => V(await gizmoProxyPosition(page)))
          .toBe(V(evalPos));

        const proxyPos = await gizmoProxyPosition(page);
        console.log(
          `[P7.3 D-06] select=${sel} t=${t} ` +
            `eval=${V(evalPos)} proxy=${V(proxyPos)}`,
        );
        // The assertion whose absence let #68 ship: BOTH sides equal.
        expect(proxyPos![0]).toBeCloseTo(evalPos![0], 4);
        expect(proxyPos![1]).toBeCloseTo(evalPos![1], 4);
        expect(proxyPos![2]).toBeCloseTo(evalPos![2], 4);
        // And the eval position actually MOVES (not frozen at authored).
        expect(evalPos![0]).toBeGreaterThan(0);
      }
    }
  });

  test('grab → Auto-Key ON inserts a keyframe at the playhead; ZERO setParam on the source (H36)', async ({
    page,
  }) => {
    const { chId } = await seedAnimatedCube(page);
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_time!.getState().pause();
      w.__basher_time!.getState().setTime(1);
      w.__basher_selection!.getState().select('n_box');
    });
    // Auto-Key ON.
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      const ak = w.__basher_autokey!.getState();
      if (!ak.enabled) ak.toggle();
    });
    const before = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      const nodes = w.__basher_dag!.getState().state.nodes;
      const ch = nodes[
        Object.keys(nodes).find((k) => nodes[k].type.startsWith('KeyframeChannel'))!
      ];
      return {
        kfCount: ((ch.params.keyframes ?? []) as unknown[]).length,
        boxPos: (nodes.n_box.params as { position: number[] }).position,
      };
    });

    // The REAL gizmo grab path (routeAnimatedGrab → autoKeyCommit seam).
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_gizmo_grab!('translate', [9, 0, 0]);
    });

    const after = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      const nodes = w.__basher_dag!.getState().state.nodes;
      const ch = nodes[
        Object.keys(nodes).find((k) => nodes[k].type.startsWith('KeyframeChannel'))!
      ];
      const kfs = (ch.params.keyframes ?? []) as { time: number; value: number[] }[];
      return {
        kfCount: kfs.length,
        atSecond1: kfs.find((k) => Math.abs(k.time - 1) < 0.01)?.value ?? null,
        boxPos: (nodes.n_box.params as { position: number[] }).position,
      };
    });
    console.log(
      `[P7.3 grab-ON] kf ${before.kfCount}→${after.kfCount} ` +
        `@1s=${V(after.atSecond1)} boxPos ${V(before.boxPos)}→${V(after.boxPos)}`,
    );

    // A keyframe landed at the playhead (t=1s) with the grabbed value.
    expect(after.atSecond1).not.toBeNull();
    expect(after.atSecond1![0]).toBeCloseTo(9, 3);
    // chId resolved (sanity) and the channel is the one that moved.
    expect(chId).toBeTruthy();
    // H36 double-write guard: the SOURCE box.params.position is UNCHANGED
    // (the grab routed to the seam INSTEAD of a raw setParam — never both).
    expect(after.boxPos).toEqual(before.boxPos);
  });

  test('grab → Auto-Key OFF rejects: ZERO ops, reason surfaced (NET-NEW, FLAG-A)', async ({
    page,
  }) => {
    await seedAnimatedCube(page);
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_time!.getState().pause();
      w.__basher_time!.getState().setTime(1);
      w.__basher_selection!.getState().select('n_box');
      const ak = w.__basher_autokey!.getState();
      if (ak.enabled) ak.toggle(); // Auto-Key OFF
    });
    // Spy window.alert (the NET-NEW OFF reject — NPanel is silent on OFF).
    await page.evaluate(() => {
      const ww = window as unknown as { __alertMsgs: string[]; alert: (m?: string) => void };
      ww.__alertMsgs = [];
      ww.alert = (m?: string) => {
        ww.__alertMsgs.push(String(m ?? ''));
      };
    });
    const dagBefore = await page.evaluate(() =>
      JSON.stringify(
        (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes,
      ),
    );

    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_gizmo_grab!('translate', [9, 0, 0]);
    });

    const { dagAfter, alerts } = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      const ww = window as unknown as { __alertMsgs: string[] };
      return {
        dagAfter: JSON.stringify(w.__basher_dag!.getState().state.nodes),
        alerts: ww.__alertMsgs,
      };
    });
    console.log(`[P7.3 grab-OFF] alerts=${JSON.stringify(alerts)} dagChanged=${dagAfter !== dagBefore}`);

    // ZERO ops — the DAG is byte-unchanged.
    expect(dagAfter).toBe(dagBefore);
    // The reject reason surfaced (the NET-NEW behavior — its absence, e.g.
    // if the alert were wrongly deleted as "redundant", fails here loudly).
    expect(alerts.length).toBe(1);
    expect(alerts[0].toLowerCase()).toMatch(/animated|auto-key/);
  });

  test('paused vs playing (D-03): display-follows while playing, grab is a no-op while playing', async ({
    page,
  }) => {
    await seedAnimatedCube(page);
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_selection!.getState().select('n_box');
      const ak = w.__basher_autokey!.getState();
      if (!ak.enabled) ak.toggle(); // ON — so a working grab WOULD key
    });

    // While playing: the proxy DISPLAY-FOLLOWS the eval. Playback keeps
    // advancing time (the rAF Clock), so we must NOT assert against a
    // frozen seconds — the proxy correctly tracks the LIVE time. Read the
    // store's current seconds and the proxy AT THE SAME INSTANT and assert
    // the proxy == the evaluated walk at that live time (the D-03
    // display-follow contract: the gizmo sits where the cube renders,
    // whatever the current playhead is).
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_time!.getState().play();
      w.__basher_time!.getState().setTime(1.5);
    });
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const w = window as unknown as BasherWindow;
          const sec = w.__basher_time!.getState().seconds;
          const root = w.__basher_dag!.getState().state.outputs.render!;
          const out = w.__basher_evaluate!(root.node, {
            time: { frame: Math.round(sec * 60), seconds: sec, normalized: 0 },
          }).value as { scene: { children: Array<Record<string, unknown>> } };
          const layer = out.scene.children.find(
            (c) => (c as { kind?: string }).kind === 'AnimationLayer',
          ) as { target?: { position?: [number, number, number] } } | undefined;
          const evalPos = layer?.target?.position ?? null;
          const proxy = w.__basher_gizmo?.()?.position ?? null;
          if (!evalPos || !proxy) return 'null';
          // Display-follow: proxy tracks eval at the live time. Compare
          // rounded so an in-flight rAF tick between the two reads (proxy
          // committed slightly before/after the eval read) is tolerated —
          // the contract is "tracks", not "frame-locked to a stale t".
          const r = (v: number) => Math.round(v * 100) / 100;
          return (
            r(proxy[0]) === r(evalPos[0]) &&
            r(proxy[1]) === r(evalPos[1]) &&
            r(proxy[2]) === r(evalPos[2])
          );
        }),
      )
      .toBe(true);

    const dagBefore = await page.evaluate(() =>
      JSON.stringify(
        (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes,
      ),
    );
    // A grab attempt WHILE PLAYING produces ZERO ops (D-03 paused gate).
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_gizmo_grab!('translate', [9, 0, 0]);
    });
    const dagAfterPlay = await page.evaluate(() =>
      JSON.stringify(
        (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes,
      ),
    );
    console.log(`[P7.3 D-03] playing grab dagChanged=${dagAfterPlay !== dagBefore}`);
    expect(dagAfterPlay).toBe(dagBefore); // no-op while playing

    // While paused the same grab DOES key (proves it was the gate, not a
    // broken grab).
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_time!.getState().pause();
      w.__basher_time!.getState().setTime(1);
    });
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_gizmo_grab!('translate', [9, 0, 0]);
    });
    const dagAfterPause = await page.evaluate(() =>
      JSON.stringify(
        (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes,
      ),
    );
    expect(dagAfterPause).not.toBe(dagBefore); // paused grab keyed
  });
});
