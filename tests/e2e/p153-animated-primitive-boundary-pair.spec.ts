// p153 — the H40 boundary-pair gate for an ANIMATED primitive.
//
// #153: `resolveEvaluatedMesh`'s Box/Sphere transform band used to read raw
// node params — STATIC, ignoring any AnimationLayer driving the node. So for an
// animated primitive the resolver returned the authored value while the renderer
// drew the animated one (latent H40, one indirection deeper than #68 — bites the
// #2/#3 material/UV consumers). The fix delegates the primitive band to
// `resolveEvaluatedTransform` (the same animation-tracking walk the renderer uses),
// mirroring the GltfChild branch.
//
// THE load-bearing observation — at ≥2 playhead times:
//   Side A — the REAL rendered three.js object's WORLD scale (__basher_mesh_world_scale).
//   Side B — `resolveEvaluatedMesh(...).transform.scale` at the SAME ctx.time
//            (__basher_evaluated_mesh, which flows ctx.time → resolveEvaluatedTransform).
// Assert A === B (H40) AND scale(t1) !== scale(t2) (the resolver TRACKS the
// animation — the regression the static-read would fail: it would return [1,1,1]
// at every time). A box scale is keyframed t0→[1,1,1], t2→[3,3,3] (linear).
//
// REF: issue #153; hetvabhasa H40; vyapti V29; dharana B14; resolveEvaluatedMesh.ts.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      dispatch: (op: unknown, source?: string, description?: string) => unknown;
      dispatchAtomic: (ops: unknown[], source?: string, description?: string) => unknown;
    };
  };
  __basher_time?: { getState: () => { setTime: (s: number) => void; seconds: number } };
  __basher_mesh_world_scale?: (nodeId: string) => [number, number, number] | null;
  __basher_evaluated_mesh?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { transform: { scale: [number, number, number] } } | null;
}

const ctxAt = (seconds: number) => ({
  time: { frame: Math.round(seconds * 60), seconds, normalized: 0 },
});

async function setTime(page: import('@playwright/test').Page, seconds: number) {
  await page.evaluate((s) => {
    (window as unknown as BasherWindow).__basher_time!.getState().setTime(s);
  }, seconds);
}

async function rendered(page: import('@playwright/test').Page, id: string) {
  return page.evaluate(
    (nodeId) => (window as unknown as BasherWindow).__basher_mesh_world_scale!(nodeId),
    id,
  );
}

async function resolvedAt(page: import('@playwright/test').Page, id: string, seconds: number) {
  return page.evaluate(
    ({ nodeId, c }) => {
      const m = (window as unknown as BasherWindow).__basher_evaluated_mesh!(nodeId, c);
      return m ? m.transform.scale : null;
    },
    { nodeId: id, c: ctxAt(seconds) },
  );
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
      w.__basher_dag && w.__basher_time && w.__basher_evaluated_mesh && w.__basher_mesh_world_scale,
    );
  });
  await page.waitForFunction(
    () => (window as unknown as BasherWindow).__basher_mesh_world_scale!('n_box') !== null,
  );

  // Insert an AnimationLayer between the default box (n_box → n_scene.children)
  // and the scene, driving n_box.scale via a KeyframeChannelVec3 (t0→[1,1,1],
  // t2→[3,3,3], linear). The layer-wrapped box now RENDERS animated.
  await page.evaluate(() => {
    const dag = (window as unknown as BasherWindow).__basher_dag!.getState();
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'p153_layer',
          nodeType: 'AnimationLayer',
          params: { name: 'L', mute: false, solo: false, weight: 1, boneMask: [] },
        },
        {
          type: 'addNode',
          nodeId: 'p153_ch',
          nodeType: 'KeyframeChannelVec3',
          params: {
            name: 'scale',
            target: 'n_box',
            paramPath: 'scale',
            keyframes: [
              { time: 0, value: [1, 1, 1], easing: 'linear' },
              { time: 2, value: [3, 3, 3], easing: 'linear' },
            ],
          },
        },
        {
          type: 'connect',
          from: { node: 'p153_ch', socket: 'out' },
          to: { node: 'p153_layer', socket: 'animation' },
        },
        {
          type: 'connect',
          from: { node: 'n_box', socket: 'out' },
          to: { node: 'p153_layer', socket: 'target' },
        },
        {
          type: 'disconnect',
          from: { node: 'n_box', socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        },
        {
          type: 'connect',
          from: { node: 'p153_layer', socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        },
      ],
      'user',
      'p153-seed-animated-box',
    );
  });
});

test.describe('#153 — resolveEvaluatedMesh tracks an animated primitive (H40 boundary-pair)', () => {
  test('rendered scale == resolver scale at t=0.5 and t=1.5, AND the resolver tracks animation (≠ static)', async ({
    page,
  }) => {
    // Linear lerp of [1,1,1]→[3,3,3] over t∈[0,2]: scale(t) = 1 + t.
    // t=0.5 → 1.5 ; t=1.5 → 2.5.
    const probe = async (seconds: number, expected: number) => {
      await setTime(page, seconds);
      // Side A is read by the SCENE-CHILD producer id — after the seed the scene
      // child is the AnimationLayer's output (`p153_layer`), so the wrapping group
      // is named 'p153_layer' (SceneFromDAG names groups by childRefs[i].node). The
      // probe descends to the inner mesh, which carries the box's animated scale.
      // Side B resolves the BOX node ('n_box') — resolveEvaluatedMesh delegates to
      // resolveEvaluatedTransform, walks the rendered scene, finds the box under the
      // layer, and returns the SAME animated scale. That equality IS the boundary-pair.
      const RENDER_ID = 'p153_layer';
      // Wait for the render commit to flow the animated scale onto the object.
      await page.waitForFunction(
        ({ exp, rid }) => {
          const r = (window as unknown as BasherWindow).__basher_mesh_world_scale!(rid);
          return r !== null && Math.abs(r[0] - exp) < 1e-3;
        },
        { exp: expected, rid: RENDER_ID },
      );
      const r = await rendered(page, RENDER_ID);
      const s = await resolvedAt(page, 'n_box', seconds);
      expect(r, `rendered@${seconds}`).not.toBeNull();
      expect(s, `resolver@${seconds}`).not.toBeNull();
      // Side A — the REAL rendered object IS at the animated scale (not inferred).
      for (let i = 0; i < 3; i++) expect(r![i]).toBeCloseTo(expected, 3);
      // Side B — the resolver returns the SAME animated value at this ctx.time
      // (the #153 fix; the old static-read would return [1,1,1] here).
      for (let i = 0; i < 3; i++) expect(s![i]).toBeCloseTo(expected, 3);
      // H40 — rendered == resolver, component-wise.
      for (let i = 0; i < 3; i++) expect(r![i]).toBeCloseTo(s![i], 3);
      return s!;
    };

    const at05 = await probe(0.5, 1.5);
    const at15 = await probe(1.5, 2.5);

    // The resolver TRACKS the animation — the two times differ. A static param
    // read (the pre-#153 bug) would return [1,1,1] at BOTH, so this would fail.
    expect(at05[0]).not.toBeCloseTo(at15[0], 2);
    expect(at15[0]).toBeGreaterThan(at05[0]);
  });
});
