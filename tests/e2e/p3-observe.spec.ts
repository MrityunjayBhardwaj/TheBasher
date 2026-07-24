import { test, expect } from './_fixtures';
import { seedCubeObjectId } from './_seedNodes';

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
  // v0.7 #199 / V57: the channel overlay lives in the RESOLVER, not in a node's
  // evaluate() value (a free-floating channel never feeds an input socket). The
  // animated transform is read through resolveEvaluatedTransform — the SAME band
  // the renderer (DirectChannelsR) consumes — exposed as this dev seam.
  __basher_evaluated_transform: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { position: [number, number, number] } | null;
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
    return Boolean(w.__basher_dag && w.__basher_evaluated_transform);
  });
});

test('OBSERVE: cube position at t=0 vs t=1 differs after wiring an animation channel', async ({
  page,
}) => {
  // The seed cube's Object — the channel below targets `position`, a transform param,
  // which the Object owns after the object↔data split. Addressed by what it POSES: the
  // default project now holds several `Object`s, so "the first one" is not the cube (#461).
  const boxId = await seedCubeObjectId(page);

  const observed = await page.evaluate((boxId) => {
    const w = window as unknown as BasherWindow;
    // H10/H19: never cache state across dispatches.
    const dispatch = (op: unknown) => w.__basher_dag.getState().dispatch(op);
    const nodes = () => w.__basher_dag.getState().state.nodes;

    if (!Object.values(nodes()).some((n) => n.type === 'TimeSource')) {
      dispatch({ type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} });
    }
    const timeId = Object.entries(nodes()).find(([, n]) => n.type === 'TimeSource')?.[0];
    if (!timeId) throw new Error('no TimeSource after dispatch');
    const sceneId = Object.entries(nodes()).find(([, n]) => n.type === 'Scene')?.[0];
    if (!sceneId) throw new Error('no Scene');

    // V57: a free-floating direct channel targets the box by dagId. No
    // AnimationLayer wrapper, no scene rewire — the box stays its own scene
    // child and overlayChannels applies the keyframed position on top.
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

    // Read the box's EVALUATED transform through the resolver seam at t=0 vs
    // t=1 — the channel overlay is applied by resolveEvaluatedTransform (the
    // band the renderer consumes), not by the node's raw evaluate() value.
    void sceneId;
    const t0 = w.__basher_evaluated_transform(boxId, {
      time: { frame: 0, seconds: 0, normalized: 0 },
    });
    const t1 = w.__basher_evaluated_transform(boxId, {
      time: { frame: 60, seconds: 1, normalized: 0.1 },
    });
    return { target0: t0?.position, target1: t1?.position };
  }, boxId);

  console.log('OBSERVED:', JSON.stringify(observed));
  expect(observed.target0).toEqual([0, 0, 0]);
  expect(observed.target1).toEqual([0, 2, 0]);
});
