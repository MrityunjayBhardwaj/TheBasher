// P7.4 — NPanel Transform field tracks the EVALUATED transform (issue #69).
//
// THE PHASE OBSERVATION GATE (D-06 in the 7.3 lineage; the boundary-pair
// gate for the inspector surface — the NET-NEW closing of the H40 sibling).
// #69 is the explicit sibling of #68 (gizmo, fixed in 7.3): same root cause
// (a UI surface bound to `node.params.X` while a wrapper patches the
// rendered CLONE), different surface. 7.3 closed the gizmo side. 7.4 closes
// the inspector side — by mirroring exactly the same two-sided observation
// pattern, swapping the consumer-side reader from `__basher_gizmo()` to the
// DOM `inputValue()` on the inspector field.
//
// The producer side (OUR side, already trusted) is the evaluated rendered
// transform. V57 direct channels (#199): the box is its own scene child and the
// channel's sampled value is overlaid by `resolveEvaluatedTransform` — there is
// no AnimationLayer wrapper, no patched clone to unwrap. The test reads the
// producer through the `__basher_evaluated_transform` seam (the renderer's own
// resolver), observed INDEPENDENTLY of the consumer-side DOM input.value it then
// asserts against — the two sides of the boundary-pair.
//
// The consumer side (THEIR side, the side never observed for the inspector
// class, the #69 gap) is the rendered DOM input.value: the `inspector-vec-*`
// testid the user actually sees. ASSERT (producer) == (consumer) at ≥2
// distinct playhead times for box-select AND layer-select (mirrors 7.3 D-06).
//
// Observation over inference: every assertion reads the ACTUAL evaluated
// value AND the ACTUAL DOM input.value, never "the effect should have run".
//
// Scrub-label parity finding (verified at src/app/Gizmo.tsx:301-324 — the
// `routeAnimatedGrab` function): the 7.3 gizmo gates the WRITE path (no-op
// when playing for animated params) while leaving the visual proxy alive.
// The inspector's scrub-label is analogous to the gizmo's manip handle —
// a drag affordance that writes through `autoKeyCommit`, the same shared
// chokepoint. The W2.1 executor deliberately left the scrub-label
// non-readOnly-gated; the input field IS gated because it's the display
// surface. This matches the gizmo's pattern (gate the WRITE, not the
// affordance). No additional scrub-label assertion is needed — the write
// path's `autoKeyCommit` chokepoint is the gate. Documented here for the
// future reader; the D-06 boundary-pair is the load-bearing observation.

import { test, expect } from './_fixtures';
import { openInspectorSection } from './_inspectorSections';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: {
        nodes: Record<string, { type: string; params: Record<string, unknown> }>;
        outputs: { render?: { node: string; socket: string }; scene?: { node: string } };
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
  // V57 direct channels (#199): the animation overlay lives in the
  // renderer/resolver, not the node's evaluate() value. Read the rendered
  // transform through the SAME resolveEvaluatedTransform the renderer consumes.
  __basher_evaluated_transform?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { position?: [number, number, number] | null } | null;
  __basher_transient?: {
    getState: () => {
      get: (n: string, p: string) => { value: unknown } | undefined;
      has: (n: string, p: string) => boolean;
      clearAll: () => void;
    };
  };
}

const V = (a: number[] | null) => JSON.stringify(a);

/** The evaluated rendered position for `selectedId` (OUR side — the producer).
 *  V57 direct channels (#199): the box is its own scene child; the channel's
 *  sampled position is overlaid by the renderer/resolver (resolveEvaluatedTransform),
 *  NOT the node's raw evaluate() value. There is no AnimationLayer wrapper to
 *  match-by-target or unwrap. Read it through the SAME resolveEvaluatedTransform
 *  the inspector consumes — but via the dedicated `__basher_evaluated_transform`
 *  seam (resolveEvaluatedTransform), which is the producer the renderer reads,
 *  observed INDEPENDENTLY of the consumer-side DOM input.value the test asserts
 *  against. The H40 detection question — "which side did I observe?" — is
 *  answered: BOTH, the producer (here) and the consumer (the DOM input). */
