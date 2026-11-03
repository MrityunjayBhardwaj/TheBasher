// #1776 — pressing I on an object a constraint moves keys the object's OWN transform, as Blender
// 5.1.1's Insert Keyframe does: a Track-To's aim is not written into the rotation key, and a
// Follow-Path's position is not written into the position key. Before, I keyed the drawn
// (constrained) values, which the constraint overrides anyway and which would turn into a baked
// pose the moment the constraint went away.
//
// Observed on both sides: the keys in the DAG, and that the drawn cube still follows its
// constraints after the key.

import { expect, test } from './_fixtures';
import { openInspectorSection } from './_inspectorSections';

type V3 = [number, number, number];
interface Chan {
  type: string;
  params: { target?: string; paramPath?: string; keyframes?: { time: number; value: unknown }[] };
}
interface BasherWindow {
  __basher_dag: {
    getState: () => { state: { nodes: Record<string, Chan> }; dispatch: (op: unknown) => void };
  };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_time: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_autokey: { getState: () => { enabled: boolean; toggle: () => void } };
  __basher_three: {
    getState: () => {
      scene: {
        getObjectByName: (n: string) => {
          getWorldPosition: (v: unknown) => { x: number; y: number; z: number };
          getWorldQuaternion: (q: unknown) => { x: number; y: number; z: number; w: number };
        } | null;
      } | null;
    };
  };
}
type Page = import('@playwright/test').Page;

const OWN_ROT: V3 = [10, 20, 30];

async function boot(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<BasherWindow>;
    return Boolean(w.__basher_dag && w.__basher_selection && w.__basher_time && w.__basher_three);
  });
  await page.evaluate((rot) => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    dag.dispatch({ type: 'setParam', nodeId: 'n_box', paramPath: 'rotation', value: rot });
    if (w.__basher_autokey.getState().enabled) w.__basher_autokey.getState().toggle();
    w.__basher_time.getState().pause();
    w.__basher_time.getState().setTime(0);
    w.__basher_selection.getState().select('n_box');
  }, OWN_ROT);
  await page.getByTestId('floating-toolbar-timeline').click();
}

const dispatch = (page: Page, op: unknown) =>
  page.evaluate((o) => (window as unknown as BasherWindow).__basher_dag.getState().dispatch(o), op);

const pressI = async (page: Page) => {
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_selection.getState().select('n_box');
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.keyboard.press('i');
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );
};

/** The first key on each of n_box's channels, as `paramPath` → value. */
const boxKeys = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, unknown> = {};
    const nodes = (window as unknown as BasherWindow).__basher_dag.getState().state.nodes;
    for (const n of Object.values(nodes)) {
      if (!n.type.startsWith('KeyframeChannel') || n.params.target !== 'n_box') continue;
      out[n.params.paramPath!] = n.params.keyframes?.[0]?.value;
    }
    return out;
  });

/** The drawn cube's world position and quaternion, off the viewport's own mesh seams. */
const drawnBox = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as {
      __basher_mesh_world_position: (id: string) => number[] | null;
      __basher_mesh_world_quaternion: (id: string) => number[] | null;
    };
    const pos = w.__basher_mesh_world_position('n_box');
    const quat = w.__basher_mesh_world_quaternion('n_box');
    return pos && quat ? { pos, quat } : null;
  });

const expectClose = (got: number[], want: number[], what: string) =>
  want.forEach((v, i) => expect(got[i], `${what}[${i}]`).toBeCloseTo(v, 3));

test('a cube a Track-To aims: I keys its own rotation, and it still draws aimed', async ({
  page,
}) => {
  await boot(page);
  const before = await drawnBox(page);
  await dispatch(page, {
    type: 'addNode',
    nodeId: 'tt',
    nodeType: 'TrackTo',
    params: { target: 'n_box', aimPoint: [3, -2, -5], aimNode: '' },
  });
  // The aim has taken: the drawn cube turned away from its own rotation.
  await expect
    .poll(async () => {
      const q = (await drawnBox(page))!.quat;
      return Math.abs(q.reduce((a, v, i) => a + v * before!.quat[i], 0));
    })
    .toBeLessThan(0.999);
  const aimed = (await drawnBox(page))!.quat;

  await pressI(page);
  const keys = await boxKeys(page);
  expect(Object.keys(keys).sort()).toEqual(['position', 'rotation', 'scale']);
  expectClose(keys.rotation as number[], OWN_ROT, 'rotation key = own rotation');

  // Keying changed nothing on screen: the Track-To still decides the drawn orientation.
  const after = (await drawnBox(page))!.quat;
  expect(Math.abs(after.reduce((a, v, i) => a + v * aimed[i], 0))).toBeGreaterThan(0.9999);
});

