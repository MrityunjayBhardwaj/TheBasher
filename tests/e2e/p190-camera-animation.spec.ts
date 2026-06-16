// #190 — camera animation end-to-end: a keyframed camera is FOLLOWED in the
// live viewport look-through. The DAG camera is wired via scene.camera (outside
// the AnimationLayer / scene-child machinery), so its channels target the camera
// node DIRECTLY and EditorViewCamera samples resolveActiveCameraPoseAt(seconds)
// each frame while looking through.
//
// These tests observe the REAL R3F view camera (Lokayata): inject a position /
// fov channel onto n_camera via the DAG seam, look through the camera, scrub the
// playhead, and assert the view camera's pose tracks the keyed value at time T.
// Falsifiable: revert slice 4 (the look-through follow useFrame) → the pose is
// memoized on node identity → it stays at the static authored pose at every
// time → frame-0 and frame-N poses are identical → these assertions fail.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_view_camera?: () => {
    position: [number, number, number];
    fov: number | null;
    near: number;
    far: number;
    lookThrough: boolean;
  } | null;
  __basher_viewport?: { getState: () => { lookThroughCamera: boolean } };
  __basher_time?: { getState: () => { setTime: (seconds: number) => void } };
  __basher_dag?: {
    getState: () => {
      dispatch: (op: unknown, source: string, desc: string) => void;
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
    };
  };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
}

async function waitReady(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(
      w.__basher_view_camera &&
      w.__basher_viewport &&
      w.__basher_time &&
      w.__basher_dag &&
      w.__basher_selection,
    );
  });
  await page.waitForTimeout(300);
}

/** Inject a KeyframeChannel* targeting the active camera node, via the DAG seam.
 *  Mirrors what the (future) authoring path produces — channels addressed
 *  straight at n_camera with no AnimationLayer wrapper. */
async function addCameraChannel(
  page: import('@playwright/test').Page,
  nodeId: string,
  nodeType: 'KeyframeChannelVec3' | 'KeyframeChannelNumber',
  paramPath: string,
  keyframes: unknown[],
) {
  await page.evaluate(
    ({ nodeId, nodeType, paramPath, keyframes }) => {
      (window as unknown as BasherWindow).__basher_dag!.getState().dispatch(
        {
          type: 'addNode',
          nodeId,
          nodeType,
          params: { name: paramPath, target: 'n_camera', paramPath, keyframes },
        },
        'test',
        'inject camera channel',
      );
    },
    { nodeId, nodeType, paramPath, keyframes },
  );
}

async function lookThrough(page: import('@playwright/test').Page) {
  await page.keyboard.press('0');
  await page.waitForTimeout(200);
  const lt = await page.evaluate(
    () => (window as unknown as BasherWindow).__basher_viewport!.getState().lookThroughCamera,
  );
  expect(lt).toBe(true);
}

async function poseAt(page: import('@playwright/test').Page, seconds: number) {
  await page.evaluate(
    (s) => (window as unknown as BasherWindow).__basher_time!.getState().setTime(s),
    seconds,
  );
  await page.waitForTimeout(150); // let a couple of frames apply the evaluated pose
  return page.evaluate(() => (window as unknown as BasherWindow).__basher_view_camera!());
}

test.describe('#190 camera animation (viewport look-through)', () => {
  test('a keyed position channel moves the look-through view camera over time', async ({
    page,
  }) => {
    await waitReady(page);
    // t=0 keeps the authored eye [3,2,3]; t=1 dollies far out in +X.
    await addCameraChannel(page, 'cam_pos_ch', 'KeyframeChannelVec3', 'position', [
      { time: 0, value: [3, 2, 3], easing: 'linear' },
      { time: 1, value: [12, 2, 3], easing: 'linear' },
    ]);
    await lookThrough(page);

    const at0 = await poseAt(page, 0);
    const at1 = await poseAt(page, 1);
    // At t=0 the view camera sits at the keyed (== authored) eye.
    expect(at0!.position[0]).toBeCloseTo(3, 0);
    // At t=1 it has followed the channel out to x≈12 — the falsifiable signal.
    expect(at1!.position[0]).toBeCloseTo(12, 0);
    // It genuinely MOVED between the two times (not a static memoized pose).
    expect(Math.abs(at1!.position[0] - at0!.position[0])).toBeGreaterThan(5);
  });

  test('a keyed fov channel changes the look-through view camera fov over time', async ({
    page,
  }) => {
    await waitReady(page);
    await addCameraChannel(page, 'cam_fov_ch', 'KeyframeChannelNumber', 'fov', [
      { time: 0, value: 20, easing: 'linear' },
      { time: 1, value: 80, easing: 'linear' },
    ]);
    await lookThrough(page);

    const at0 = await poseAt(page, 0);
    const at1 = await poseAt(page, 1);
    expect(at0!.fov).toBeCloseTo(20, 0);
    expect(at1!.fov).toBeCloseTo(80, 0);
  });

  test('the inspector diamond keys a camera param via a free-floating channel (no layer)', async ({
    page,
  }) => {
    await waitReady(page);
    // Select the production camera so the inspector shows its sections.
    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_selection!.getState().select('n_camera'),
    );
    // The camera's fov field renders a keyframe diamond (auto, like any param).
    const diamond = page.getByTestId('inspector-diamond-n_camera-fov');
    await expect(diamond).toBeVisible();
    await diamond.click();
    await page.waitForTimeout(150);

    // The first key created a FREE-FLOATING KeyframeChannelNumber targeting the
    // camera node — NOT an AnimationLayer wrapping it (which would break
    // scene.camera + look-through). This is the #190 authoring branch.
    const shape = await page.evaluate(() => {
      const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
      const list = Object.values(nodes);
      const camChannels = list.filter(
        (n) => n.type.startsWith('KeyframeChannel') && n.params.target === 'n_camera',
      );
      return {
        channelTypes: camChannels.map((c) => c.type),
        channelPaths: camChannels.map((c) => c.params.paramPath),
        hasLayer: list.some((n) => n.type === 'AnimationLayer'),
      };
    });
    expect(shape.channelTypes).toEqual(['KeyframeChannelNumber']);
    expect(shape.channelPaths).toEqual(['fov']);
    // Falsifiable: revert the camera branch → the first key runs addLayer →
    // hasLayer is true (and scene.camera would be rewired to the layer).
    expect(shape.hasLayer).toBe(false);
  });
});
