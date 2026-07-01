// #247 — the camera lookAt is a "Point of Interest" target RETICLE, not a second
// transform gizmo. Selecting a camera used to mount TWO TransformControls (body +
// aim) which read as "2 gizmos" (#245 only made them look different). Now the aim
// is a categorically different glyph: a billboarded ring + centre dot with a
// connector line, directly draggable on a view-facing plane, still writing the
// same lookAt param the resolver / look-through camera read.
//
// Falsify: if the reticle didn't drive lookAt, dragging it would not change the
// DAG lookAt; if the aim were still a triad, `reticle` would be absent.

import { expect, test } from './_fixtures';

interface CamGizmo {
  position: number[] | null;
  aim: number[] | null;
  reticle?: boolean;
  bound?: boolean;
}
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
  __basher_camera_gizmo?: () => CamGizmo;
  __basher_camera_gizmo_grab?: (
    k: 'rotate' | 'translate' | 'aim',
    t: [number, number, number],
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

async function lookAt(page: import('@playwright/test').Page, id: string) {
  return page.evaluate((cid) => {
    const st = (window as unknown as BasherWindow).__basher_dag!.getState().state;
    return st.nodes[cid].params.lookAt as number[];
  }, id);
}

test.describe('#247 camera lookAt reticle', () => {
  test('the aim is a reticle (not a triad), body + aim at distinct points', async ({ page }) => {
    await ready(page);
    const id = await camId(page);
    await selectCamera(page, id);
    const g = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_camera_gizmo!(),
    );
    expect(g.reticle).toBe(true);
    expect(g.bound).toBe(false);
    expect(g.position).toEqual([3, 2, 3]); // body at camera position
    expect(g.aim).toEqual([0, 0, 0]); // reticle at the lookAt point
  });

  test('dragging the reticle re-aims the camera (real pointer drag, behind geometry)', async ({
    page,
  }) => {
    await ready(page);
    const id = await camId(page);
    await selectCamera(page, id);
    expect(await lookAt(page, id)).toEqual([0, 0, 0]);
    // The reticle sits at the world origin — screen-centre of the viewport — and is
    // occluded by the cube, proving the depth-independent pick works.
    await page.mouse.move(640, 394);
    await page.mouse.down();
    await page.mouse.move(760, 300, { steps: 8 });
    await page.mouse.move(800, 280, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const after = await lookAt(page, id);
    expect(after).not.toEqual([0, 0, 0]);
    // The reticle proxy followed the drag (matches the authored lookAt).
    const g = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_camera_gizmo!(),
    );
    expect(g.aim![0]).toBeCloseTo(after[0], 3);
    expect(g.aim![1]).toBeCloseTo(after[1], 3);
    expect(g.aim![2]).toBeCloseTo(after[2], 3);
  });
});
