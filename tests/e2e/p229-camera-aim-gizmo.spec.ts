// #229 — camera aim gizmo, observed on the REAL R3F view camera (Lokayata).
// A Basher camera aims via position + lookAt (a point) + roll, with no rotation
// param, so the generic gizmo could only translate it. CameraGizmo adds:
//   - a draggable AIM-TARGET handle at the lookAt point → re-aims the camera, and
//   - a ROTATE gizmo that orbits the aim about the camera position and banks roll.
// Both write through the same setParam path the resolver (V56) reads, so the DAG
// param AND the look-through camera (the render side) agree — the boundary pair.
//
// Falsify: without the gizmo writing lookAt, dragging the aim handle would not
// move the DAG lookAt and the look-through direction would not change.

import { expect, test } from './_fixtures';

interface CamView {
  position: [number, number, number];
  direction: [number, number, number];
  up: [number, number, number];
  lookThrough: boolean;
}
interface BasherWindow {
  __basher_view_camera?: () => CamView | null;
  __basher_viewport?: { getState: () => { lookThroughCamera: boolean } };
  __basher_selection?: { getState: () => { select: (id: string | null) => void } };
  __basher_camera_gizmo_grab?: (
    kind: 'rotate' | 'translate' | 'aim',
    target: [number, number, number],
  ) => void;
  __basher_dag?: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<string, { inputs: Record<string, unknown>; params: Record<string, unknown> }>;
      };
    };
  };
}

function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

async function ready(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_view_camera && w.__basher_viewport && w.__basher_dag && w.__basher_selection);
  });
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

async function camParam(page: import('@playwright/test').Page, id: string, path: string) {
  return page.evaluate(
    ({ id, path }) => {
      const st = (window as unknown as BasherWindow).__basher_dag!.getState().state;
      return st.nodes[id].params[path];
    },
    { id, path },
  );
}

async function selectCamera(page: import('@playwright/test').Page, id: string) {
  await page.evaluate((cid) => {
    (window as unknown as BasherWindow).__basher_selection!.getState().select(cid);
  }, id);
  // CameraGizmo mounts on selection → its grab seam appears.
  await page.waitForFunction(() => Boolean((window as unknown as BasherWindow).__basher_camera_gizmo_grab));
  await page.waitForTimeout(150);
}

test.describe('#229 camera aim gizmo', () => {
  test('aim-target handle re-aims the camera (DAG lookAt + look-through agree)', async ({ page }) => {
    await ready(page);
    const id = await camId(page);
    await selectCamera(page, id);

    const pos = (await camParam(page, id, 'position')) as [number, number, number];

    // Drag the aim handle to a new world point.
    const AIM: [number, number, number] = [5, 1, 0];
    await page.evaluate((aim) => {
      (window as unknown as BasherWindow).__basher_camera_gizmo_grab!('aim', aim);
    }, AIM);
    await page.waitForTimeout(100);

    // Side A — the DAG lookAt param updated.
    const lookAt = (await camParam(page, id, 'lookAt')) as [number, number, number];
    expect(lookAt[0]).toBeCloseTo(5, 3);
    expect(lookAt[1]).toBeCloseTo(1, 3);
    expect(lookAt[2]).toBeCloseTo(0, 3);

    // Side B — the look-through camera aims from position toward the new lookAt.
    await page.keyboard.press('0');
    await page.waitForTimeout(200);
    const view = await page.evaluate(() => (window as unknown as BasherWindow).__basher_view_camera!());
    expect(view!.lookThrough).toBe(true);
    const want = norm([AIM[0] - pos[0], AIM[1] - pos[1], AIM[2] - pos[2]]);
    const got = norm(view!.direction);
    for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i], 2);
  });

  test('rotate gizmo orbits the aim about the camera + banks roll', async ({ page }) => {
    await ready(page);
    const id = await camId(page);
    await selectCamera(page, id);

    const pos = (await camParam(page, id, 'position')) as [number, number, number];
    const before = (await camParam(page, id, 'lookAt')) as [number, number, number];
    const distBefore = Math.hypot(before[0] - pos[0], before[1] - pos[1], before[2] - pos[2]);

    // Rotate the camera body to an absolute orientation (euler degrees). A 30°
    // yaw about Y re-aims the camera; the aim stays the same distance away.
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_camera_gizmo_grab!('rotate', [0, 30, 20]);
    });
    await page.waitForTimeout(100);

    const after = (await camParam(page, id, 'lookAt')) as [number, number, number];
    const roll = (await camParam(page, id, 'roll')) as number;
    const distAfter = Math.hypot(after[0] - pos[0], after[1] - pos[1], after[2] - pos[2]);

    // The aim moved (re-aimed) but kept its distance from the camera.
    const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
    expect(moved).toBeGreaterThan(0.1);
    expect(distAfter).toBeCloseTo(distBefore, 2);
    // Roll picked up the Z component of the rotation (banking).
    expect(Math.abs(roll)).toBeGreaterThan(1);

    // Side B — the look-through camera matches the new aim.
    await page.keyboard.press('0');
    await page.waitForTimeout(200);
    const view = await page.evaluate(() => (window as unknown as BasherWindow).__basher_view_camera!());
    const want = norm([after[0] - pos[0], after[1] - pos[1], after[2] - pos[2]]);
    const got = norm(view!.direction);
    for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i], 2);
  });
});