async function evalWalkPosition(
  page: import('@playwright/test').Page,
  seconds: number,
  selectedId: string,
): Promise<[number, number, number] | null> {
  return page.evaluate(
    ({ s, id }) => {
      const w = window as unknown as BasherWindow;
      return (
        w.__basher_evaluated_transform!(id, {
          time: { frame: Math.round(s * 60), seconds: s, normalized: 0 },
        })?.position ?? null
      );
    },
    { s: seconds, id: selectedId },
  );
}

/** Read the displayed (DOM input.value) Vec3 for n_box.position from the
 *  three axis testids (THEIR side — the consumer surface, the #69 gap).
 *  Uses `parseFloat` on each axis (the numeric round-trip the field
 *  performs in its onChange handler). */
async function inspectorDisplayedPosition(
  page: import('@playwright/test').Page,
  nodeId: string,
): Promise<[number, number, number]> {
  const x = await page.getByTestId(`inspector-vec-${nodeId}-position-x`).inputValue();
  const y = await page.getByTestId(`inspector-vec-${nodeId}-position-y`).inputValue();
  const z = await page.getByTestId(`inspector-vec-${nodeId}-position-z`).inputValue();
  return [parseFloat(x), parseFloat(y), parseFloat(z)];
}

/** Seed an animated cube via DIRECT DAG dispatch ops. V57 direct channels
 *  (#199): addNode a free-floating KeyframeChannelVec3 whose `target` is the
 *  box dagId, with EXPLICIT keyframes [0,0,0]@0 and [4,0,0]@2. NO
 *  AnimationLayer wraps the box, NO scene rewire — the box stays its own
 *  scene child; the renderer/resolver overlays the sampled position. Same
 *  observable end-state as the prior layer seam, with ZERO dependence on the
 *  pre-D-05 inspector silent-dead-write (D-05 / #77 converted that to
 *  alert+no-op). Every downstream assertion is unchanged. Returns the box id
 *  (the scene child + the edit/selection target now — there is no layer) and
 *  the channel id. */
async function seedAnimatedCube(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_selection && w.__basher_dag && w.__basher_evaluated_transform);
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
    const n = nodes();
    return {
      boxId,
      chId: Object.entries(n).find(([, x]) => x.type.startsWith('KeyframeChannel'))?.[0],
    };
  });

  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_selection!.getState().select('n_box');
  });
  await expect(page.getByTestId('inspector')).toBeVisible();
  // #365 Slice 2: the split Object's Transform is default-expanded; open idempotently.
  await openInspectorSection(page, 'transform');

  // V57 direct channels (#199): read the rendered position through the SAME
  // resolveEvaluatedTransform the renderer overlays the channel into.
  const moves = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const at = (s: number) =>
      w.__basher_evaluated_transform!('n_box', {
        time: { frame: Math.round(s * 60), seconds: s, normalized: 0 },
      })?.position ?? null;
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

