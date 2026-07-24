// #240 / #241 ([[V85]] / [[H132]]) — an editor VISUAL of an animatable object must
// FOLLOW the object's evaluated pose at the live playhead, the same way meshes /
// lights / the look-through camera do (their per-frame `DirectChannels*` overlays).
// Before the fix the camera frustum (`CameraHelper`) and light wireframe helpers
// (`LightHelper`) rendered the STATIC frame-0 channel-blind read with no follower,
// so they froze at frame 0 while the gizmo + real object moved (the render-source
// split). This drives the LIVE app (Lokayata) and reads the rendered helper's pose
// via the DEV seams (`__basher_frustum_pose` / `__basher_lighthelper_value`).
//
// FALSIFIABLE: each assertion checks the MOVED value (x≈12 / x≈-9 / x≈20), distinct
// from the frame-0 value (x≈3 / x≈5) — a frozen helper makes them RED.

import { expect, test } from './_fixtures';
import { splitCubeOps } from './_splitCube';
import { splitLightOps } from './_splitLight';

interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void;
    };
  };
  __basher_time?: { getState: () => { setTime: (seconds: number) => void } };
  __basher_frustum_pose?: Record<string, { position: [number, number, number] }>;
  __basher_lighthelper_value?: Record<
    string,
    { position: [number, number, number]; lookAt?: [number, number, number] }
  >;
  __basher_mesh_world_position?: (id: string) => [number, number, number] | null;
}

async function addVec3Channel(
  page: import('@playwright/test').Page,
  id: string,
  target: string,
  paramPath: string,
  keyframes: unknown[],
) {
  await page.evaluate(
    ({ id, target, paramPath, keyframes }) => {
      (window as unknown as W).__basher_dag.getState().dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: id,
            nodeType: 'KeyframeChannelVec3',
            params: { name: paramPath, target, paramPath, keyframes },
          },
        ],
        'e2e',
        'add channel',
      );
    },
    { id, target, paramPath, keyframes },
  );
}

async function setTime(page: import('@playwright/test').Page, seconds: number) {
  await page.evaluate(
    (s) => (window as unknown as W).__basher_time!.getState().setTime(s),
    seconds,
  );
  await page.waitForTimeout(200); // let the per-frame follower apply the evaluated pose
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_dag?.getState()?.state?.outputs?.scene && w.__basher_time);
  });
});

test('#240 — an animated camera frustum follows the playhead (not frozen at frame 0)', async ({
  page,
}) => {
  await addVec3Channel(page, 'cam_pos_ch', 'n_camera', 'position', [
    { time: 0, value: [3, 2, 3], easing: 'linear' },
    { time: 1, value: [12, 2, 3], easing: 'linear' },
  ]);
  await setTime(page, 0);
  const at0 = await page.evaluate(
    () => (window as unknown as W).__basher_frustum_pose?.['n_camera']?.position ?? null,
  );
  await setTime(page, 1);
  const at1 = await page.evaluate(
    () => (window as unknown as W).__basher_frustum_pose?.['n_camera']?.position ?? null,
  );
  expect(at0).not.toBeNull();
  expect(at0![0]).toBeCloseTo(3, 0);
  expect(at1![0]).toBeCloseTo(12, 0); // followed the channel, not frozen at 3
});

test('#240 — editing the camera channel AT the current frame moves the frustum same-frame (the reported gizmo-drag scenario; channel-blind defect)', async ({
  page,
}) => {
  // The literal report: an animated camera, a gizmo edit at frame > 0 moves the
  // real camera but not the frustum — because the OLD frustum resolver was
  // channel-BLIND (read raw params, ignored the keyframe channel the gizmo writes).
  // Here we edit the channel keyframe at the current frame (what routeAnimatedGrab
  // does) WITHOUT scrubbing, and assert the frustum tracks it on the same frame.
  await addVec3Channel(page, 'cam_pos_ch2', 'n_camera', 'position', [
    { time: 0, value: [3, 2, 3], easing: 'linear' },
    { time: 1, value: [12, 2, 3], easing: 'linear' },
  ]);
  await setTime(page, 1);
  const before = await page.evaluate(
    () => (window as unknown as W).__basher_frustum_pose?.['n_camera']?.position ?? null,
  );
  expect(before![0]).toBeCloseTo(12, 0);
  // Re-key t=1 → x=20 (the channel edit a gizmo drag at this frame produces).
  await page.evaluate(() =>
    (window as unknown as W).__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: 'cam_pos_ch2',
          paramPath: 'keyframes',
          value: [
            { time: 0, value: [3, 2, 3], easing: 'linear' },
            { time: 1, value: [20, 2, 3], easing: 'linear' },
          ],
        },
      ],
      'e2e',
      'rekey',
    ),
  );
  await page.waitForTimeout(200); // no scrub — the follower re-samples on state change
  const after = await page.evaluate(
    () => (window as unknown as W).__basher_frustum_pose?.['n_camera']?.position ?? null,
  );
  expect(after).not.toBeNull();
  expect(after![0]).toBeCloseTo(20, 0); // frustum followed the same-frame channel edit, not stuck at 12
});

