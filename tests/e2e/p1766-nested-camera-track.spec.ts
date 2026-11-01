// p1766 (#1766) — a camera inside a moving group, aimed by a Track-To, is DRAWN looking at what
// the Track-To names. The Track-To resolves to a world point and the camera's lookAt is in its
// parent's space; before the fix the world point was lifted by the group a second time, so a
// camera at world [5, 1, 0] tracking the origin was drawn looking down -Z (group moved) or -X
// (group moved and turned). Read off the live look-through camera, not the resolver.
import { expect, test } from './_fixtures';
import { splitCameraOps } from './_splitCamera';

type V3 = [number, number, number];
interface W {
  __basher_dag: { getState: () => { dispatch: (op: unknown) => void } };
  __basher_view_camera: () => { position: V3; direction: V3; lookThrough: boolean } | null;
}

const CAM = 'n_p1766_cam';
const CASES: { name: string; grp: { position: V3; rotation: V3 }; camLocal: V3 }[] = [
  {
    name: 'a group at the origin (control)',
    grp: { position: [0, 0, 0], rotation: [0, 0, 0] },
    camLocal: [5, 1, 0],
  },
  { name: 'a moved group', grp: { position: [5, 1, 0], rotation: [0, 0, 0] }, camLocal: [0, 0, 0] },
  {
    name: 'a moved and turned group',
    grp: { position: [5, 1, 0], rotation: [0, 90, 0] },
    camLocal: [0, 0, 0],
  },
];

for (const c of CASES)
  test(`a tracked camera in ${c.name} is drawn looking at its aim`, async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as unknown as Partial<W>;
      return Boolean(w.__basher_dag && w.__basher_view_camera);
    });
    await page.evaluate(
      ({ grp, camLocal, camOps, cam }) => {
        const d = (op: unknown) => (window as unknown as W).__basher_dag.getState().dispatch(op);
        d({ type: 'addNode', nodeId: 'n_p1766_grp', nodeType: 'Group', params: grp });
        d({
          type: 'connect',
          from: { node: 'n_p1766_grp', socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        });
        for (const op of camOps) d(op);
        d({ type: 'setParam', nodeId: cam, paramPath: 'position', value: camLocal });
        d({
          type: 'connect',
          from: { node: cam, socket: 'out' },
          to: { node: 'n_p1766_grp', socket: 'children' },
        });
        d({
          type: 'connect',
          from: { node: cam, socket: 'out' },
          to: { node: 'n_scene', socket: 'camera' },
          replace: true,
        });
        // A Track-To at a fixed WORLD point: the origin.
        d({
          type: 'addNode',
          nodeId: 'n_p1766_track',
          nodeType: 'TrackTo',
          params: { target: cam, aimPoint: [0, 0, 0] },
        });
      },
      {
        ...c,
        cam: CAM,
        camOps: splitCameraOps({ objectId: CAM, position: [0, 0, 0], lookAt: [0, 0, -1], fov: 50 }),
      },
    );
    await page.locator('body').click();
    await page.keyboard.press('0');
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => (window as unknown as W).__basher_view_camera()))
            ?.lookThrough ?? false,
      )
      .toBe(true);
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
    );
    const vc = (await page.evaluate(() => (window as unknown as W).__basher_view_camera()))!;
    console.log(
      `p1766 ${c.name}: ${JSON.stringify(vc.position)} → ${JSON.stringify(vc.direction)}`,
    );
    vc.position.forEach((v, i) => expect(v, `world position ${i}`).toBeCloseTo([5, 1, 0][i], 3));
    const len = Math.hypot(...vc.position);
    vc.direction.forEach((v, i) =>
      expect(v, `forward ${i} faces the origin`).toBeCloseTo(-vc.position[i] / len, 3),
    );
  });