test.describe('P7.4 D-06 — NPanel displayed value == evaluated render-walk (the #69 boundary-pair)', () => {
  test('boundary-pair: inspector input.value == evaluated walk at ≥2 playhead times (box select)', async ({
    page,
  }) => {
    const { boxId } = await seedAnimatedCube(page);
    expect(boxId).toBeTruthy();

    // Pause so the field is in its steady display-follow state (D-02:
    // read-only-while-playing applies to the gate, but the display equality
    // claim holds whether playing or paused — pausing makes the assertion
    // deterministic against a fixed playhead).
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_time!.getState().pause();
    });

    // V57 direct channels (#199): the box is its own scene child and the sole
    // selection target — there is no AnimationLayer wrapper. The inspector
    // renders for the CURRENT selection (n_box), showing inspector-vec-n_box-
    // position-* (the box has a `position` param, animated by the free-floating
    // channel). We assert: input.value == evalWalk(n_box) at ≥2 playhead times.
    // (Pre-#199 this also ran a layer-select branch asserting evalWalk(layerId)
    // == evalWalk(n_box) — the single-hop target identity; the wrapper is gone,
    // so the box-select branch is the whole boundary-pair now.)
    for (const t of [0.5, 1.5]) {
      await page.evaluate((s) => {
        (window as unknown as BasherWindow).__basher_time!.getState().setTime(s);
      }, t);

      // Box-select. Inspector displays inspector-vec-n_box-position-*.
      await page.evaluate(() => {
        (window as unknown as BasherWindow).__basher_selection!.getState().select('n_box');
      });
      const evalPosBox = await evalWalkPosition(page, t, 'n_box');
      expect(evalPosBox).not.toBeNull();
      // Poll the displayed value until React commits (mirrors p7.3:209 —
      // polling absorbs the effect settle without an arbitrary sleep).
      await expect
        .poll(async () => V(await inspectorDisplayedPosition(page, 'n_box')))
        .toBe(V(evalPosBox));
      const displayed = await inspectorDisplayedPosition(page, 'n_box');
      console.log(`[P7.4 D-06 box] t=${t} eval=${V(evalPosBox)} displayed=${V(displayed)}`);
      // The assertion whose absence let #69 stay open: BOTH sides equal.
      expect(displayed[0]).toBeCloseTo(evalPosBox![0], 3);
      expect(displayed[1]).toBeCloseTo(evalPosBox![1], 3);
      expect(displayed[2]).toBeCloseTo(evalPosBox![2], 3);
      // And the eval position actually MOVES (not frozen at authored) at
      // t=1.5 — the H40 surface-side distinctness proof. Without this, a
      // stuck-at-authored failure would silently pass with both sides
      // equal to [0,0,0].
      if (t === 1.5) {
        expect(evalPosBox![0]).toBeGreaterThan(0);
      }
    }
  });

  test('read-only while playing, editable while paused (D-02)', async ({ page }) => {
    await seedAnimatedCube(page);
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_selection!.getState().select('n_box');
    });
    const posX = page.getByTestId('inspector-vec-n_box-position-x');
    await expect(posX).toBeVisible();

    // Play → the field flips to read-only (data-readonly-while-playing
    // attribute present + DOM `readonly` attribute).
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_time!.getState().play();
    });
    await expect.poll(async () => posX.getAttribute('data-readonly-while-playing')).toBe('true');
    // Two independent observations of the readonly state:
    //   (a) the React-level seam: data-readonly-while-playing="true"
    //   (b) the DOM-level seam: the `readonly` attribute is present
    // While playing, the displayed value tracks the eval (changes per
    // frame as the clock advances), so we do NOT assert value-stays-frozen
    // — the gate is the attribute, not the value. The H40 boundary-pair
    // already proved equality holds at chosen playhead times; here we
    // prove the EDIT-affordance gate (D-02).
    await expect(posX).toHaveAttribute('readonly', '');
    // Playwright's `fill` action gates on the input being editable. On a
    // readonly input, it waits until the input becomes editable OR the
    // timeout expires. We use a short timeout (1s) to bound the wait —
    // the throw proves the DOM-level readonly contract IS honored.
    let fillThrew = false;
    try {
      await posX.fill('999', { timeout: 1000 });
    } catch {
      fillThrew = true;
    }
    expect(fillThrew).toBe(true);
    console.log(
      `[P7.4 D-02 playing] readonly attr present + fill rejected by Playwright readonly-gate`,
    );

    // Pause → the readonly attribute is gone; editing routes through
    // autoKeyCommit (the unchanged write path — D-02 explicit no-touch).
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_time!.getState().pause();
      w.__basher_time!.getState().setTime(1);
      // Auto-Key ON so a paused edit keys (mirrors 7.3 grab-ON test).
      const ak = w.__basher_autokey!.getState();
      if (!ak.enabled) ak.toggle();
    });
    await expect.poll(async () => posX.getAttribute('data-readonly-while-playing')).toBeFalsy();
    // The input is now editable. Fill + commit, then assert a keyframe
    // landed at the playhead with the new value.
    await posX.fill('6');
    await posX.press('Tab');
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const w = window as unknown as BasherWindow;
          const nodes = w.__basher_dag!.getState().state.nodes;
          const ch = Object.values(nodes).find((n) => n.type.startsWith('KeyframeChannel'));
          const kfs = (ch?.params.keyframes ?? []) as { time: number; value: number[] }[];
          return kfs.find((k) => Math.abs(k.time - 1) < 0.01)?.value?.[0] ?? null;
        }),
      )
      .toBeCloseTo(6, 3);
    console.log(`[P7.4 D-02 paused] edit committed → keyframe @ t=1 with x=6`);
  });

  // ── D-05 matrix row 3 — the #77 proof (Test 3 REWRITTEN) ───────────────
  // Pre-W5.1 this test asserted the OLD double-write contract
  // (`boxPos[0]==5` — the inspector dead-wrote the animated source). Its
  // own comment flagged: "documents the current behavior so a future
  // H36-style inspector re-route would intentionally invert it." W5.1
  // (commit 915360f) routed the inspector commit through the SHARED
  // `routeAnimatedGrab` chokepoint (src/app/animate/autoKeyCommit.ts:66),
  // so the inspector is now H36-correct: EXACTLY ONE write (the keyframe
  // via the seam), the source `node.params.position` is NOT mutated. This
  // rewrite asserts the CORRECTED single-write contract — the boundary
  // pair for #77: observe BOTH the keyframe (it happened) AND the source
  // (it did NOT mutate).
  test('D-05 row 3 (#77): animated + paused + Auto-Key ON inspector edit keys EXACTLY once; source NOT mutated (H36)', async ({
    page,
  }) => {
    await seedAnimatedCube(page);
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_time!.getState().pause();
      w.__basher_time!.getState().setTime(1);
      w.__basher_selection!.getState().select('n_box');
      const ak = w.__basher_autokey!.getState();
      if (!ak.enabled) ak.toggle(); // ON
    });

    const before = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      const nodes = w.__basher_dag!.getState().state.nodes;
      const ch = Object.values(nodes).find((n) => n.type.startsWith('KeyframeChannel'))!;
      return {
        kfCount: ((ch.params.keyframes ?? []) as unknown[]).length,
        // The SOURCE box node's authored position — must be UNCHANGED
        // after the edit (the seam keyed; no dead raw setParam reached it).
        boxPos: (nodes.n_box.params as { position: number[] }).position.slice() as number[],
      };
    });

    // The REAL inspector edit path (input.fill → onChange →
    // routeAnimatedGrab → autoKeyCommit seam). NOT a synthetic dispatch.
    const posX = page.getByTestId('inspector-vec-n_box-position-x');
    await expect(posX).toBeVisible();
    await posX.fill('5');
    await posX.press('Tab');

    const after = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      const nodes = w.__basher_dag!.getState().state.nodes;
      const ch = Object.values(nodes).find((n) => n.type.startsWith('KeyframeChannel'))!;
      const kfs = (ch.params.keyframes ?? []) as { time: number; value: number[] }[];
      return {
        kfCount: kfs.length,
        atSecond1: kfs.find((k) => Math.abs(k.time - 1) < 0.01)?.value ?? null,
        boxPos: (nodes.n_box.params as { position: number[] }).position.slice() as number[],
      };
    });
    console.log(
      `[P7.4 #77 row3] kf ${before.kfCount}→${after.kfCount} ` +
        `@1s=${V(after.atSecond1)} boxPos ${V(before.boxPos)}→${V(after.boxPos)}`,
    );

    // BOUNDARY-PAIR side A — the keyframe HAPPENED: a key landed at the
    // playhead t=1 with the typed x=5, and EXACTLY ONE new sample (the
    // seed has keys at t=0 and t=2; editing at t=1 inserts one → 2→3).
    expect(after.atSecond1).not.toBeNull();
    expect(after.atSecond1![0]).toBeCloseTo(5, 3);
    expect(after.kfCount).toBe(before.kfCount + 1);
    // BOUNDARY-PAIR side B — the source did NOT mutate: with the commit
    // routed through the shared chokepoint (W5.1 / D-05 row 3), the raw
    // `setParam` on the animated source is SKIPPED (H36 anti-double-write).
    // Pre-W5.1 this was `[5,0,0]` (the dead double-write). The corrected
    // contract: `node.params.position` is byte-unchanged.
    expect(after.boxPos).toEqual(before.boxPos);
  });

  // ── D-05 matrix row 4 — the intentional, desirable delta ───────────────
  // Animated + paused + Auto-Key OFF inspector edit. Pre-D-05 this SILENTLY
  // dead-wrote the source (the exact #77-class silent failure). D-05 routes
  // it through `routeAnimatedGrab`, whose OFF branch alerts + returns true
  // → ZERO ops. Mirrors p7.3's grab-OFF test (the alert-spy precedent).
  test('row 4 (#149): animated + paused + Auto-Key OFF inspector edit → transient held, ZERO ops, NO alert', async ({
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
    // Spy window.alert — #149 SUPERSEDES the OFF reject alert with a held
    // transient. The alert must NOT fire; the edit is held + overlaid instead.
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

    const posX = page.getByTestId('inspector-vec-n_box-position-x');
    await expect(posX).toBeVisible();
    await posX.fill('7');
    await posX.press('Tab');

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
      `[P7.4 #149 row4] alerts=${JSON.stringify(alerts)} transient=${JSON.stringify(transient)} dagChanged=${dagAfter !== dagBefore}`,
    );

    // NO alert — the reject is superseded by the transient hold (#149).
    expect(alerts.length).toBe(0);
    // The edit is HELD as a transient — the inspector routes the WHOLE position
    // vec through the seam (WYSIWYK), so the held value's X is the typed 7.
    expect(Array.isArray(transient)).toBe(true);
    expect((transient as number[])[0]).toBe(7);
    // ZERO ops — the DAG is byte-unchanged. No keyframe, no dead setParam (H36).
    expect(dagAfter).toBe(dagBefore);
  });

  // ── D-06 (#78) — WYSIWYK keys the displayed vector WITHOUT perturbing
  //    the sibling Y/Z axes (the non-perturbation contract). ──────────────
  // The channel has DISTINCT non-constant Y and Z curves, so evalY@t /
  // evalZ@t are meaningful (not authored pass-through). Paused at t=1
  // (NOT on an existing keyframe). Auto-Key ON. Edit position.x via the
  // inspector. Assert: (a) the new key at t=1 == [typedX, evalY@1,
  // evalZ@1] (WYSIWYK — the displayed vector), and (b) the Y/Z curve
  // evaluated at a DIFFERENT time t2≠1 is IDENTICAL before vs after AND
  // evalY/evalZ at t=1 itself is unchanged (the inserted sample lies ON
  // the existing Y/Z curve — it does not bend Y/Z).
  test('D-06 (#78): single-axis edit keys [typedX, evalY@t, evalZ@t] WITHOUT perturbing the Y/Z curve', async ({
    page,
  }) => {
    // Stage a cube with DISTINCT non-constant Y and Z curves directly. V57
    // direct channels (#199): a free-floating KeyframeChannelVec3 targeting the
    // box — NO AnimationLayer wrapper, NO scene rewire.
    const { chId } = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      const dagApi = w.__basher_dag!.getState() as unknown as {
        dispatch: (op: unknown) => void;
      };
      const dispatch = (op: unknown) => dagApi.dispatch(op);
      const nodes = () => w.__basher_dag!.getState().state.nodes;
      const boxId = 'n_box';
      if (!Object.values(nodes()).some((n) => n.type === 'TimeSource')) {
        dispatch({ type: 'addNode', nodeId: 'd6_time', nodeType: 'TimeSource', params: {} });
      }
      dispatch({
        type: 'addNode',
        nodeId: 'd6_pos_ch',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'd6_pos',
          target: boxId,
          paramPath: 'position',
          // DISTINCT non-constant Y and Z: Y goes 0→10 over [0,2], Z goes
          // 0→-6 over [0,2]. At t=1 (linear) evalY=5, evalZ=-3 — neither
          // an authored pass-through nor a keyframe time.
          keyframes: [
            { time: 0, value: [0, 0, 0], easing: 'linear' },
            { time: 2, value: [4, 10, -6], easing: 'linear' },
          ],
        },
      });
      return {
        chId: Object.entries(nodes()).find(([, n]) => n.type.startsWith('KeyframeChannel'))?.[0],
      };
    });
    expect(chId).toBeTruthy();

    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_selection!.getState().select('n_box');
      w.__basher_time!.getState().pause();
      w.__basher_time!.getState().setTime(1); // NOT on an existing keyframe
      const ak = w.__basher_autokey!.getState();
      if (!ak.enabled) ak.toggle(); // ON
    });
    await expect(page.getByTestId('inspector')).toBeVisible();
    // #365 Slice 2: the split Object's Transform is default-expanded; open idempotently.
    await openInspectorSection(page, 'transform');

    // Sample the Y/Z curve at a CONTROL time t2=1.5 BEFORE the edit (the
    // non-perturbation reference). V57 direct channels (#199): read the
    // rendered Y/Z at the sample time through the SAME resolveEvaluatedTransform
    // the renderer overlays the channel into.
    const sampleYZ = async (label: string) =>
      page.evaluate(
        ({ s }) => {
          const w = window as unknown as BasherWindow;
          const p =
            w.__basher_evaluated_transform!('n_box', {
              time: { frame: Math.round(s * 60), seconds: s, normalized: 0 },
            })?.position ?? null;
          return p ? ([p[1], p[2]] as [number, number]) : null;
        },
        { s: label === 't2' ? 1.5 : 1 },
      );

    const yzAtT_before = await sampleYZ('t');
    const yzAtT2_before = await sampleYZ('t2');
    // WYSIWYK expectation: at t=1, evalY=5, evalZ=-3 (linear interp).
    expect(yzAtT_before).not.toBeNull();
    expect(yzAtT_before![0]).toBeCloseTo(5, 3);
    expect(yzAtT_before![1]).toBeCloseTo(-3, 3);

    // Edit ONLY position.x via the inspector (WYSIWYK: the displayed
    // vector at t=1 is [_, 5, -3]; typing X keys [typedX, 5, -3]).
    const posX = page.getByTestId('inspector-vec-n_box-position-x');
    await expect(posX).toBeVisible();
    await posX.fill('9');
    await posX.press('Tab');

    const after = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      const nodes = w.__basher_dag!.getState().state.nodes;
      const ch = Object.values(nodes).find((n) => n.type.startsWith('KeyframeChannel'))!;
      const kfs = (ch.params.keyframes ?? []) as { time: number; value: number[] }[];
      return { keyAtT1: kfs.find((k) => Math.abs(k.time - 1) < 0.01)?.value ?? null };
    });
    const yzAtT_after = await sampleYZ('t');
    const yzAtT2_after = await sampleYZ('t2');
    console.log(
      `[P7.4 #78] keyAtT1=${V(after.keyAtT1)} ` +
        `yz@t ${V(yzAtT_before)}→${V(yzAtT_after)} ` +
        `yz@t2 ${V(yzAtT2_before)}→${V(yzAtT2_after)}`,
    );

    // WYSIWYK — the new keyframe at t=1 is EXACTLY the displayed vector:
    // [typedX=9, evalY@1=5, evalZ@1=-3].
    expect(after.keyAtT1).not.toBeNull();
    expect(after.keyAtT1![0]).toBeCloseTo(9, 3);
    expect(after.keyAtT1![1]).toBeCloseTo(5, 3);
    expect(after.keyAtT1![2]).toBeCloseTo(-3, 3);
    // NON-PERTURBATION — the inserted sample lies ON the pre-existing Y/Z
    // curve: Y/Z at the CONTROL time t2=1.5 is IDENTICAL before vs after
    // (the edit did not bend the Y/Z curve elsewhere)...
    expect(yzAtT2_after![0]).toBeCloseTo(yzAtT2_before![0], 4);
    expect(yzAtT2_after![1]).toBeCloseTo(yzAtT2_before![1], 4);
    // ...AND evalY/evalZ at t=1 itself is unchanged (keying the displayed
    // Y/Z onto the curve at a point it already passes through is a no-op
    // for Y/Z — "what you see is what you key" does not perturb siblings).
    expect(yzAtT_after![0]).toBeCloseTo(yzAtT_before![0], 4);
    expect(yzAtT_after![1]).toBeCloseTo(yzAtT_before![1], 4);
  });
});
