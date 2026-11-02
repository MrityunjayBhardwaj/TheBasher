// #1774 — looking through an orthographic camera shows an orthographic view, framed as the
// render frames it: the camera's Orthographic Scale of height, the width by the viewport's
// aspect (`buildRenderCamera`). Blender's camera view draws through the camera's own projection.
//
// Observed on the LIVE view camera (Lokayata): its projection, the world frame it shows, and
// where it puts world points on screen, compared with the render's own camera built from the
// same pose at the viewport's size. A perspective camera's look-through and the editor's own
// persp/ortho toggle are pinned beside it so the change cannot leak into either.

import { test, expect } from './_fixtures';

interface ViewCam {
  position: [number, number, number];
  fov: number | null;
  near: number;
  far: number;
  zoom: number;
  isOrthographic: boolean;
  orthoFrame: { height: number; width: number } | null;
  lookThrough: boolean;
}

interface W {
  __basher_view_camera: () => ViewCam | null;
  __basher_project_ndc: (xyz: [number, number, number]) => [number, number, number] | null;
  __basher_viewport: {
    getState: () => {
      setLookThroughCamera: (on: boolean) => void;
      setCameraProjection: (p: 'perspective' | 'orthographic') => void;
    };
  };
  __basher_dag: {
    getState: () => {
      dispatch: (op: unknown) => void;
      state: { nodes: Record<string, { inputs?: Record<string, { node?: string }> }> };
    };
  };
}

/** World points spread around the default scene, off-axis so a wrong width, height or
 *  projection moves them on screen. */
const PROBES: [number, number, number][] = [
  [0, 0, 0],
  [0.5, 0.5, 0.5],
  [-0.5, 0.25, 0.4],
  [1.2, -0.3, -0.8],
];

async function ready(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(w.__basher_view_camera?.() && w.__basher_dag && w.__basher_viewport);
  });
  // The boot bounds-fit moves the free view until it settles, and it resumes after a
  // look-through, so it would confound where a look-through leaves the free view.
  await page.waitForFunction(
    () =>
      (window as unknown as { __basher_view_fit?: { wants: boolean } }).__basher_view_fit?.wants ===
      false,
  );
}

/** Set lens params on the default camera's CameraData. */
async function setLens(page: import('@playwright/test').Page, params: Record<string, unknown>) {
  await page.evaluate((p) => {
    const dag = (window as unknown as W).__basher_dag.getState();
    const dataId = dag.state.nodes.n_camera.inputs!.data!.node!;
    for (const [paramPath, value] of Object.entries(p))
      dag.dispatch({ type: 'setParam', nodeId: dataId, paramPath, value });
  }, params);
}

async function lookThrough(page: import('@playwright/test').Page, on: boolean) {
  await page.evaluate(
    (v) => (window as unknown as W).__basher_viewport.getState().setLookThroughCamera(v),
    on,
  );
  // Let the remount + a few frames land.
  await page.waitForTimeout(400);
}

/** The live view camera, plus the render camera built from the active pose at the viewport's
 *  size, each projecting the probes to NDC. */
async function observe(page: import('@playwright/test').Page) {
  return page.evaluate(async (probes) => {
    const w = window as unknown as W;
    // The app's own modules, served by Vite at these URLs (the same instances the app runs).
    const renderUrl = '/src/render/renderToImage.ts';
    const poseUrl = '/src/app/activeCamera.ts';
    const { buildRenderCamera } = (await import(
      /* @vite-ignore */ renderUrl
    )) as typeof import('../../src/render/renderToImage');
    const { resolveActiveCameraPose } = (await import(
      /* @vite-ignore */ poseUrl
    )) as typeof import('../../src/app/activeCamera');
    // R3F sizes its view from the Canvas container's bounding rect (fractional pixels).
    const rect = document.querySelector('[data-testid="viewport-canvas"]')!.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const pose = resolveActiveCameraPose(w.__basher_dag.getState().state as never);
    const render = buildRenderCamera(pose, width, height);
    // The app's own THREE.Vector3, reached through the camera (a bare 'three' import does not
    // resolve inside page.evaluate).
    const Vec = render.position.constructor as new (
      x: number,
      y: number,
      z: number,
    ) => typeof render.position;
    const renderNdc = probes.map((p) => {
      const v = new Vec(p[0], p[1], p[2]).project(render);
      return [v.x, v.y];
    });
    const viewNdc = probes.map((p) => {
      const v = w.__basher_project_ndc(p)!;
      return [v[0], v[1]];
    });
    return {
      view: w.__basher_view_camera()!,
      pose: { kind: pose.kind, orthoScale: pose.orthoScale, near: pose.near, far: pose.far },
      aspect: width / height,
      renderNdc,
      viewNdc,
    };
  }, PROBES);
}

