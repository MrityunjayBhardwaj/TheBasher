// #247 increment 3 — depth-of-field "focus on target". When enabled, the focus
// plane tracks the lookAt (the reticle / bound target): the effective focus
// distance becomes |position − lookAt|, resolved at the SAME site the renderer
// feeds cameraDof, so the bokeh follows the aim. The inspector field then shows
// the tracked distance, read-only.
//
// Falsify: without focus-on-target the focus field would keep the authored value
// and not change when the lookAt / target moves.

import { expect, test } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<
          string,
          { type: string; inputs: Record<string, unknown>; params: Record<string, unknown> }
        >;
      };
    };
  };
  __basher_selection?: { getState: () => { select: (id: string | null) => void } };
  __basher_camera_gizmo_grab?: (k: string, t: number[]) => void;
}

async function setup(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as BasherWindow).__basher_dag));
  await page.waitForTimeout(400);
  const { camId, targetId, targetPos } = await page.evaluate(() => {
    const st = (window as unknown as BasherWindow).__basher_dag!.getState().state;
    const sceneNode = st.nodes[st.outputs.scene!.node];
    const ref = sceneNode.inputs.camera as { node: string } | { node: string }[];
    const camId = Array.isArray(ref) ? ref[0].node : ref.node;
    const targetId = Object.entries(st.nodes).find(
      ([id, n]) =>
        id !== camId &&
        n.type !== 'TrackTo' &&
        Array.isArray((n.params as { position?: unknown }).position),
    )![0];
    return { camId, targetId, targetPos: st.nodes[targetId].params.position as number[] };
  });
  await page.evaluate((cid) => {
    (window as unknown as BasherWindow).__basher_selection!.getState().select(cid);
  }, camId);
  await page.waitForFunction(() =>
    Boolean((window as unknown as BasherWindow).__basher_camera_gizmo_grab),
  );
  await page.waitForTimeout(200);
  return { camId, targetId, targetPos };
}

function dist(a: number[], b: number[]) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

test.describe('#247 DoF focus on target', () => {
  test('focus distance derives from the aim and is read-only; follows a bound target', async ({
    page,
  }) => {
    const { camId, targetId, targetPos } = await setup(page);
    await page.locator(`[data-testid="inspector-camera-dof-${camId}"]`).check();
    await page.locator(`[data-testid="inspector-camera-focus-on-target-${camId}"]`).check();
    await page.waitForTimeout(200);

    const focusField = page.locator(`[data-testid="inspector-camera-focus-${camId}"]`);
    // Default lookAt = [0,0,0], camera at [3,2,3] → focus = |[3,2,3]| ≈ 4.7.
    expect(Number(await focusField.inputValue())).toBeCloseTo(dist([3, 2, 3], [0, 0, 0]), 1);
    expect(await focusField.getAttribute('readonly')).not.toBeNull();
    const camParams = await page.evaluate((cid) => {
      return (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes[cid].params;
    }, camId);
    expect(camParams.focusOnTarget).toBe(true);

    // Bind a target → focus jumps to the distance to it.
    await page.selectOption(`[data-testid="inspector-camera-lookat-${camId}"]`, targetId);
    await page.waitForTimeout(250);
    expect(Number(await focusField.inputValue())).toBeCloseTo(dist([3, 2, 3], targetPos), 1);
  });
});
