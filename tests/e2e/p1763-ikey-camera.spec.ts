// #1763 — pressing I on a camera keys what aims it, so a keyed shot comes back (Blender 5.1.1,
// measured with its real Insert Keyframe): I on a camera keys its OWN location, rotation (in its
// rotation mode) and scale, as on any object; when a point Track-To aims it, the aim is keyed on
// the Track-To's `aimPoint`. A Track-To that follows a node gets no extra key (the node carries
// its own). Before: I keyed the computed (Track-To) orientation into the camera's rotation, which
// nothing reads, and never keyed the aim, so a re-aimed shot did not come back on scrub.
//
// Observed on both sides: the keys in the DAG, and where the look-through camera actually looks.

import { expect, test } from './_fixtures';

type V3 = [number, number, number];
type Q = [number, number, number, number];
interface Chan {
  type: string;
  params: {
    target?: string;
    paramPath?: string;
    keyframes?: { time: number; value: unknown }[];
  } & Record<string, unknown>;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, Chan> };
      dispatch: (op: unknown) => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_viewport: { getState: () => { setLookThroughCamera: (on: boolean) => void } };
  __basher_time: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_camera_gizmo_grab?: (k: 'rotate' | 'translate' | 'aim', t: V3) => void;
  __basher_view_camera: () => { position: V3; direction: V3 } | null;
}
type Page = import('@playwright/test').Page;

const settle = (page: Page) =>
  page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );

/** The default camera with its own rotation set to `rotation` (and, when given, quaternion mode),
 *  optionally aimed by a Track-To `tt` at `aimPoint` (or following `aimNode`), selected, looked
 *  through, the timeline open and the playhead at 0 s. */
async function boot(
  page: Page,
  opts: { rotation: V3; quaternion?: Q; trackTo?: { aimPoint: V3; aimNode?: string } },
) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<BasherWindow>;
    return Boolean(
      w.__basher_dag && w.__basher_selection && w.__basher_viewport && w.__basher_time,
    );
  });
  await page.evaluate((o) => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    const set = (paramPath: string, value: unknown) =>
      dag.dispatch({ type: 'setParam', nodeId: 'n_camera', paramPath, value });
    set('rotation', o.rotation);
    if (o.quaternion) {
      set('rotationMode', 'quaternion');
      set('quaternion', o.quaternion);
    }
    if (o.trackTo) {
      dag.dispatch({
        type: 'addNode',
        nodeId: 'tt',
        nodeType: 'TrackTo',
        params: {
          target: 'n_camera',
          aimPoint: o.trackTo.aimPoint,
          aimSpace: 'world',
          aimNode: o.trackTo.aimNode ?? '',
        },
      });
    }
    w.__basher_viewport.getState().setLookThroughCamera(true);
    w.__basher_time.getState().pause();
    w.__basher_time.getState().setTime(0);
    w.__basher_selection.getState().select('n_camera');
  }, opts);
  await page.getByTestId('floating-toolbar-timeline').click();
  await page.waitForFunction(() =>
    Boolean((window as unknown as BasherWindow).__basher_camera_gizmo_grab),
  );
  await settle(page);
}

const setTime = async (page: Page, s: number) => {
  await page.evaluate(
    (t) => (window as unknown as BasherWindow).__basher_time.getState().setTime(t),
    s,
  );
  await settle(page);
};

const pressI = async (page: Page) => {
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_selection.getState().select('n_camera');
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.keyboard.press('i');
  await settle(page);
};

const grab = (page: Page, kind: 'rotate' | 'aim', t: V3) =>
  page.evaluate(
    async ([k, v]) => {
      (window as unknown as BasherWindow).__basher_camera_gizmo_grab!(k, v);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    },
    [kind, t] as const,
  );

const lookDir = async (page: Page) =>
  (await page.evaluate(() => (window as unknown as BasherWindow).__basher_view_camera()!))
    .direction;

/** Every keyframe channel, as `target.paramPath` → its keys. */
const channels = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, { time: number; value: unknown }[]> = {};
    const nodes = (window as unknown as BasherWindow).__basher_dag.getState().state.nodes;
    for (const n of Object.values(nodes)) {
      if (!n.type.startsWith('KeyframeChannel')) continue;
      out[`${n.params.target}.${n.params.paramPath}`] = n.params.keyframes ?? [];
    }
    return out;
  });

const camParam = (page: Page, path: string) =>
  page.evaluate(
    (p) =>
      (window as unknown as BasherWindow).__basher_dag.getState().state.nodes.n_camera.params[p],
    path,
  );

