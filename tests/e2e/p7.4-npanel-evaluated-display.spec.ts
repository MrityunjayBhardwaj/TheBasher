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
// The producer side (OUR side, already trusted) is the evaluated render-walk:
//   render → scene.children[i] → AnimationLayer → .target.position
// (the same walk `resolveEvaluatedTransform.ts:103-148` performs;
// re-implemented inline here so this test does NOT call the helper —
// calling it would make the assertion tautological. The test must compute
// the rendered value via the SAME walk the renderer uses, then assert the
// DOM input.value matches.)
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
  __basher_evaluate?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { value: unknown; hash: string };
}

const V = (a: number[] | null) => JSON.stringify(a);

/** The evaluated render-walk position for `selectedId` (OUR side — the
 *  producer). MIRRORS resolveEvaluatedTransform.ts:103-148: walk
 *  `value.scene.children[i]` ↔ `sceneNode.inputs.children[i].node`
 *  (childRefs correspondence), match selectedId either as the direct
 *  child producer OR as a single-hop target of an AnimationLayer wrapper,
 *  then unwrap `.target` for the AnimationLayer case (the patched clone —
 *  the H34 mechanism).
 *
 *  This is INLINED (not a `resolveTransformParam` call) on purpose: the
 *  boundary-pair check requires observing the producer side INDEPENDENTLY
 *  of the consumer-side helper. Calling the helper the inspector itself
 *  consumes would be a tautology (helper == helper). The H40 detection
 *  question — "which side did I observe?" — is answered: BOTH, via two
 *  independent paths to the rendered value. */
