import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<
          string,
          {
            type: string;
            inputs: Record<
              string,
              { node: string; socket: string } | { node: string; socket: string }[]
            >;
          }
        >;
        outputs: Record<string, { node: string; socket: string }>;
      };
      dispatch: (op: unknown) => void;
    };
  };
  __basher_evaluate: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { value: unknown };
  __basher_viewport: { getState: () => { timelineDrawerOpen: boolean } };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* OPFS entry absent on first run — nothing to clear */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_evaluate);
  });
});

test('OBSERVE: cube position at t=0 vs t=1 differs after wiring an animation channel', async ({
  page,
}) => {
  const observed = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    // H10/H19: never cache state across dispatches.
    const dispatch = (op: unknown) => w.__basher_dag.getState().dispatch(op);
    const nodes = () => w.__basher_dag.getState().state.nodes;

    const boxId = Object.entries(nodes()).find(([, n]) => n.type === 'BoxMesh')?.[0];
    if (!boxId) throw new Error('no BoxMesh');

    if (!Object.values(nodes()).some((n) => n.type === 'TimeSource')) {
      dispatch({ type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} });
    }
    const timeId = Object.entries(nodes()).find(([, n]) => n.type === 'TimeSource')?.[0];
    if (!timeId) throw new Error('no TimeSource after dispatch');
    const sceneId = Object.entries(nodes()).find(([, n]) => n.type === 'Scene')?.[0];
    if (!sceneId) throw new Error('no Scene');

    dispatch({
      type: 'addNode',
      nodeId: 'box_layer',
      nodeType: 'AnimationLayer',
      params: { name: 'Bounce', mute: false, solo: false, weight: 1, boneMask: [] },
    });
    dispatch({
      type: 'disconnect',
      from: { node: boxId, socket: 'out' },
      to: { node: sceneId, socket: 'children' },
    });
    dispatch({
      type: 'connect',
      from: { node: 'box_layer', socket: 'out' },
      to: { node: sceneId, socket: 'children' },
    });
    dispatch({
      type: 'connect',
      from: { node: boxId, socket: 'out' },
      to: { node: 'box_layer', socket: 'target' },
    });

    dispatch({
      type: 'addNode',
      nodeId: 'pos_ch',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'pos',
        target: boxId,
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 1, value: [0, 2, 0], easing: 'linear' },
        ],
      },
    });
    // P7.12 D-04: channel has no `time` socket — connect removed.
    dispatch({
      type: 'connect',
      from: { node: 'pos_ch', socket: 'out' },
      to: { node: 'box_layer', socket: 'animation' },
    });

    const eval0 = w.__basher_evaluate(sceneId, { time: { frame: 0, seconds: 0, normalized: 0 } })
      .value as {
      children: Array<{
        kind: string;
        target?: { kind: string; position: [number, number, number] };
        position?: [number, number, number];
      }>;
    };
    const eval1 = w.__basher_evaluate(sceneId, { time: { frame: 60, seconds: 1, normalized: 0.1 } })
      .value as typeof eval0;

    // Find the AnimationLayer wrapping our cube in scene.children
    const layerAt = (scene: typeof eval0) =>
      scene.children.find((c) => c.kind === 'AnimationLayer');
    const layer0 = layerAt(eval0);
    const layer1 = layerAt(eval1);
    return {
      kind0: layer0?.kind,
      target0: layer0?.target?.position,
      kind1: layer1?.kind,
      target1: layer1?.target?.position,
    };
  });

  console.log('OBSERVED:', JSON.stringify(observed));
  expect(observed.kind0).toBe('AnimationLayer');
  expect(observed.kind1).toBe('AnimationLayer');
  expect(observed.target0).toEqual([0, 0, 0]);
  expect(observed.target1).toEqual([0, 2, 0]);
});
