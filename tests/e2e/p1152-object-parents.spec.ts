// #1152 — an Object can parent. In the outliner, a row dragged onto an Object moves into that
// Object's `children` and is drawn in its space, as Blender parents object to object — so a
// headlamp can hang under a car body without a Group beside it that stands for nothing.
//
// The drop target is an Object that itself hangs in the `children` hierarchy. A light Object hangs
// off `scene.lights` and is drawn through that band, which draws no children, so it refuses.
//
// HTML5 DnD is driven as p227 drives it: dragstart → dragover → drop over ONE shared DataTransfer.

import { test, expect } from './_fixtures';
import { dragRowOnto } from './_treeDrag';
import type { Page } from '@playwright/test';

interface ParentWindow {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: Record<string, { node: string }>;
        nodes: Record<string, { inputs: { children?: { node: string }[] } }>;
      };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_world_transform: (
    id: string,
  ) => { position: [number, number, number]; scale: [number, number, number] } | null;
}

const childIds = (page: Page, nodeId: string) =>
  page.evaluate((id) => {
    const s = (window as unknown as ParentWindow).__basher_dag.getState().state;
    const node = id === '__scene__' ? s.nodes[s.outputs.scene.node] : s.nodes[id];
    return (node?.inputs.children ?? []).map((c) => c.node);
  }, nodeId);

const world = (page: Page, id: string) =>
  page.evaluate((nid) => (window as unknown as ParentWindow).__basher_world_transform(nid), id);

test.beforeEach(async ({ page }) => {
  // The starter example: two boxes (`n_box`, `n_box_2`) and a light Object (`n_light`).
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('basher.lastProjectId');
    } catch {
      /* storage disabled */
    }
  });
  await page.goto('/');
  await page.getByTestId('home-open-example_starter').click();
  await expect(page.getByTestId('layout')).toBeVisible();
  // The parent is placed, turned and scaled, so a child that ignored any of the three lands
  // somewhere else: box at (0,2,0), 90° about Y, scale 2; box_2 at (1,0,0).
  await page.evaluate(() => {
    const dag = (window as unknown as ParentWindow).__basher_dag.getState();
    const set = (nodeId: string, paramPath: string, value: unknown) => ({
      type: 'setParam',
      nodeId,
      paramPath,
      value,
    });
    dag.dispatchAtomic(
      [
        set('n_box', 'position', [0, 2, 0]),
        set('n_box', 'rotation', [0, 90, 0]),
        set('n_box', 'scale', [2, 2, 2]),
        set('n_box_2', 'position', [1, 0, 0]),
        set('n_box_2', 'rotation', [0, 0, 0]),
        set('n_box_2', 'scale', [1, 1, 1]),
      ],
      'user',
      'pose',
    );
  });
});

test('a row dropped onto an Object becomes its child, drawn in its space', async ({ page }) => {
  await expect(page.getByTestId('scene-tree-row-n_box')).toBeVisible();
  await dragRowOnto(page, 'n_box_2', 'n_box');

  expect(await childIds(page, '__scene__')).not.toContain('n_box_2');
  expect(await childIds(page, 'n_box')).toEqual(['n_box_2']);
  // parent · child: (1,0,0) scaled by 2 → (2,0,0), turned 90° about Y → (0,0,-2), then + (0,2,0).
  const w = await world(page, 'n_box_2');
  expect(w!.position[0]).toBeCloseTo(0, 3);
  expect(w!.position[1]).toBeCloseTo(2, 3);
  expect(w!.position[2]).toBeCloseTo(-2, 3);
  expect(w!.scale[0]).toBeCloseTo(2, 3);

  // What three DRAWS agrees with the read: the mesh under the child's stamp sits there too.
  const drawn = await page.evaluate(() => {
    const scene = (
      window as unknown as {
        __basher_three: {
          getState: () => { scene: import('three').Scene };
        };
      }
    ).__basher_three.getState().scene;
    const found: { at: number[] | null } = { at: null };
    scene.traverse((o) => {
      if (found.at || !(o as import('three').Mesh).isMesh) return;
      for (let p: import('three').Object3D | null = o; p; p = p.parent) {
        if (p.userData?.basherNodeId === 'n_box_2') {
          o.updateWorldMatrix(true, false);
          const e = o.matrixWorld.elements;
          found.at = [e[12], e[13], e[14]];
          return;
        }
      }
    });
    return found.at;
  });
  expect(drawn).not.toBeNull();
  expect(drawn![0]).toBeCloseTo(0, 3);
  expect(drawn![1]).toBeCloseTo(2, 3);
  expect(drawn![2]).toBeCloseTo(-2, 3);

  // And the outliner shows it beneath its parent.
  await expect(page.getByTestId('scene-tree-row-n_box_2')).toBeVisible();
});

