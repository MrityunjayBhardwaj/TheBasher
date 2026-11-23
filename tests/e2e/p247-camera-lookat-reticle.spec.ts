// #247 — the camera lookAt is a "Point of Interest" target RETICLE, not a second
// transform gizmo. Selecting a camera used to mount TWO TransformControls (body +
// aim) which read as "2 gizmos" (#245 only made them look different). Now the aim
// is a categorically different glyph: a billboarded ring + centre dot with a
// connector line, directly draggable on a view-facing plane, still writing the
// same lookAt param the resolver / look-through camera read.
//
// Falsify: if the reticle didn't drive lookAt, dragging it would not change the
// DAG lookAt; if the aim were still a triad, `reticle` would be absent.

import * as THREE from 'three';
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

/** The camera Object's own rotation (#1764: an un-aimed camera is turned by it; the lens holds
 *  no aim). */
async function rotationOf(page: import('@playwright/test').Page, objectId: string) {
  return page.evaluate((cid) => {
    const st = (window as unknown as BasherWindow).__basher_dag!.getState().state;
    return st.nodes[cid].params.rotation as [number, number, number];
  }, objectId);
}

/** The canvas pixel the editor camera draws world point `p` at. */
async function screenOf(
  page: import('@playwright/test').Page,
  p: [number, number, number],
): Promise<[number, number]> {
  const box = (await page.locator('canvas').first().boundingBox())!;
  const m = await page.evaluate(() => {
    const cam = (
      window as unknown as {
        __basher_three: {
          getState: () => {
            camera: {
              projectionMatrix: { elements: number[] };
              matrixWorldInverse: { elements: number[] };
            };
          };
        };
      }
    ).__basher_three.getState().camera;
    return { proj: [...cam.projectionMatrix.elements], view: [...cam.matrixWorldInverse.elements] };
  });
  const ndc = new THREE.Vector3(...p).applyMatrix4(
    new THREE.Matrix4().multiplyMatrices(
      new THREE.Matrix4().fromArray(m.proj),
      new THREE.Matrix4().fromArray(m.view),
    ),
  );
  expect(Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1, 'the point is on the canvas').toBe(true);
  return [box.x + ((ndc.x + 1) / 2) * box.width, box.y + ((1 - ndc.y) / 2) * box.height];
}

/** Where a camera at `position` with euler-degree `rotation` looks (its −Z). */
function forwardOf(rotation: [number, number, number]): THREE.Vector3 {
  const e = new THREE.Euler(...rotation.map((d) => THREE.MathUtils.degToRad(d)), 'XYZ');
  return new THREE.Vector3(0, 0, -1).applyEuler(e);
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
    // reticle at the lookAt point — #1760: a point straight ahead along the camera's own
    // rotation, which looks at it, so equal to the float.
    g.aim!.forEach((v) => expect(v).toBeCloseTo(0, 6));
  });

  test('dragging the reticle re-aims the camera (real pointer drag, behind geometry)', async ({
    page,
  }) => {
    await ready(page);
    const id = await camId(page);
    await selectCamera(page, id);
    const before = await rotationOf(page, id);
    // The default camera looks at, and is focused on, the origin: its reticle sits there.
    const g0 = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_camera_gizmo!(),
    );
    g0.aim!.forEach((v) => expect(v).toBeCloseTo(0, 3));
    // The reticle sits at the world origin and is occluded by the cube, proving the
    // depth-independent pick works. #1952 — where the origin lands on screen depends on the
    // layout (the side panels start as rails, so the viewport is wider than it was), so the
    // press is aimed by projecting the origin through the editor camera onto the canvas,
    // not at a fixed pixel.
    const [ox, oy] = await screenOf(page, [0, 0, 0]);
    await page.mouse.move(ox, oy);
    await page.mouse.down();
    await page.mouse.move(ox + 120, oy - 94, { steps: 8 });
    await page.mouse.move(ox + 160, oy - 114, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    // The camera turned: its own rotation moved…
    const after = await rotationOf(page, id);
    expect(after).not.toEqual(before);
    // …to look at the reticle, which left the origin: the reticle lies on its new line of sight.
    const g = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_camera_gizmo!(),
    );
    expect(Math.hypot(...g.aim!)).toBeGreaterThan(0.1);
    const pos = new THREE.Vector3(...(g.position as [number, number, number]));
    const toAim = new THREE.Vector3(...(g.aim as [number, number, number])).sub(pos).normalize();
    const fwd = forwardOf(after);
    expect(toAim.dot(fwd)).toBeCloseTo(1, 3);
  });
});