test('#241 — an animated light wireframe helper follows the playhead', async ({ page }) => {
  await addVec3Channel(page, 'light_pos_ch', 'n_light', 'position', [
    { time: 0, value: [5, 5, 5], easing: 'linear' },
    { time: 1, value: [-9, 5, 5], easing: 'linear' },
  ]);
  await setTime(page, 0);
  const at0 = await page.evaluate(
    () => (window as unknown as W).__basher_lighthelper_value?.['n_light']?.position ?? null,
  );
  await setTime(page, 1);
  const at1 = await page.evaluate(
    () => (window as unknown as W).__basher_lighthelper_value?.['n_light']?.position ?? null,
  );
  expect(at0).not.toBeNull();
  expect(at0![0]).toBeCloseTo(5, 0);
  expect(at1![0]).toBeCloseTo(-9, 0); // followed the channel, not frozen at 5
});

test('#242 GAP 1 — a camera frustum follows an ANIMATED ANCESTOR Group (its own params static)', async ({
  page,
}) => {
  // The camera itself is NOT keyframed. It is nested under a Group whose POSITION is
  // keyed (x 0 -> 10). The frustum is a SEPARATE top-level visual (not in the Group's
  // render subtree), so before the fix its mount gate (the camera's OWN channels /
  // constraints) never fired and it fell to the static frame-0 read -> frozen at the
  // ancestor's frame-0 world. A nested MESH follows for free (the Group's
  // DirectChannelsR re-renders its whole subtree), so it is the control here.
  // FALSIFIABLE: a frozen frustum stays at x=3; the fix makes it x=13 (base 3 + Δ10).
  // #365 Slice 2: the nested control mesh is a split cube (Object → BoxData); the
  // Object keeps the id `anc_box`, so the `out → anc_grp children` connect and the
  // world-position read are unchanged.
  const ancBoxOps = splitCubeOps({
    objectId: 'anc_box',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    color: '#88f',
  });
  await page.evaluate((boxOps) => {
    const dag = (window as unknown as W).__basher_dag.getState();
    const scene = dag.state.outputs.scene!.node;
    dag.dispatchAtomic(
      [
        ...boxOps,
        {
          type: 'addNode',
          nodeId: 'anc_grp',
          nodeType: 'Group',
          params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], pivot: [0, 0, 0] },
        },
        {
          type: 'addNode',
          nodeId: 'anc_grp_pos',
          nodeType: 'KeyframeChannelVec3',
          params: {
            name: 'position',
            target: 'anc_grp',
            paramPath: 'position',
            keyframes: [
              { time: 0, value: [0, 0, 0], easing: 'linear' },
              { time: 1, value: [10, 0, 0], easing: 'linear' },
            ],
          },
        },
        {
          type: 'connect',
          from: { node: 'anc_box', socket: 'out' },
          to: { node: 'anc_grp', socket: 'children' },
        },
        // groupable camera: stays wired to scene.camera AND becomes a Group child
        {
          type: 'connect',
          from: { node: 'n_camera', socket: 'out' },
          to: { node: 'anc_grp', socket: 'children' },
        },
        {
          type: 'connect',
          from: { node: 'anc_grp', socket: 'out' },
          to: { node: scene, socket: 'children' },
        },
      ],
      'e2e',
      'camera under animated group',
    );
  }, ancBoxOps);

  await setTime(page, 0);
  const read = async () =>
    page.evaluate(() => {
      const w = window as unknown as W;
      return {
        // the Group is the named top-level wrapper; its first descendant Mesh is anc_box
        mesh: w.__basher_mesh_world_position?.('anc_grp') ?? null,
        cam: w.__basher_frustum_pose?.['n_camera']?.position ?? null,
      };
    });
  const at0 = await read();
  await setTime(page, 1);
  const at1 = await read();

  // control: the nested mesh follows the animated ancestor (x 0 -> 10)
  expect(at0.mesh).not.toBeNull();
  expect(at0.mesh![0]).toBeCloseTo(0, 0);
  expect(at1.mesh![0]).toBeCloseTo(10, 0);
  // the gap: the camera frustum follows too (base x=3 + ancestor Δ10 = 13), not frozen at 3
  expect(at0.cam).not.toBeNull();
  expect(at0.cam![0]).toBeCloseTo(3, 0);
  expect(at1.cam![0]).toBeCloseTo(13, 0);
});