const expectClose = (got: number[], want: number[], what: string, digits = 4) =>
  want.forEach((v, i) => expect(got[i], `${what}[${i}]`).toBeCloseTo(v, digits));

test('a camera a point Track-To aims: I keys its own transform and the aim, so the shot comes back', async ({
  page,
}) => {
  // Its own rotation is zero, so the orientation the Track-To computes (looking at the origin
  // from [3, 2, 3]) is not it: a key holding the computed one is told apart.
  await boot(page, { rotation: [0, 0, 0], trackTo: { aimPoint: [0, 0, 0] } });
  const dir0 = await lookDir(page);
  await pressI(page);

  const k0 = await channels(page);
  expect(Object.keys(k0).sort()).toEqual(
    ['n_camera.position', 'n_camera.rotation', 'n_camera.scale', 'tt.aimPoint'].sort(),
  );
  // The rotation key is the Object's own rotation, not the orientation the Track-To computes.
  expectClose(k0['n_camera.rotation'][0].value as number[], [0, 0, 0], 'rotation key');
  expectClose(k0['tt.aimPoint'][0].value as number[], [0, 0, 0], 'aimPoint key @0');

  // Re-aim at 2 s by dragging the reticle, and key again.
  await setTime(page, 2);
  await grab(page, 'aim', [4, 0, 0]);
  const dir2 = await lookDir(page);
  expect(Math.abs(dir2[0] - dir0[0]), 'the re-aim turned the camera').toBeGreaterThan(0.1);
  await pressI(page);
  const k2 = await channels(page);
  const aimKeys = k2['tt.aimPoint'];
  expect(aimKeys.map((k) => k.time)).toEqual([0, 2]);
  expectClose(aimKeys[1].value as number[], [4, 0, 0], 'aimPoint key @2');

  // Scrub back: the framing at 0 s is the one keyed there; at 2 s the re-aimed one.
  await setTime(page, 0);
  expectClose(await lookDir(page), dir0, 'look direction @0 after scrub', 3);
  await setTime(page, 2);
  expectClose(await lookDir(page), dir2, 'look direction @2 after scrub', 3);
});

test('a plain camera: I keys its own rotation, and a keyed turn comes back', async ({ page }) => {
  await boot(page, { rotation: [0, 0, 0] });
  await grab(page, 'rotate', [-10, 20, 0]);
  const rot0 = (await camParam(page, 'rotation')) as V3;
  const dir0 = await lookDir(page);
  await pressI(page);

  const k0 = await channels(page);
  expect(Object.keys(k0).sort()).toEqual(
    ['n_camera.position', 'n_camera.rotation', 'n_camera.scale'].sort(),
  );
  expectClose(k0['n_camera.rotation'][0].value as number[], rot0, 'rotation key = own rotation');

  await setTime(page, 2);
  await grab(page, 'rotate', [-30, 60, 0]);
  const dir2 = await lookDir(page);
  expect(Math.abs(dir2[0] - dir0[0]), 'the turn moved the camera').toBeGreaterThan(0.1);
  await pressI(page);
  const rotKeys = (await channels(page))['n_camera.rotation'];
  expect(rotKeys.map((k) => k.time)).toEqual([0, 2]);
  expectClose(rotKeys[1].value as number[], [-30, 60, 0], 'rotation key @2', 3);

  await setTime(page, 0);
  expectClose(await lookDir(page), dir0, 'look direction @0 after scrub', 3);
});

test('a camera in quaternion mode: I keys its quaternion, the channel that turns it', async ({
  page,
}) => {
  // A quarter turn about Y, in quaternion mode; its euler `rotation` is a decoy nothing reads.
  const s = Math.SQRT1_2;
  await boot(page, { rotation: [45, 45, 45], quaternion: [0, s, 0, s] });
  await pressI(page);
  const k0 = await channels(page);
  expect(Object.keys(k0).sort()).toEqual(
    ['n_camera.position', 'n_camera.quaternion', 'n_camera.scale'].sort(),
  );
  expectClose(k0['n_camera.quaternion'][0].value as number[], [0, s, 0, s], 'quaternion key');
});

test('control: a Track-To that follows a node gets no extra key — the node carries its own', async ({
  page,
}) => {
  await boot(page, { rotation: [0, 0, 0], trackTo: { aimPoint: [0, 0, 0], aimNode: 'n_box' } });
  await pressI(page);
  expect(Object.keys(await channels(page)).sort()).toEqual(
    ['n_camera.position', 'n_camera.rotation', 'n_camera.scale'].sort(),
  );
});
