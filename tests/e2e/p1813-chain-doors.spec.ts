// #1813 — the doors in the running app. The Influence row takes a number and a key through the panel
// and the object moves; under an uneven parent the viewport draws what the chain says, not what a
// position, a rotation and a scale could hold.

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitCubeOps } from './_splitCube';

type V3 = [number, number, number];
interface W {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { params: Record<string, unknown> }>;
        outputs: { scene?: { node: string } };
      };
      dispatch: (op: unknown, source: string, description: string) => void;
      dispatchAtomic: (ops: unknown[], source: string, description: string) => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_time: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_mesh_world_position: (id: string) => number[] | null;
}

async function boot(page: Page) {
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
    const w = window as unknown as Partial<W>;
    return Boolean(
      w.__basher_dag?.getState().state.outputs.scene && w.__basher_mesh_world_position,
    );
  });
}

const expectAt = async (page: Page, id: string, want: V3) =>
  expect
    .poll(
      async () => {
        const got = await page.evaluate(
          (i) => (window as unknown as W).__basher_mesh_world_position(i),
          id,
        );
        return got ? Math.max(...got.map((v, k) => Math.abs(v - want[k]))) : Infinity;
      },
      { message: `${id} drawn at ${want}` },
    )
    .toBeLessThan(0.01);

test('the Influence row: a number blends the object, and the same number takes a key', async ({
  page,
}) => {
  await boot(page);
  // n_box at its own (0, 4, 0), on the end of a line to (10, 0, 0) turned 90° about Z: drawn at
  // (-4, 10, 0), and half way at Blender 5.1.1's (-2, 7, 0).
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__basher_time.getState().pause();
    w.__basher_time.getState().setTime(0);
    const sceneId = w.__basher_dag.getState().state.outputs.scene!.node;
    const d = (op: unknown) => w.__basher_dag.getState().dispatch(op, 'user', 'e2e');
    d({ type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [0, 4, 0] });
    d({
      type: 'addNode',
      nodeId: 'e_cd',
      nodeType: 'CurveData',
      params: {
        points: [
          { id: 'cp0', co: [0, 0, 0] },
          { id: 'cp1', co: [10, 0, 0] },
        ],
        closed: false,
        resolution: 32,
      },
    });
    d({ type: 'addNode', nodeId: 'e_c', nodeType: 'Object', params: { rotation: [0, 0, 90] } });
    d({
      type: 'connect',
      from: { node: 'e_cd', socket: 'out' },
      to: { node: 'e_c', socket: 'data' },
    });
    d({
      type: 'connect',
      from: { node: 'e_c', socket: 'out' },
      to: { node: sceneId, socket: 'children' },
    });
    d({
      type: 'addNode',
      nodeId: 'e_f',
      nodeType: 'FollowPath',
      params: { target: 'n_box', curve: 'e_c', evalTime: 1 },
    });
    w.__basher_selection.getState().select('e_f');
  });
  await expectAt(page, 'n_box', [-4, 10, 0]);

  const input = page.getByTestId('constraint-influence-input');
  await input.scrollIntoViewIfNeeded();
  await input.fill('0.5');
  await expectAt(page, 'n_box', [-2, 7, 0]);

  // It is now the Value node's own row, and a key on that number moves the object over time.
  await expect(input).toHaveCount(0);
  const valueId = await page.evaluate(() => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    return Object.keys(nodes).find((id) => id === 'e_f_influence_value')!;
  });
  expect(valueId).toBe('e_f_influence_value');
  await page.evaluate((target) => {
    const w = window as unknown as W;
    w.__basher_dag.getState().dispatch(
      {
        type: 'addNode',
        nodeId: 'e_key',
        nodeType: 'KeyframeChannelNumber',
        params: {
          target,
          paramPath: 'value',
          keyframes: [
            { time: 0, value: 0 },
            { time: 1, value: 0.5 },
          ],
        },
      },
      'user',
      'e2e',
    );
  }, valueId);
  await expectAt(page, 'n_box', [0, 4, 0]);
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(1));
  await expectAt(page, 'n_box', [-2, 7, 0]);
});

test('an aim under an uneven parent draws what the chain says, its child included', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(
    (cubes) => {
      const w = window as unknown as W;
      w.__basher_time.getState().pause();
      w.__basher_time.getState().setTime(0);
      const sceneId = w.__basher_dag.getState().state.outputs.scene!.node;
      const wire = (from: string, socket: string, node: string, into: string) => ({
        type: 'connect',
        from: { node: from, socket },
        to: { node, socket: into },
      });
      w.__basher_dag.getState().dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: 'e_g',
            nodeType: 'Group',
            params: { position: [1, 2, 3], rotation: [40, 0, 25], scale: [1, 3, 1] },
          },
          wire('e_g', 'out', sceneId, 'children'),
          ...cubes,
          wire('e_h', 'out', sceneId, 'children'),
          wire('e_a', 'out', sceneId, 'children'),
          wire('e_k', 'out', sceneId, 'children'),
          wire('e_g', 'world', 'e_a', 'parent'),
          wire('e_a', 'world', 'e_k', 'parent'),
          {
            type: 'addNode',
            nodeId: 'e_t',
            nodeType: 'TrackTo',
            params: { target: 'e_a', aimNode: 'e_h' },
          },
        ],
        'user',
        'e2e',
      );
    },
    [
      ...splitCubeOps({ objectId: 'e_h', position: [4, 0, 0] }),
      ...splitCubeOps({ objectId: 'e_a', position: [0, 1, 0], scale: [2, 1, 1] }),
      ...splitCubeOps({ objectId: 'e_k', position: [1, 0, 0] }),
    ],
  );
  // The same numbers `constraintChains.migration.test.ts` reads off the chain.
  await expectAt(page, 'e_a', [-0.268, 4.083, 4.748]);
  await expectAt(page, 'e_k', [1.22, 4.083, 6.085]);
});
