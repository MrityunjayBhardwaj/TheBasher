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
  __basher_autokey?: {
    getState: () => { enabled: boolean; toggle: () => void; set?: (v: boolean) => void };
  };
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
  __basher_transient?: {
    getState: () => {
      get: (n: string, p: string) => { value: unknown } | undefined;
      has: (n: string, p: string) => boolean;
      clearAll: () => void;
    };
  };
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
      const layer = children.find((c) => (c as { kind?: string }).kind === 'AnimationLayer') as
        | { sampleTarget?: (sec: number) => { position?: [number, number, number] } | null }
        | undefined;
      return layer?.sampleTarget?.(s)?.position ?? null;
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

/** Seed an animated cube via DIRECT DAG dispatch ops (the
 *  `tests/e2e/p3-observe.spec.ts:48-110` precedent): addNode
 *  AnimationLayer, rewire Scene.children box→layer, connect
 *  box→layer.target, addNode KeyframeChannelVec3 with EXPLICIT keyframes
 *  [0,0,0]@0 and [4,0,0]@2, connect TimeSource→channel.time and
 *  channel→layer.animation. Result: n_box wrapped in an AnimationLayer
 *  with a position channel [0,0,0]@0 and [4,0,0]@2 — IDENTICAL observable
 *  end-state to the prior diamond+inspector seam, but with ZERO dependence
 *  on the pre-D-05 inspector silent-dead-write (which D-05 / #77
 *  intentionally converted to an alert+no-op — the prior seam keyed the
 *  authored value after an inspector edit; that authored mutation no longer
 *  reaches the source, so the diamond would have re-keyed [0,0,0]@2 and the
 *  cube would never move). Restaged correctly; every downstream assertion
 *  (the moving cube, kfCount, keyframe values) is unchanged. */