test("#243 GAP 2 — a Track-To'd AreaLight helper aim follows an ANIMATED target", async ({
  page,
}) => {
  // An AreaLight Track-To'd at an ANIMATED node (x 5 -> -5). The lit RectAreaLight
  // re-resolves its aim per frame (useAreaLightAim), but the wireframe helper read
  // value.lookAt — the AUTHORED aim — so it froze while the lit effect tracked the
  // target. The fix re-resolves the SAME Track-To aim at `seconds` in the follower.
  // FALSIFIABLE: a frozen helper keeps lookAt = authored [0,0,0]; the fix makes it
  // track the target ([5,0,0] -> [-5,0,0]).
  // #365 Slice 2: the Track-To aim target is a split cube; the Object keeps `tt_aim`.
  const ttAimOps = splitCubeOps({
    objectId: 'tt_aim',
    position: [5, 0, 0],
    rotation: [0, 0, 0],
    color: '#f80',
  });
  // #386 C3: the aimed light is split too — `tt_area` names the OBJECT, so the Track-To
  // target and the helper's subject id are the same ids they were when the light was fused.
  const ttSetupOps = [
    ...ttAimOps,
    ...splitLightOps({
      objectId: 'tt_area',
      lightKind: 'Area',
      position: [0, 4, 0],
      shading: { intensity: 5, color: '#ffffff', width: 2, height: 2, lookAt: [0, 0, 0] },
    }),
  ];
  await page.evaluate((boxOps) => {
    const dag = (window as unknown as W).__basher_dag.getState();
    const scene = dag.state.outputs.scene!.node;
    dag.dispatchAtomic(
      [
        ...boxOps,
        {
          type: 'connect',
          from: { node: 'tt_aim', socket: 'out' },
          to: { node: scene, socket: 'children' },
        },
        {
          type: 'addNode',
          nodeId: 'tt_aim_pos',
          nodeType: 'KeyframeChannelVec3',
          params: {
            name: 'position',
            target: 'tt_aim',
            paramPath: 'position',
            keyframes: [
              { time: 0, value: [5, 0, 0], easing: 'linear' },
              { time: 1, value: [-5, 0, 0], easing: 'linear' },
            ],
          },
        },
        {
          type: 'connect',
          from: { node: 'tt_area', socket: 'out' },
          to: { node: scene, socket: 'lights' },
        },
        {
          type: 'addNode',
          nodeId: 'tt_trackto',
          nodeType: 'TrackTo',
          params: { target: 'tt_area', aimNode: 'tt_aim', aimPoint: [0, 0, 0], up: [0, 1, 0] },
        },
      ],
      'e2e',
      'area light track-to animated target',
    );
  }, ttSetupOps);

  await setTime(page, 0);
  const at0 = await page.evaluate(
    () => (window as unknown as W).__basher_lighthelper_value?.['tt_area']?.lookAt ?? null,
  );
  await setTime(page, 1);
  const at1 = await page.evaluate(
    () => (window as unknown as W).__basher_lighthelper_value?.['tt_area']?.lookAt ?? null,
  );
  expect(at0).not.toBeNull();
  expect(at0![0]).toBeCloseTo(5, 0); // aim resolves to the target's frame-0 position
  expect(at1![0]).toBeCloseTo(-5, 0); // followed the animated target, not frozen at authored 0
});
