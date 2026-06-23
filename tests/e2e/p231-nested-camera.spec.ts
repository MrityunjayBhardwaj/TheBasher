// #231 Inc 3.3 — a camera nested in a Group frames from the group-composed WORLD.
// Build a camera under a Group@[5,1,0], make it the active camera, look through it,
// and assert the live view camera sits at the group-composed world position (not the
// camera's local [0,0,0]). This is the viewport==render world-pose boundary-pair for
// nested cameras (mirrors p231-grouped-light for lights).

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';

interface W {
  __basher_dag: { getState: () => { dispatch: (op: unknown) => void } };
  __basher_view_camera?: () => { position: [number, number, number]; lookThrough: boolean } | null;
}

const GRP = 'n_p231nc_grp';
const CAM = 'n_p231nc_cam';

test.describe('#231 Inc 3.3 — nested camera world pose', () => {
  test('a camera under a Group looks through from the group-composed world', async ({
    page,
  }: {
    page: Page;
  }) => {
    await page.goto('/');
    await page.waitForFunction(() => Boolean((window as unknown as W).__basher_dag), {
      timeout: 15000,
    });

    // Group@[5,1,0] → scene.children; camera (local origin, looking -Z) nested in it
    // AND wired active into scene.camera (single socket → replaces the seed camera).
    await page.evaluate(
      ({ grp, cam }) => {
        const d = (op: unknown) => (window as unknown as W).__basher_dag.getState().dispatch(op);
        d({ type: 'addNode', nodeId: grp, nodeType: 'Group', params: { position: [5, 1, 0] } });
        d({
          type: 'connect',
          from: { node: grp, socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        });
        d({
          type: 'addNode',
          nodeId: cam,
          nodeType: 'PerspectiveCamera',
          params: { position: [0, 0, 0], lookAt: [0, 0, -1], fov: 50 },
        });
        d({
          type: 'connect',
          from: { node: cam, socket: 'out' },
          to: { node: grp, socket: 'children' },
        });
        d({
          type: 'connect',
          from: { node: cam, socket: 'out' },
          to: { node: 'n_scene', socket: 'camera' },
        });
      },
      { grp: GRP, cam: CAM },
    );

    // Look through the active camera (Numpad-0 analog).
    await page.locator('body').click();
    await page.keyboard.press('0');

    // The live view camera follows the nested camera's WORLD pose: local [0,0,0]
    // under Group@[5,1,0] → world ≈ [5,1,0]. (Local-only would report ~[0,0,0].)
    await expect
      .poll(
        async () => {
          const vc = await page.evaluate(
            () => (window as unknown as W).__basher_view_camera?.() ?? null,
          );
          if (!vc || !vc.lookThrough) return null;
          return vc.position.map((n) => Math.round(n)).join(',');
        },
        { timeout: 8000 },
      )
      .toBe('5,1,0');

    await page.screenshot({ path: 'test-results/p231-nested-camera.png' });
  });
});