async function seedAnimatedCube(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_selection && w.__basher_dag && w.__basher_evaluate);
  });
  const ids = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dagApi = w.__basher_dag!.getState() as unknown as {
      dispatch: (op: unknown) => void;
      state: { nodes: Record<string, { type: string }> };
    };
    const dispatch = (op: unknown) => dagApi.dispatch(op);
    const nodes = () => w.__basher_dag!.getState().state.nodes;
    const findType = (t: string) => Object.entries(nodes()).find(([, n]) => n.type === t)?.[0];

    const boxId = 'n_box';
    const sceneId = findType('Scene');
    if (!sceneId) throw new Error('seedAnimatedCube: no Scene node');
    if (!Object.values(nodes()).some((n) => n.type === 'TimeSource')) {
      dispatch({ type: 'addNode', nodeId: 'seed_time', nodeType: 'TimeSource', params: {} });
    }
    const timeId = findType('TimeSource');
    if (!timeId) throw new Error('seedAnimatedCube: no TimeSource after dispatch');

    dispatch({
      type: 'addNode',
      nodeId: 'seed_layer',
      nodeType: 'AnimationLayer',
      params: { name: 'SeedLayer', mute: false, solo: false, weight: 1, boneMask: [] },
    });
    dispatch({
      type: 'disconnect',
      from: { node: boxId, socket: 'out' },
      to: { node: sceneId, socket: 'children' },
    });
    dispatch({
      type: 'connect',
      from: { node: 'seed_layer', socket: 'out' },
      to: { node: sceneId, socket: 'children' },
    });
    dispatch({
      type: 'connect',
      from: { node: boxId, socket: 'out' },
      to: { node: 'seed_layer', socket: 'target' },
    });
    dispatch({
      type: 'addNode',
      nodeId: 'seed_pos_ch',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'seed_pos',
        target: boxId,
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 2, value: [4, 0, 0], easing: 'linear' },
        ],
      },
    });
    // P7.12 D-04: channel has no `time` socket — connect removed.
    dispatch({
      type: 'connect',
      from: { node: 'seed_pos_ch', socket: 'out' },
      to: { node: 'seed_layer', socket: 'animation' },
    });
    const n = nodes();
    return {
      layerId: Object.entries(n).find(([, x]) => x.type === 'AnimationLayer')?.[0],
      chId: Object.entries(n).find(([, x]) => x.type.startsWith('KeyframeChannel'))?.[0],
    };
  });

  // Select n_box + open the Transform section (downstream tests read its
  // diamond / vec testids). The selection drives the inspector render.
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_selection!.getState().select('n_box');
  });
  await expect(page.getByTestId('inspector')).toBeVisible();
  await page.getByTestId('inspector-section-toggle-transform').click();
  await expect(page.getByTestId('inspector-section-body-transform')).toBeVisible();

  // Observe the cube genuinely animates BEFORE returning (the seed is
  // bug-independent: eval position moves from [0,0,0] at t=0 toward
  // [4,0,0] at t=2 via the channel — no inspector dead-write involved).
  const moves = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const root = w.__basher_dag!.getState().state.outputs.render;
    if (!root) return null;
    const at = (s: number) => {
      const out = w.__basher_evaluate!(root.node, {
        time: { frame: Math.round(s * 60), seconds: s, normalized: 0 },
      }).value as { scene?: { children: Array<Record<string, unknown>> } };
      const children = (out.scene as { children: Array<Record<string, unknown>> }).children;
      const layer = children.find((c) => (c as { kind?: string }).kind === 'AnimationLayer') as
        | { sampleTarget?: (sec: number) => { position?: [number, number, number] } | null }
        | undefined;
      return layer?.sampleTarget?.(s)?.position ?? null;
    };
    return { t0: at(0), t1: at(1) };
  });
  expect(moves?.t0?.[0]).toBeCloseTo(0, 4);
  expect(moves?.t1?.[0]).toBeGreaterThan(0);

  return ids;
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
  await page.getByTestId('floating-toolbar-timeline').click();
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
        await expect.poll(async () => V(await gizmoProxyPosition(page))).toBe(V(evalPos));

        const proxyPos = await gizmoProxyPosition(page);
        console.log(
          `[P7.3 D-06] select=${sel} t=${t} ` + `eval=${V(evalPos)} proxy=${V(proxyPos)}`,
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
      const ch =
        nodes[Object.keys(nodes).find((k) => nodes[k].type.startsWith('KeyframeChannel'))!];
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
      const ch =
        nodes[Object.keys(nodes).find((k) => nodes[k].type.startsWith('KeyframeChannel'))!];
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

  test('grab → Auto-Key OFF holds a transient: ZERO ops, NO alert (FLAG-A superseded #149)', async ({
    page,
  }) => {
    await seedAnimatedCube(page);
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_transient!.getState().clearAll();
      w.__basher_time!.getState().pause();
      w.__basher_time!.getState().setTime(1);
      w.__basher_selection!.getState().select('n_box');
      const ak = w.__basher_autokey!.getState();
      if (ak.enabled) ak.toggle(); // Auto-Key OFF
    });
    // Spy window.alert — issue #149 SUPERSEDES the OFF reject alert with a held
    // transient. The alert must NOT fire (it would mean the edit is rejected,
    // not held). The transient + the render overlay are the replacement.
    await page.evaluate(() => {
      const ww = window as unknown as { __alertMsgs: string[]; alert: (m?: string) => void };
      ww.__alertMsgs = [];
      ww.alert = (m?: string) => {
        ww.__alertMsgs.push(String(m ?? ''));
      };
    });
    const dagBefore = await page.evaluate(() =>
      JSON.stringify((window as unknown as BasherWindow).__basher_dag!.getState().state.nodes),
    );

    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_gizmo_grab!('translate', [9, 0, 0]);
    });

    const { dagAfter, alerts, transient } = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      const ww = window as unknown as { __alertMsgs: string[] };
      return {
        dagAfter: JSON.stringify(w.__basher_dag!.getState().state.nodes),
        alerts: ww.__alertMsgs,
        transient: w.__basher_transient!.getState().get('n_box', 'position')?.value ?? null,
      };
    });
    console.log(
      `[P7.3 grab-OFF] alerts=${JSON.stringify(alerts)} transient=${JSON.stringify(transient)} dagChanged=${dagAfter !== dagBefore}`,
    );

    // ZERO ops — the DAG is byte-unchanged (the edit is held, not committed; H36).
    expect(dagAfter).toBe(dagBefore);
    // NO alert — the reject is superseded by the transient hold (#149). An alert
    // here would mean the edit was rejected (the old FLAG-A behavior).
    expect(alerts.length).toBe(0);
    // The edit is HELD as a transient (the orange dirty state's backing store).
    expect(transient).toEqual([9, 0, 0]);
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
          ) as
            | { sampleTarget?: (sec: number) => { position?: [number, number, number] } | null }
            | undefined;
          const evalPos = layer?.sampleTarget?.(sec)?.position ?? null;
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
      JSON.stringify((window as unknown as BasherWindow).__basher_dag!.getState().state.nodes),
    );
    // A grab attempt WHILE PLAYING produces ZERO ops (D-03 paused gate).
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_gizmo_grab!('translate', [9, 0, 0]);
    });
    const dagAfterPlay = await page.evaluate(() =>
      JSON.stringify((window as unknown as BasherWindow).__basher_dag!.getState().state.nodes),
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
      JSON.stringify((window as unknown as BasherWindow).__basher_dag!.getState().state.nodes),
    );
    expect(dagAfterPause).not.toBe(dagBefore); // paused grab keyed
  });
});