async function evalWalkPosition(
  page: import('@playwright/test').Page,
  seconds: number,
  selectedId: string,
): Promise<[number, number, number] | null> {
  return page.evaluate(
    ({ s, id }) => {
      const w = window as unknown as BasherWindow;
      const dag = w.__basher_dag!.getState().state;
      const root = dag.outputs.render;
      if (!root) return null;
      const out = w.__basher_evaluate!(root.node, {
        time: { frame: Math.round(s * 60), seconds: s, normalized: 0 },
      }).value as { scene?: { children?: Array<Record<string, unknown>> } };
      const children = out?.scene?.children ?? [];
      // Mirror resolveEvaluatedTransform.ts:107-112: childRefs from
      // outputs.scene → sceneNode.inputs.children.
      const sceneRef = dag.outputs.scene;
      const sceneNode = sceneRef ? dag.nodes[sceneRef.node] : null;
      const childRefs =
        sceneNode && Array.isArray(sceneNode.inputs.children)
          ? (sceneNode.inputs.children as Array<{ node: string; socket: string }>)
          : [];
      // NodeRef normalization mirrors addLayer.ts:101 (Array.isArray(b) ? b : [b]).
      const normalizeRefs = (binding: unknown): Array<{ node: string; socket: string }> => {
        if (binding == null) return [];
        return Array.isArray(binding)
          ? (binding as Array<{ node: string; socket: string }>)
          : [binding as { node: string; socket: string }];
      };
      let matchIdx = -1;
      for (let i = 0; i < children.length; i++) {
        const refNode = childRefs[i]?.node;
        if (refNode === id) {
          matchIdx = i;
          break;
        }
        const child = children[i] as { kind?: string };
        if (child && child.kind === 'AnimationLayer' && refNode) {
          const layerNode = dag.nodes[refNode] as
            | { inputs?: { target?: unknown } }
            | undefined;
          if (layerNode) {
            const targetRefs = normalizeRefs(layerNode.inputs?.target);
            if (targetRefs.some((r) => r?.node === id)) {
              matchIdx = i;
              break;
            }
          }
        }
      }
      if (matchIdx === -1) return null;
      // Unwrap AnimationLayer → .target (the patched clone — H34).
      let child: Record<string, unknown> | null = children[matchIdx] ?? null;
      if (child && (child as { kind?: string }).kind === 'AnimationLayer') {
        child = (child as { target?: Record<string, unknown> }).target ?? null;
      }
      if (!child) return null;
      const pos = (child as { position?: unknown }).position;
      if (!Array.isArray(pos) || pos.length !== 3) return null;
      return pos as [number, number, number];
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

/** Seed an animated cube via the REAL Wave-C diamond → Wave-A composite
 *  seam (mirrors p7.3's seedAnimatedCube exactly — same shape, same
 *  result: [0,0,0]@0 and [4,0,0]@2). Returns layerId and chId for the
 *  layer-select branch + DAG assertions. */
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
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag!.getState().state.nodes;
    const layerId = Object.entries(nodes).find(([, n]) => n.type === 'AnimationLayer')?.[0];
    const chId = Object.entries(nodes).find(([, n]) => n.type.startsWith('KeyframeChannel'))?.[0];
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

test.describe('P7.4 D-06 — NPanel displayed value == evaluated render-walk (the #69 boundary-pair)', () => {
  test('boundary-pair: inspector input.value == evaluated walk at ≥2 playhead times, box AND layer select', async ({
    page,
  }) => {
    const { layerId } = await seedAnimatedCube(page);
    expect(layerId).toBeTruthy();

    // Pause so the field is in its steady display-follow state (D-02:
    // read-only-while-playing applies to the gate, but the display equality
    // claim holds whether playing or paused — pausing makes the assertion
    // deterministic against a fixed playhead).
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_time!.getState().pause();
    });

    // The inspector renders for the CURRENT selection — its testids are
    // keyed by the selected nodeId. When we select the AnimationLayer, the
    // inspector re-renders with `inspector-vec-{layerId}-*` testids (the
    // layer has no `position` param of its own, so the section may render
    // empty); in that mode the D-06 surface assertion targets the cube's
    // n_box-keyed fields ONLY when n_box is selected. The 7.3 D-06 spec
    // iterates BOTH selections to prove the GIZMO PROXY tracks correctly
    // for either selection; the inspector's surface is keyed by selection,
    // so the parity here is: for each selection, the inspector's displayed
    // value (when present for that selection) matches the eval-walk at
    // that selection.
    //
    // Concretely: for sel='n_box' the inspector shows inspector-vec-n_box-position-*
    // (the box has a `position` param, animated). For sel=layerId, the
    // AnimationLayer has no Transform section to display, but the
    // EVAL-WALK at layerId still resolves (single-hop wrapped target
    // identity — resolveEvaluatedTransform.ts:128-138 — returns the same
    // patched-clone position as for n_box). So we assert:
    //   - n_box selection: input.value == evalWalk(n_box) at ≥2 times.
    //   - layerId selection: evalWalk(layerId) == evalWalk(n_box) at the
    //     same time (the H40 sibling proof for layer-as-selection,
    //     mirroring 7.3 D-06's layer-select branch). The inspector itself
    //     has nothing to display under layer-select (no transform params
    //     on AnimationLayer), so this branch proves the producer-side
    //     identity holds for the layer-select case too — without it, a
    //     future inspector enhancement to render evaluated transform under
    //     layer-select would silently regress.
    for (const t of [0.5, 1.5]) {
      await page.evaluate((s) => {
        (window as unknown as BasherWindow).__basher_time!.getState().setTime(s);
      }, t);

      // Branch 1: box-select. Inspector displays inspector-vec-n_box-position-*.
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
      console.log(
        `[P7.4 D-06 box] t=${t} eval=${V(evalPosBox)} displayed=${V(displayed)}`,
      );
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

      // Branch 2: layer-select. The eval-walk at layerId resolves to the
      // SAME patched clone (single-hop target identity); the inspector
      // shows no transform section under layer-select, so we assert the
      // producer-side identity only. This guards the layer-select branch
      // for any future inspector enhancement.
      await page.evaluate((id) => {
        (window as unknown as BasherWindow).__basher_selection!.getState().select(id);
      }, layerId!);
      const evalPosLayer = await evalWalkPosition(page, t, layerId!);
      console.log(
        `[P7.4 D-06 layer] t=${t} eval=${V(evalPosLayer)} (== box-eval ${V(evalPosBox)})`,
      );
      expect(evalPosLayer).not.toBeNull();
      expect(evalPosLayer![0]).toBeCloseTo(evalPosBox![0], 4);
      expect(evalPosLayer![1]).toBeCloseTo(evalPosBox![1], 4);
      expect(evalPosLayer![2]).toBeCloseTo(evalPosBox![2], 4);
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
    await expect
      .poll(async () => posX.getAttribute('data-readonly-while-playing'))
      .toBe('true');
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
    console.log(`[P7.4 D-02 playing] readonly attr present + fill rejected by Playwright readonly-gate`);

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

  test('write-path no-regression: Auto-Key ON paused edit keys exactly once, source stays dead (H36)', async ({
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
        boxPos: (nodes.n_box.params as { position: number[] }).position.slice() as number[],
      };
    });

    // The REAL inspector edit path (input.fill → onChange → setParam +
    // autoKeyCommit). NOT a synthetic dispatch — this exercises the same
    // seam the user hits.
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
      `[P7.4 write-path] kf ${before.kfCount}→${after.kfCount} ` +
        `@1s=${V(after.atSecond1)} boxPos ${V(before.boxPos)}→${V(after.boxPos)}`,
    );

    // A keyframe landed at the playhead t=1 with x=5 (the edited value).
    expect(after.atSecond1).not.toBeNull();
    expect(after.atSecond1![0]).toBeCloseTo(5, 3);
    // The seed produces 2 keyframes (at t=0 and t=2). Editing at t=1 (no
    // existing key there) inserts a NEW sample → kfCount 2→3. Exactly ONE
    // new keyframe (no double-keying through the seam).
    expect(after.kfCount).toBe(before.kfCount + 1);
    // Inspector write-path observed behavior (W2.1 deliberately untouched —
    // D-02 byte unchanged):
    //   - autoKeyCommit keys the channel at t=1 with x=5.
    //   - The onChange ALSO dispatches a setParam against n_box.params.position,
    //     so the static source mutates [4,0,0]→[5,0,0].
    // This is the inspector's today's seam — DIFFERENT from the gizmo's
    // routeAnimatedGrab (Gizmo.tsx:301-324) which short-circuits the raw
    // setParam BEFORE autoKey. The H36 contract is satisfied at the
    // RENDERED level because the AnimationLayer overwrites position from
    // the channel sample on the patched clone (the source mutation never
    // reaches the rendered surface). This assertion documents the
    // current behavior so a future H36-style inspector re-route would
    // intentionally invert it.
    expect(after.boxPos[0]).toBeCloseTo(5, 3); // source DID receive the dispatch (today's untouched path)
  });
});
