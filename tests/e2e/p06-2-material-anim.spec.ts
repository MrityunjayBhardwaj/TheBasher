// v0.6 #2 (#178) W4 — material-scalar ANIMATION boundary-pair (H40) + the Blender
// field-colour table (4.3). A KeyframeChannelNumber animates
// material.specular.roughness inside an AnimationLayer; paused mid-curve the REAL
// three.js mesh.material.roughness (side-A) == resolveEvaluatedParam (side-B).
// FALSIFIABLE: the same revert that breaks the transform overlay would break this
// (the material reads the static value → side-A diverges).
//
// Reuses the #149 engine verbatim — W0 proved the generic channel scan matches a
// nested material paramPath, and p149 proved material.base.color renders via the
// AnimationLayer overlay. This adds the SCALAR (roughness) sibling.

import { expect, test } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string }> };
      dispatch: (op: unknown) => void;
    };
  };
  __basher_time?: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_autokey?: { getState: () => { enabled: boolean; toggle: () => void } };
  __basher_transient?: {
    getState: () => { set: (n: string, p: string, v: unknown) => void; clearAll: () => void };
  };
  __basher_evaluated_param?: (
    nodeId: string,
    paramPath: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { value: unknown } | null;
  __basher_mesh_material?: (nodeId: string) => { roughness: number | null } | null;
}

const PARAM = 'material.specular.roughness';

async function seedRoughnessAnim(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_selection && w.__basher_transient);
  });
  await page.evaluate((paramPath) => {
    const w = window as unknown as BasherWindow;
    const api = w.__basher_dag!.getState();
    const dispatch = (op: unknown) => api.dispatch(op);
    const nodes = () => w.__basher_dag!.getState().state.nodes;
    const sceneId = Object.entries(nodes()).find(([, n]) => n.type === 'Scene')?.[0];
    if (!sceneId) throw new Error('no Scene');
    const boxId = 'n_box';
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
      nodeId: 'seed_ch',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'seed_ch',
        target: boxId,
        paramPath,
        keyframes: [
          { time: 0, value: 0.1 },
          { time: 2, value: 0.9 },
        ],
      },
    });
    dispatch({
      type: 'connect',
      from: { node: 'seed_ch', socket: 'out' },
      to: { node: 'seed_layer', socket: 'animation' },
    });
  }, PARAM);
}

test.describe('v0.6 #2 W4 — material-scalar animation boundary-pair (H40)', () => {
  test('roughness animates: real mesh.material.roughness == resolver (PAUSED mid-curve)', async ({
    page,
  }) => {
    await page.goto('/');
    await seedRoughnessAnim(page);
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_transient!.getState().clearAll();
      w.__basher_time!.getState().pause();
      w.__basher_time!.getState().setTime(1); // t=1 → curve roughness ~0.5
      w.__basher_selection!.getState().select('n_box');
    });
    // Wait for the rendered material to reflect the curve (non-default roughness).
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      const m = w.__basher_mesh_material?.('seed_layer');
      return m != null && m.roughness != null && Math.abs(m.roughness - 0.5) < 0.02;
    });

    const { sideA, sideB } = await page.evaluate((paramPath) => {
      const w = window as unknown as BasherWindow;
      const ctx = { time: { frame: 60, seconds: 1, normalized: 0.1 } };
      return {
        sideA: w.__basher_mesh_material!('seed_layer')?.roughness ?? null,
        sideB: (w.__basher_evaluated_param!('n_box', paramPath, ctx)?.value as number) ?? null,
      };
    }, PARAM);
    console.log(`[p06-2 anim] sideA=${sideA} sideB=${sideB}`);

    // H40 boundary-pair: the REAL three.js material == the resolver, mid-curve.
    expect(sideA).not.toBeNull();
    expect(sideB).not.toBeNull();
    expect(sideA!).toBeCloseTo(0.5, 2);
    expect(sideA!).toBeCloseTo(sideB!, 5);
  });

  test('4.3 — ParamDiamond shows the Blender colour table on a material field', async ({
    page,
  }) => {
    await page.goto('/');
    await seedRoughnessAnim(page);
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_transient!.getState().clearAll();
      w.__basher_time!.getState().pause();
      w.__basher_selection!.getState().select('n_box');
    });
    await expect(page.getByTestId('inspector')).toBeVisible();
    const editor = page.getByTestId('inspector-material-editor-n_box');
    if (!(await editor.isVisible())) {
      await page.getByTestId('inspector-section-toggle-material').click();
    }
    const diamond = page.getByTestId(`inspector-diamond-n_box-${PARAM}`);
    await expect(diamond).toBeVisible();

    // Between keys (t=1) → 'animated' (green, text-accent).
    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_time!.getState().setTime(1),
    );
    await expect(diamond).toHaveAttribute('data-anim-state', 'animated');
    await expect(diamond).toHaveClass(/text-accent/);

    // On a key (t=0) → 'on-key' (yellow, text-record).
    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_time!.getState().setTime(0),
    );
    await expect(diamond).toHaveAttribute('data-anim-state', 'on-key');
    await expect(diamond).toHaveClass(/text-record/);

    // A transient (held edit) → orange (text-warn) wins regardless of anim state.
    await page.evaluate((p) => {
      (window as unknown as BasherWindow).__basher_transient!.getState().set('n_box', p, 0.42);
    }, PARAM);
    await expect(diamond).toHaveClass(/text-warn/);
  });
});