test('a cube a Follow-Path moves: I keys its own position, not the point on the path', async ({
  page,
}) => {
  await boot(page);
  const ops = [
    {
      type: 'addNode',
      nodeId: 'crv_data',
      nodeType: 'CurveData',
      params: {
        points: [
          { id: 'p0', co: [0, 0, 0] },
          { id: 'p1', co: [12, 0, 0] },
        ],
        closed: false,
        resolution: 32,
      },
    },
    { type: 'addNode', nodeId: 'crv', nodeType: 'Object', params: {} },
    {
      type: 'connect',
      from: { node: 'crv_data', socket: 'out' },
      to: { node: 'crv', socket: 'data' },
    },
    {
      type: 'connect',
      from: { node: 'crv', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
    {
      type: 'addNode',
      nodeId: 'fp',
      nodeType: 'FollowPath',
      params: { name: 'fp', target: 'n_box', curve: 'crv', evalTime: 1, offset: 0 },
    },
  ];
  for (const o of ops) await dispatch(page, o);
  await expect.poll(async () => (await drawnBox(page))!.pos[0]).toBeCloseTo(12, 2);
  const own = (await page.evaluate(
    () =>
      (
        window as unknown as {
          __basher_dag: {
            getState: () => {
              state: { nodes: Record<string, { params: { position: number[] } }> };
            };
          };
        }
      ).__basher_dag.getState().state.nodes.n_box.params.position,
  )) as number[];

  await pressI(page);
  const keys = await boxKeys(page);
  expectClose(keys.position as number[], own, 'position key = own position');
  expect(
    Math.abs((keys.position as number[])[0] - 12),
    'not the point on the path',
  ).toBeGreaterThan(1);
  await expect.poll(async () => (await drawnBox(page))!.pos[0]).toBeCloseTo(12, 2);
});

// The inspector half of #1776 (the user's call over Blender): a row a constraint decides shows
// where the object is drawn, locked, with a badge naming the constraint that links to it.
test('the inspector locks a constrained row, shows the drawn value, and links to the constraint', async ({
  page,
}) => {
  await boot(page);
  await openInspectorSection(page, 'transform');
  const lock = page.getByTestId('inspector-controlled-n_box-rotation');
  const rx = page.getByTestId('inspector-vec-n_box-rotation-x');
  // Control: no constraint, no lock, an editable row showing the own rotation.
  await expect(lock).toHaveCount(0);
  await expect(rx).not.toHaveAttribute('readonly', '');
  expect(parseFloat(await rx.inputValue())).toBeCloseTo(OWN_ROT[0], 3);

  await dispatch(page, {
    type: 'addNode',
    nodeId: 'tt',
    nodeType: 'TrackTo',
    params: { target: 'n_box', aimPoint: [3, -2, -5], aimNode: '' },
  });
  await expect(lock).toBeVisible();
  await expect(lock).toContainText('Track-To');
  await expect(rx).toHaveAttribute('readonly', '');
  // The drawn (aimed) rotation, not the own one.
  await expect
    .poll(async () => Math.abs(parseFloat(await rx.inputValue()) - OWN_ROT[0]))
    .toBeGreaterThan(1);
  // Position is not what a Track-To decides: no lock there.
  await expect(page.getByTestId('inspector-controlled-n_box-position')).toHaveCount(0);

  // Quaternion mode: the quaternion row is locked the same way.
  await dispatch(page, {
    type: 'setParam',
    nodeId: 'n_box',
    paramPath: 'rotationMode',
    value: 'quaternion',
  });
  await expect(page.getByTestId('inspector-controlled-n_box-quaternion')).toBeVisible();

  // The badge is a link: a click selects the constraint.
  await page.getByTestId('inspector-controlled-n_box-quaternion').click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __basher_selection: { getState: () => { primaryNodeId: string | null } };
            }
          ).__basher_selection.getState().primaryNodeId,
      ),
    )
    .toBe('tt');
});

test('a Follow-Path locks the position row, not the rotation row', async ({ page }) => {
  await boot(page);
  await openInspectorSection(page, 'transform');
  await dispatch(page, {
    type: 'addNode',
    nodeId: 'crv_data',
    nodeType: 'CurveData',
    params: {
      points: [
        { id: 'p0', co: [0, 0, 0] },
        { id: 'p1', co: [12, 0, 0] },
      ],
      closed: false,
      resolution: 32,
    },
  });
  for (const o of [
    { type: 'addNode', nodeId: 'crv', nodeType: 'Object', params: {} },
    {
      type: 'connect',
      from: { node: 'crv_data', socket: 'out' },
      to: { node: 'crv', socket: 'data' },
    },
    {
      type: 'connect',
      from: { node: 'crv', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
    {
      type: 'addNode',
      nodeId: 'fp',
      nodeType: 'FollowPath',
      params: { name: 'fp', target: 'n_box', curve: 'crv', evalTime: 1, offset: 0 },
    },
  ])
    await dispatch(page, o);
  await expect(page.getByTestId('inspector-controlled-n_box-position')).toContainText(
    'Follow Path',
  );
  await expect(page.getByTestId('inspector-vec-n_box-position-x')).toHaveAttribute('readonly', '');
  await expect
    .poll(async () =>
      parseFloat(await page.getByTestId('inspector-vec-n_box-position-x').inputValue()),
    )
    .toBeCloseTo(12, 2);
  await expect(page.getByTestId('inspector-controlled-n_box-rotation')).toHaveCount(0);
});