test('a light Object does not take children: it is drawn through the lights band', async ({
  page,
}) => {
  await expect(page.getByTestId('scene-tree-row-n_light')).toBeVisible();
  await dragRowOnto(page, 'n_box_2', 'n_light');
  expect(await childIds(page, 'n_light')).toEqual([]);
  expect(await childIds(page, '__scene__')).toContain('n_box_2');
});

test('an Object cannot be dropped into its own child (cycle guard)', async ({ page }) => {
  await dragRowOnto(page, 'n_box_2', 'n_box');
  expect(await childIds(page, 'n_box')).toEqual(['n_box_2']);
  await dragRowOnto(page, 'n_box', 'n_box_2');
  expect(await childIds(page, 'n_box_2')).toEqual([]);
  expect(await childIds(page, 'n_box')).toEqual(['n_box_2']);
});

test('the edges of a sibling Object reorder instead of parenting; the row shows which', async ({
  page,
}) => {
  const order = async () =>
    (await childIds(page, '__scene__')).filter((id) => id === 'n_box' || id === 'n_box_2');
  expect(await order()).toEqual(['n_box', 'n_box_2']);

  // Hovering the middle of n_box advertises "into"; its top edge advertises "before".
  const row = page.getByTestId('scene-tree-row-n_box');
  const box = (await row.boundingBox())!;
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await page.getByTestId('scene-tree-row-n_box_2').dispatchEvent('dragstart', { dataTransfer: dt });
  const hoverAt = async (f: number) => {
    await row.dispatchEvent('dragover', {
      dataTransfer: dt,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height * f,
    });
    return row.getAttribute('data-drop-zone');
  };
  expect(await hoverAt(0.5)).toBe('into');
  expect(await hoverAt(0.1)).toBe('before');
  expect(await hoverAt(0.9)).toBe('after');
  await page.getByTestId('scene-tree-row-n_box_2').dispatchEvent('dragend', { dataTransfer: dt });

  await dragRowOnto(page, 'n_box_2', 'n_box', 'before');
  expect(await order()).toEqual(['n_box_2', 'n_box']);
  expect(await childIds(page, 'n_box')).toEqual([]);

  await dragRowOnto(page, 'n_box_2', 'n_box', 'after');
  expect(await order()).toEqual(['n_box', 'n_box_2']);
  expect(await childIds(page, 'n_box')).toEqual([]);
});

// A keyed Object's draw goes through an overlay that copies its value (#1158 is where that copy once
// lost typed data under a keyed Group). The children ride on that copy, so a keyed parent Object
// must carry them, drawn and read alike, at every time.
test('a keyed parent Object carries its child, drawn and read alike', async ({ page }) => {
  await dragRowOnto(page, 'n_box_2', 'n_box');
  expect(await childIds(page, 'n_box')).toEqual(['n_box_2']);
  await page.evaluate(() => {
    const w = window as unknown as ParentWindow & {
      __basher_time: { getState: () => { pause: () => void } };
    };
    w.__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'n_box_position_channel',
          nodeType: 'KeyframeChannelVec3',
          params: {
            name: 'position',
            target: 'n_box',
            paramPath: 'position',
            keyframes: [
              { time: 0, value: [0, 2, 0], easing: 'linear' },
              { time: 2, value: [0, 6, 0], easing: 'linear' },
            ],
          },
        },
      ],
      'user',
      'key the parent',
    );
    w.__basher_time.getState().pause();
  });
  for (const [t, parentY] of [
    [0, 2],
    [1, 4],
    [2, 6],
  ] as const) {
    await page.evaluate(
      (s) =>
        (
          window as unknown as {
            __basher_time: { getState: () => { setTime: (s: number) => void } };
          }
        ).__basher_time
          .getState()
          .setTime(s),
      t,
    );
    // The child's local (1,0,0) under the parent's 90° turn and scale 2 is (0,0,-2) from it.
    const read = await page.evaluate(
      (s) =>
        (
          window as unknown as {
            __basher_world_transform: (
              id: string,
              ctx: unknown,
            ) => { position: [number, number, number] } | null;
          }
        ).__basher_world_transform('n_box_2', {
          time: { frame: s * 60, seconds: s, normalized: 0 },
        }),
      t,
    );
    expect(read!.position[1]).toBeCloseTo(parentY, 3);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const scene = (
            window as unknown as {
              __basher_three: { getState: () => { scene: import('three').Scene } };
            }
          ).__basher_three.getState().scene;
          let y: number | null = null;
          scene.traverse((o) => {
            if (y !== null || !(o as import('three').Mesh).isMesh) return;
            if (o.parent?.userData?.basherNodeId !== 'n_box_2') return;
            o.updateWorldMatrix(true, false);
            y = o.matrixWorld.elements[13];
          });
          return y;
        }),
      )
      .toBeCloseTo(parentY, 3);
  }
});
