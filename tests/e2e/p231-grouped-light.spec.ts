// #231 Inc 2a — groupable/parentable LIGHTS. The unified 'SceneObject' socket
// (Inc 1) lets a light wire into Group.children; this boundary-pair proves a
// nested light RENDERS at the group-composed world (side A, the real three.js
// light's world position) == the pure resolveWorldTransform (side B). It
// falsifies "the type compiles but the light doesn't actually move with the
// group": revert MeshChild's light case or the GroupValue.children widening and
// side A loses the light at [6,0,0].
//
// Side A: __basher_light_world_positions() — every rendered THREE.Light's world
//   position (a nested light has no name to address by id, so we look for one at
//   the composed position).
// Side B: __basher_world_transform(lightId) — the pure resolver, which descends
//   Group.children and composes the group's transform onto the light's local.

import { expect, test } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => { dispatch: (op: unknown) => void };
  };
  __basher_world_transform?: (
    nodeId: string,
  ) => { position: number[]; scale: number[] } | null;
  __basher_light_world_positions?: () => [number, number, number][];
}

const GRP_ID = 'n_p231_grp';
const LIGHT_ID = 'n_p231_light';
const GROUP_X = 5;
const LIGHT_LOCAL_X = 1;
const WORLD_X = GROUP_X + LIGHT_LOCAL_X; // 6

test.describe('#231 Inc 2a — grouped light boundary-pair', () => {
  test('a light nested in a Group renders at the group-composed world == resolver', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      return Boolean(w.__basher_dag && w.__basher_light_world_positions);
    });

    // Build: scene.children → Group(pos [5,0,0]) → children:[DirectionalLight(local [1,0,0])].
    await page.evaluate(
      ({ grpId, lightId, groupX, lightX }) => {
        const w = window as unknown as BasherWindow;
        const dispatch = (op: unknown) => w.__basher_dag!.getState().dispatch(op);
        dispatch({
          type: 'addNode',
          nodeId: grpId,
          nodeType: 'Group',
          params: { position: [groupX, 0, 0] },
        });
        dispatch({
          type: 'addNode',
          nodeId: lightId,
          nodeType: 'DirectionalLight',
          params: { intensity: 1, position: [lightX, 0, 0], color: '#ffffff' },
        });
        dispatch({
          type: 'connect',
          from: { node: lightId, socket: 'out' },
          to: { node: grpId, socket: 'children' },
        });
        dispatch({
          type: 'connect',
          from: { node: grpId, socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        });
      },
      { grpId: GRP_ID, lightId: LIGHT_ID, groupX: GROUP_X, lightX: LIGHT_LOCAL_X },
    );

    // Side A — wait for the render to mount the nested light at the composed world.
    await page.waitForFunction(
      (worldX) => {
        const w = window as unknown as BasherWindow;
        const positions = w.__basher_light_world_positions?.() ?? [];
        return positions.some((p) => Math.abs(p[0] - worldX) < 1e-2 && Math.abs(p[1]) < 1e-2);
      },
      WORLD_X,
    );

    const { sideA, sideB } = await page.evaluate(
      ({ lightId, worldX }) => {
        const w = window as unknown as BasherWindow;
        const positions = w.__basher_light_world_positions?.() ?? [];
        const sideA = positions.find((p) => Math.abs(p[0] - worldX) < 1e-2) ?? null;
        const sideB = w.__basher_world_transform?.(lightId) ?? null;
        return { sideA, sideB };
      },
      { lightId: LIGHT_ID, worldX: WORLD_X },
    );

    // Side A: a light is rendered at the group-composed world.
    expect(sideA).not.toBeNull();
    expect(sideA![0]).toBeCloseTo(WORLD_X, 1);
    // Side B: the pure resolver agrees (render == resolver, H40).
    expect(sideB).not.toBeNull();
    expect(sideB!.position[0]).toBeCloseTo(WORLD_X, 1);
    expect(sideB!.position[0]).toBeCloseTo(sideA![0], 1);
  });
});
