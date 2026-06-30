// #245 — the camera gizmo's two handles (body + aim) must be visually
// DISTINGUISHABLE. Before this fix, both rendered as identical translate gizmos
// in translate mode (#229 known-limit), so selecting a camera looked like "two
// gizmos". The aim handle now renders SMALLER (AIM_GIZMO_SIZE) and carries a
// visible target marker mesh, so it reads as "the lookAt target", not a second
// body gizmo — while staying fully functional (drag still re-aims the camera).
//
// Falsify: revert the size/marker and aimSize would be 1 / aimMarker false, and
// dragging the aim would still re-aim (the differentiation, not the function, is
// what regressed).

import { expect, test } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<string, { inputs: Record<string, unknown>; params: Record<string, unknown> }>;
      };
    };
  };
  __basher_selection?: { getState: () => { select: (id: string | null) => void } };
  __basher_camera_gizmo?: () => {
    position: number[] | null;
    aim: number[] | null;
    aimSize?: number;
    aimMarker?: boolean;
  };
  __basher_camera_gizmo_grab?: (
    kind: 'rotate' | 'translate' | 'aim',
    target: [number, number, number],
  ) => void;
}

async function ready(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() =>
    Boolean(
      (window as unknown as BasherWindow).__basher_dag &&
      (window as unknown as BasherWindow).__basher_selection,
    ),
  );
  await page.waitForTimeout(300);
}

async function camId(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const st = (window as unknown as BasherWindow).__basher_dag!.getState().state;
    const sceneNode = st.nodes[st.outputs.scene!.node];
    const ref = sceneNode.inputs.camera as { node: string } | { node: string }[];
    return Array.isArray(ref) ? ref[0].node : ref.node;
  });
}

async function selectCamera(page: import('@playwright/test').Page, id: string) {
  await page.evaluate((cid) => {
    (window as unknown as BasherWindow).__basher_selection!.getState().select(cid);
  }, id);
  await page.waitForFunction(() =>
    Boolean((window as unknown as BasherWindow).__basher_camera_gizmo_grab),
  );
  await page.waitForTimeout(150);
}

test.describe('#245 camera gizmo differentiation', () => {
  test('aim handle is smaller than the body and carries a target marker', async ({ page }) => {
    await ready(page);
    const id = await camId(page);
    await selectCamera(page, id);

    const g = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_camera_gizmo!(),
    );
    // Body at the camera position, aim at the lookAt point — distinct places.
    expect(g.position).toEqual([3, 2, 3]);
    expect(g.aim).toEqual([0, 0, 0]);
    // The aim gizmo is rendered smaller than the default (body) size of 1.
    expect(g.aimSize).toBeLessThan(1);
    // The aim handle carries a visible target marker mesh.
    expect(g.aimMarker).toBe(true);
  });

  test('the differentiated aim handle still re-aims the camera', async ({ page }) => {
    await ready(page);
    const id = await camId(page);
    await selectCamera(page, id);

    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_camera_gizmo_grab!('aim', [2, 1, -1]);
    });
    await page.waitForTimeout(100);
    const lookAt = await page.evaluate((cid) => {
      const st = (window as unknown as BasherWindow).__basher_dag!.getState().state;
      return st.nodes[cid].params.lookAt;
    }, id);
    expect(lookAt).toEqual([2, 1, -1]);
  });
});
