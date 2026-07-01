// #247 increment 2 — the camera "look at target" property. The inspector picker
// binds the camera's lookAt to a scene object via a Track-To constraint; the
// reticle then follows that object (blue / read-only) and the look-through camera
// aims at it. Clearing the binding freezes the current aim into the authored
// lookAt (no jump) and removes the constraint.
//
// Falsify: without the Track-To the lookAt would stay the authored value; without
// the freeze-on-clear the camera would snap back to a stale lookAt.

import { expect, test } from './_fixtures';

interface Node {
  type: string;
  inputs: Record<string, unknown>;
  params: Record<string, unknown>;
}
interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { outputs: { scene?: { node: string } }; nodes: Record<string, Node> };
      dispatch: (a: unknown, s: string, l: string) => void;
    };
  };
  __basher_selection?: { getState: () => { select: (id: string | null) => void } };
  __basher_camera_gizmo?: () => { aim: number[] | null; reticle?: boolean; bound?: boolean };
  __basher_camera_gizmo_grab?: (k: string, t: number[]) => void;
}

async function ready(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as BasherWindow).__basher_dag));
  await page.waitForTimeout(400);
}

async function ids(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
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
}

async function selectCam(page: import('@playwright/test').Page, camId: string) {
  await page.evaluate((cid) => {
    (window as unknown as BasherWindow).__basher_selection!.getState().select(cid);
  }, camId);
  await page.waitForFunction(() =>
    Boolean((window as unknown as BasherWindow).__basher_camera_gizmo_grab),
  );
  await page.waitForTimeout(150);
}

async function gizmo(page: import('@playwright/test').Page) {
  return page.evaluate(() => (window as unknown as BasherWindow).__basher_camera_gizmo!());
}

test.describe('#247 camera look-at target', () => {
  test('binding a target creates a Track-To; reticle is bound and sits on it', async ({ page }) => {
    await ready(page);
    const { camId, targetId, targetPos } = await ids(page);
    await selectCam(page, camId);
    await page.selectOption(`[data-testid="inspector-camera-lookat-${camId}"]`, targetId);
    await page.waitForTimeout(200);

    const g = await gizmo(page);
    expect(g.bound).toBe(true);
    expect(g.aim).toEqual(targetPos); // reticle on the target's position
    const tt = await page.evaluate((cid) => {
      const st = (window as unknown as BasherWindow).__basher_dag!.getState().state;
      const t = Object.values(st.nodes).find(
        (n) => n.type === 'TrackTo' && (n.params as { target?: string }).target === cid,
      );
      return t?.params ?? null;
    }, camId);
    expect(tt).toMatchObject({ target: camId, aimNode: targetId, mute: false });
  });

  test('the reticle follows the target when it moves (re-seeded on selection)', async ({
    page,
  }) => {
    await ready(page);
    const { camId, targetId } = await ids(page);
    await selectCam(page, camId);
    await page.selectOption(`[data-testid="inspector-camera-lookat-${camId}"]`, targetId);
    await page.waitForTimeout(150);
    // Move the target, then re-select the camera (real unmount/remount → fresh seed).
    await page.evaluate((tid) => {
      (window as unknown as BasherWindow)
        .__basher_dag!.getState()
        .dispatch(
          { type: 'setParam', nodeId: tid, paramPath: 'position', value: [-3, 2, 1] },
          'user',
          'move target',
        );
    }, targetId);
    await page.evaluate((tid) => {
      (window as unknown as BasherWindow).__basher_selection!.getState().select(tid);
    }, targetId);
    await page.waitForTimeout(120);
    await selectCam(page, camId);
    const g = await gizmo(page);
    expect(g.aim).toEqual([-3, 2, 1]); // reticle followed the moved target
  });

  test('clearing the binding freezes the aim into lookAt and removes the Track-To', async ({
    page,
  }) => {
    await ready(page);
    const { camId, targetId, targetPos } = await ids(page);
    await selectCam(page, camId);
    await page.selectOption(`[data-testid="inspector-camera-lookat-${camId}"]`, targetId);
    await page.waitForTimeout(150);
    await page.selectOption(`[data-testid="inspector-camera-lookat-${camId}"]`, '');
    await page.waitForTimeout(150);

    const g = await gizmo(page);
    expect(g.bound).toBe(false);
    const camLookAt = await page.evaluate((cid) => {
      const st = (window as unknown as BasherWindow).__basher_dag!.getState().state;
      return st.nodes[cid].params.lookAt as number[];
    }, camId);
    expect(camLookAt).toEqual(targetPos); // frozen to the last aim, no jump
    const tt = await page.evaluate((cid) => {
      const st = (window as unknown as BasherWindow).__basher_dag!.getState().state;
      return Object.values(st.nodes).some(
        (n) => n.type === 'TrackTo' && (n.params as { target?: string }).target === cid,
      );
    }, camId);
    expect(tt).toBe(false); // constraint removed (no orphan)
  });
});
