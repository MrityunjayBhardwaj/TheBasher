// #1811 — a wired constraint chain in the running app: an object's world output is where its chain
// ends, at Blender 5.1.1's numbers; the closing wire of a mutual aim is refused and the aim target
// reference closes it; a key on a compute node's setting reaches what the node drives.
//
// Nothing draws from a chain yet, so the drawn object doesn't move: that is checked too, so this
// spec goes red the day the renderer starts reading chains and the claim needs changing.

import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState(): {
      state: { outputs: { scene?: { node: string } } };
      dispatch: (op: unknown, src: string, d: string) => void;
    };
  };
}

test('a chain ends at the object, as Blender places it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as Partial<W>).__basher_dag?.getState().state.outputs.scene),
  );

  const result = await page.evaluate(async () => {
    const w = window as unknown as W;
    const store = w.__basher_dag.getState();
    const d = (op: unknown) => w.__basher_dag.getState().dispatch(op, 'user', 'e2e');
    const wire = (from: string, socket: string, node: string, into: string) =>
      d({ type: 'connect', from: { node: from, socket }, to: { node, socket: into } });
    const sceneId = store.state.outputs.scene!.node;
    // Blender's `fp_then_tt`: an empty at (0, 4, 0), Follow Path to the end of a line to (10, 0, 0),
    // then a Track-To at (10, 10, 0).
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
    d({ type: 'addNode', nodeId: 'e_c', nodeType: 'Object', params: {} });
    wire('e_cd', 'out', 'e_c', 'data');
    wire('e_c', 'out', sceneId, 'children');
    d({ type: 'addNode', nodeId: 'e_a', nodeType: 'Null', params: { position: [0, 4, 0] } });
    wire('e_a', 'out', sceneId, 'children');
    d({ type: 'addNode', nodeId: 'e_own', nodeType: 'OwnWorld', params: { object: 'e_a' } });
    d({ type: 'addNode', nodeId: 'e_fp', nodeType: 'FollowPath', params: { evalTime: 1 } });
    d({
      type: 'addNode',
      nodeId: 'e_tt',
      nodeType: 'TrackTo',
      params: { aimPoint: [10, 10, 0], up: [0, 0, 1] },
    });
    wire('e_own', 'world', 'e_fp', 'in');
    wire('e_c', 'world', 'e_fp', 'curve');
    wire('e_fp', 'world', 'e_tt', 'in');
    wire('e_tt', 'world', 'e_a', 'constraints');

    const ev = await import('/src/core/dag/evaluator.ts');
    const state = () => w.__basher_dag.getState().state as never;
    const m = ev.evaluate(state(), 'e_a', { socket: 'world' }).value as number[];
    const own = ev.evaluate(state(), 'e_own', { socket: 'world' }).value as number[];
    const drawn = ev.evaluate(state(), 'e_a').value as { position: number[] };

    // A second object aiming back at the first: the wire that closes the loop is refused.
    d({ type: 'addNode', nodeId: 'e_b', nodeType: 'Null', params: {} });
    d({ type: 'addNode', nodeId: 'e_ttb', nodeType: 'TrackTo', params: {} });
    wire('e_a', 'world', 'e_ttb', 'aim');
    wire('e_ttb', 'world', 'e_b', 'constraints');
    let refused = '';
    const nodesBefore = w.__basher_dag.getState().state;
    try {
      wire('e_b', 'world', 'e_tt', 'aim');
    } catch (e) {
      refused = String(e);
    }
    const aimWire = (
      w.__basher_dag.getState().state as never as {
        nodes: Record<string, { inputs: Record<string, unknown> }>;
      }
    ).nodes.e_tt.inputs.aim;
    return {
      position: [m[12], m[13], m[14]],
      forward: [-m[8], -m[9], -m[10]],
      ownPosition: [own[12], own[13], own[14]],
      drawnPosition: drawn.position,
      refused,
      aimWire: aimWire ?? null,
      unchanged: nodesBefore === w.__basher_dag.getState().state,
    };
  });

  // Blender 5.1.1: at (10, 4, 0), looking along +Y.
  expect(result.position[0]).toBeCloseTo(10, 4);
  expect(result.position[1]).toBeCloseTo(4, 4);
  expect(result.position[2]).toBeCloseTo(0, 4);
  expect(result.forward[0]).toBeCloseTo(0, 4);
  expect(result.forward[1]).toBeCloseTo(1, 4);
  expect(result.forward[2]).toBeCloseTo(0, 4);
  // The bottom of the chain still reads the object before it, and its own transform is untouched.
  expect(result.ownPosition).toEqual([0, 4, 0]);
  expect(result.drawnPosition).toEqual([0, 4, 0]);
  // The loop never landed, whichever way the store reports a refusal.
  expect(result.aimWire).toBeNull();
  console.log('mutual aim:', result.refused || '(no throw)', 'unchanged:', result.unchanged);
  expect(errors).toEqual([]);
});

