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

import { cameraRotationLookingAt } from '../../src/app/cameraOrientation';
import { expect, test } from './_fixtures';
import { dataNodeIdOf } from './_seedNodes';

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
    return Boolean(
      w.__basher_view_camera && w.__basher_viewport && w.__basher_dag && w.__basher_selection,
    );
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
  await page.waitForFunction(() =>
    Boolean((window as unknown as BasherWindow).__basher_camera_gizmo_grab),
  );
  await page.waitForTimeout(150);
}

test.describe('#229 camera aim gizmo', () => {
  test('aim-target handle re-aims the camera (DAG rotation + look-through agree)', async ({
    page,
  }) => {
    await ready(page);
    const id = await camId(page);
    await selectCamera(page, id);

    // #1760 #1764 — an un-aimed camera turns by its own rotation, on the Object; its lens holds
    // no aim, so the reticle writes the rotation and nothing on the lens.
    const lens = await dataNodeIdOf(page, id);
    const pos = (await camParam(page, id, 'position')) as [number, number, number];

    // Drag the aim handle to a new world point.
    const AIM: [number, number, number] = [5, 1, 0];
    await page.evaluate((aim) => {
      (window as unknown as BasherWindow).__basher_camera_gizmo_grab!('aim', aim);
    }, AIM);
    await page.waitForTimeout(100);

    // Side A — the DAG: the camera's own rotation now looks at the new point; the lens is untouched.
    const rotation = (await camParam(page, id, 'rotation')) as [number, number, number];
    const want0 = cameraRotationLookingAt(pos, AIM, 0);
    for (let i = 0; i < 3; i++) expect(rotation[i]).toBeCloseTo(want0[i], 3);
    expect(await camParam(page, lens, 'lookAt')).toBeUndefined();

    // Side B — the look-through camera aims from position toward the new lookAt.
    await page.keyboard.press('0');
    await page.waitForTimeout(200);
    const view = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    expect(view!.lookThrough).toBe(true);
    const want = norm([AIM[0] - pos[0], AIM[1] - pos[1], AIM[2] - pos[2]]);
    const got = norm(view!.direction);
    for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i], 2);
  });

  // #1760 — a camera is turned by its own rotation (V665): a rotate drag writes the camera
  // Object's rotation, and the look-through looks along it, banked.
  test('rotate gizmo turns the camera by its rotation + banks roll', async ({ page }) => {
    await ready(page);
    const id = await camId(page);
    await selectCamera(page, id);

    // Rotate the camera body to an absolute world orientation (euler degrees). The default
    // camera is top-level, so its own rotation is that orientation.
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_camera_gizmo_grab!('rotate', [0, 30, 20]);
    });
    await page.waitForTimeout(100);

    const rot = (await camParam(page, id, 'rotation')) as [number, number, number];
    [0, 30, 20].forEach((v, i) => expect(rot[i]).toBeCloseTo(v, 3));

    // Side B — the look-through camera looks along that rotation and is banked by it.
    await page.keyboard.press('0');
    await page.waitForTimeout(200);
    const view = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_view_camera!(),
    );
    const d = Math.PI / 180;
    const [ry, rz] = [30 * d, 20 * d];
    // Forward of XYZ euler (0, ry, rz) applied to −Z: Ry·Rz·(0,0,−1) = (−sin ry, 0, −cos ry).
    const want = norm([-Math.sin(ry), 0, -Math.cos(ry)]);
    const got = norm(view!.direction);
    for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i], 2);
    // Banked by the Z part: up = Ry·Rz·(0,1,0) = (−sin rz·cos ry, cos rz, sin rz·sin ry).
    const wantUp = [-Math.sin(rz) * Math.cos(ry), Math.cos(rz), Math.sin(rz) * Math.sin(ry)];
    for (let i = 0; i < 3; i++) expect(view!.up[i]).toBeCloseTo(wantUp[i], 2);
  });
});
