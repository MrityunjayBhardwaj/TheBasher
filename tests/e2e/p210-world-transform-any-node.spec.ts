// p210 — resolveWorldTransform is now UNIFORM across node kinds (the renderable-
// node unification, #210). Before this, __basher_world_transform returned null for
// lights and cameras (it walked only scene.children); a Track-To could not aim at
// a light/camera and the seam was per-type. This observes, on the LIVE app:
//
//   Light BOUNDARY-PAIR (seam == render, H40): add a STATIC AreaLight at a known
//   position; the seam's resolved world position == the REAL rendered three.js
//   RectAreaLight position. (Static — animation render is the separate item #1.)
//
//   Camera: __basher_world_transform('n_camera') is non-null and its position ==
//   the camera node's params.position (previously null).
//
// REF: issue #210; src/app/resolveWorldTransform.ts; vyapti V37/V58; H40.

import { test, expect } from './_fixtures';
import { splitLightOps } from './_splitLight';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<string, { type: string; params?: { position?: [number, number, number] } }>;
      };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_three?: {
    getState: () => {
      scene: {
        traverse: (
          cb: (o: { type: string; position: { x: number; y: number; z: number } }) => void,
        ) => void;
      } | null;
    };
  };
  __basher_world_transform?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { position: [number, number, number]; scale: [number, number, number] } | null;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* not present */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_three && w.__basher_world_transform);
  });
});

test('a light resolves world transform == its live rendered RectAreaLight (seam == render, was null)', async ({
  page,
}) => {
  const pos: [number, number, number] = [3, 4, 5];
  // #386 C3: a light is a split Object + LightData. The world transform is asked of the
  // OBJECT — the half that owns the pose — which is also the id wired into scene.lights.
  const lightOps = splitLightOps({
    objectId: 'p210_light',
    lightKind: 'Area',
    position: pos,
    shading: { intensity: 5, color: '#ffffff', width: 2, height: 2, lookAt: [0, 0, 0] },
  });
  const lid = await page.evaluate((lightOps) => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag!.getState();
    const sceneId = dag.state.outputs.scene!.node;
    const id = 'p210_light';
    dag.dispatchAtomic(
      [
        ...lightOps,
        {
          type: 'connect',
          from: { node: id, socket: 'out' },
          to: { node: sceneId, socket: 'lights' },
        },
      ],
      'e2e',
      'p210 add light',
    );
    return id;
  }, lightOps);

  // Side B (seam) — resolveWorldTransform now resolves a light (was null).
  const world = await page.evaluate(
    (id) => (window as unknown as BasherWindow).__basher_world_transform!(id),
    lid,
  );
  expect(world, 'seam resolves a light world (no longer null)').not.toBeNull();
  for (let i = 0; i < 3; i++) expect(world!.position[i]).toBeCloseTo(pos[i], 4);

  // Side A (render) — the REAL rendered RectAreaLight nearest the expected spot.
  const live = await page.evaluate((p) => {
    const three = (window as unknown as BasherWindow).__basher_three!.getState().scene;
    if (!three) return null;
    let best: [number, number, number] | null = null;
    let bestD = Infinity;
    three.traverse((o) => {
      if (o.type !== 'RectAreaLight') return;
      const d = Math.hypot(o.position.x - p[0], o.position.y - p[1], o.position.z - p[2]);
      if (d < bestD) {
        bestD = d;
        best = [o.position.x, o.position.y, o.position.z];
      }
    });
    return best;
  }, pos);
  expect(live, 'a live RectAreaLight exists').not.toBeNull();

  // BOUNDARY-PAIR: seam world == live rendered light (H40, static case).
  for (let i = 0; i < 3; i++) expect(world!.position[i]).toBeCloseTo(live![i], 3);
});

test('a camera resolves world transform from its pose (was null)', async ({ page }) => {
  const camPos = await page.evaluate(() => {
    const n = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes['n_camera'];
    return (n?.params?.position ?? null) as [number, number, number] | null;
  });
  expect(camPos, 'default project has n_camera with a position').not.toBeNull();

  const world = await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_world_transform!('n_camera'),
  );
  expect(world, 'seam resolves a camera world (no longer null)').not.toBeNull();
  for (let i = 0; i < 3; i++) expect(world!.position[i]).toBeCloseTo(camPos![i], 4);
});