test('two objects aim at each other by reference, and a key on Mix drives an object', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as Partial<W>).__basher_dag?.getState().state.outputs.scene),
  );

  const result = await page.evaluate(async () => {
    const w = window as unknown as W;
    const sceneId = w.__basher_dag.getState().state.outputs.scene!.node;
    const d = (op: unknown) => w.__basher_dag.getState().dispatch(op, 'user', 'e2e');
    const wire = (from: string, socket: string, node: string, into: string) =>
      d({ type: 'connect', from: { node: from, socket }, to: { node, socket: into } });
    const add = (nodeId: string, nodeType: string, params: object = {}) =>
      d({ type: 'addNode', nodeId, nodeType, params });
    const aim = (object: string, at: number[], other: string) => {
      add(object, 'Null', { position: at });
      wire(object, 'out', sceneId, 'children');
      add(`${object}_own`, 'OwnWorld', { object });
      add(`${object}_tt`, 'TrackTo', { up: [0, 1, 0], target: object, aimNode: other });
      wire(`${object}_own`, 'world', `${object}_tt`, 'in');
      wire(`${object}_tt`, 'world', object, 'constraints');
    };
    aim('e_a', [1, 0, 0], 'e_b');
    aim('e_b', [3, 3, 0], 'e_a');

    // A Null driven by a Mix whose factor is keyed 0 to 1 over a second.
    add('e_ten', 'Clamp', { min: 10, max: 10 });
    add('e_mix', 'Mix', { dataType: 'Number', factor: 0 });
    wire('e_ten', 'out', 'e_mix', 'b');
    add('e_key', 'KeyframeChannelNumber', {
      target: 'e_mix',
      paramPath: 'factor',
      keyframes: [
        { time: 0, value: 0 },
        { time: 1, value: 1 },
      ],
    });
    add('e_driven', 'Null', {});
    wire('e_driven', 'out', sceneId, 'children');
    add('e_vec', 'MakeVec3', {});
    wire('e_mix', 'out', 'e_vec', 'x');
    add('e_drv', 'ParamDriver', { target: 'e_driven', paramPath: 'position' });
    wire('e_vec', 'out', 'e_drv', 'in');

    const ev = await import('/src/core/dag/evaluator.ts');
    const world = await import('/src/app/resolveWorldTransform.ts');
    const state = () => w.__basher_dag.getState().state as never;
    const a = ev.evaluate(state(), 'e_a', { socket: 'world' }).value as number[];
    const b = ev.evaluate(state(), 'e_b', { socket: 'world' }).value as number[];
    const ctx = (seconds: number) => ({ time: { frame: seconds * 24, seconds, normalized: 0 } });
    const x = (seconds: number) => {
      const r = world.resolveWorldTransform(state(), 'e_driven', ctx(seconds), undefined);
      return (r as { matrix: number[] } | null)?.matrix[12] ?? null;
    };
    return {
      aForward: [-a[8], -a[9], -a[10]],
      bForward: [-b[8], -b[9], -b[10]],
      driven: [x(0), x(0.5), x(1)],
    };
  });

  // Blender 5.1.1, once settled: each faces the other.
  expect(result.aForward[0]).toBeCloseTo(0.5547, 3);
  expect(result.aForward[1]).toBeCloseTo(0.8321, 3);
  expect(result.bForward[0]).toBeCloseTo(-0.5547, 3);
  expect(result.bForward[1]).toBeCloseTo(-0.8321, 3);
  expect(result.driven[0]).toBeCloseTo(0, 4);
  expect(result.driven[1]).toBeCloseTo(5, 4);
  expect(result.driven[2]).toBeCloseTo(10, 4);
  expect(errors).toEqual([]);
});