function expectSameFrame(o: Awaited<ReturnType<typeof observe>>) {
  for (let i = 0; i < o.renderNdc.length; i++) {
    expect(o.viewNdc[i][0]).toBeCloseTo(o.renderNdc[i][0], 3);
    expect(o.viewNdc[i][1]).toBeCloseTo(o.renderNdc[i][1], 3);
  }
}

test.describe('#1774 orthographic look-through', () => {
  test('an orthographic camera is looked through orthographically, framed by its scale', async ({
    page,
  }) => {
    await ready(page);
    await setLens(page, { projection: 'Orthographic', orthoScale: 6 });
    await lookThrough(page, true);

    for (const scale of [6, 2.5]) {
      await setLens(page, { orthoScale: scale });
      await page.waitForTimeout(200);
      const o = await observe(page);
      expect(o.pose.kind).toBe('OrthographicCamera');
      expect(o.view.lookThrough).toBe(true);
      expect(o.view.isOrthographic).toBe(true);
      // Height is the Orthographic Scale; width follows the viewport's aspect.
      expect(o.view.orthoFrame!.height).toBeCloseTo(scale, 4);
      expect(o.view.orthoFrame!.width).toBeCloseTo(scale * o.aspect, 3);
      expect(o.view.near).toBeCloseTo(o.pose.near, 6);
      expect(o.view.far).toBeCloseTo(o.pose.far, 6);
      // Every probe lands where the render puts it.
      expectSameFrame(o);
    }
  });

  test('a perspective camera is still looked through in perspective, as the render frames it', async ({
    page,
  }) => {
    await ready(page);
    await lookThrough(page, true);
    const o = await observe(page);
    expect(o.pose.kind).toBe('PerspectiveCamera');
    expect(o.view.isOrthographic).toBe(false);
    expect(o.view.orthoFrame).toBeNull();
    expectSameFrame(o);
  });

  test("the editor's own projection toggle governs the free view, not the camera's", async ({
    page,
  }) => {
    await ready(page);
    // An orthographic DAG camera does not make the free view orthographic...
    await setLens(page, { projection: 'Orthographic', orthoScale: 6 });
    await page.waitForTimeout(300);
    let v = await page.evaluate(() => (window as unknown as W).__basher_view_camera()!);
    expect(v.lookThrough).toBe(false);
    expect(v.isOrthographic).toBe(false);
    // ...and the editor's ortho toggle still does.
    await page.evaluate(() =>
      (window as unknown as W).__basher_viewport.getState().setCameraProjection('orthographic'),
    );
    await page.waitForTimeout(400);
    v = await page.evaluate(() => (window as unknown as W).__basher_view_camera()!);
    expect(v.isOrthographic).toBe(true);
    expect(v.lookThrough).toBe(false);
  });

  test('leaving an orthographic look-through returns a posed perspective free view', async ({
    page,
  }) => {
    await ready(page);
    await setLens(page, { projection: 'Orthographic', orthoScale: 6 });
    await lookThrough(page, true);
    const inside = await observe(page);
    expect(inside.view.isOrthographic).toBe(true);
    await lookThrough(page, false);
    const v = await page.evaluate(() => (window as unknown as W).__basher_view_camera()!);
    expect(v.lookThrough).toBe(false);
    expect(v.isOrthographic).toBe(false);
    // Like a perspective camera's look-through today: the free view is left where the camera
    // stood, not at the origin a freshly mounted camera starts at.
    for (let i = 0; i < 3; i++) expect(v.position[i]).toBeCloseTo(inside.view.position[i], 3);
  });

  test('leaving a perspective look-through returns a posed orthographic editor view', async ({
    page,
  }) => {
    await ready(page);
    await page.evaluate(() =>
      (window as unknown as W).__basher_viewport.getState().setCameraProjection('orthographic'),
    );
    await page.waitForTimeout(300);
    await lookThrough(page, true);
    const inside = await observe(page);
    expect(inside.view.isOrthographic).toBe(false);
    await lookThrough(page, false);
    const v = await page.evaluate(() => (window as unknown as W).__basher_view_camera()!);
    expect(v.isOrthographic).toBe(true);
    for (let i = 0; i < 3; i++) expect(v.position[i]).toBeCloseTo(inside.view.position[i], 3);
  });
});
