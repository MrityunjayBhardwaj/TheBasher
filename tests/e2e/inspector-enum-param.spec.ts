// The generic inspector ENUM control (post-#209 self-review). A node's declared
// string-enum param (read from its zod paramSchema) renders as a <select>, not a
// read-only span — so it is authorable from the UI. Exercised via MirrorModifier's
// `axis` (the param that surfaced the gap), which is the strongest case: changing
// the dropdown must flow UI → setParam → DAG → the LIVE render.
//
// BOUNDARY-PAIR: a 1×1×1 box mirrored at offset 2 separates along the chosen axis.
// axis 'x' → the rendered mesh spans x∈[-0.5,4.5] (≈5 wide), y≈1 tall. Switching
// the dropdown to 'y' must make the SAME rendered mesh span y∈[-0.5,4.5] and x≈1 —
// i.e. the viewport followed the dropdown, not just the DAG param.
//
// REF: src/app/NPanel.tsx (EnumField + stringEnumOptions); src/nodes/MirrorModifier.ts.

import { expect, test } from './_fixtures';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface EnumWindow {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } }; nodes: Record<string, { params: { axis?: unknown } }> };
      dispatchAtomic: (ops: Op[], s?: string, l?: string) => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_three: { getState: () => { scene: ThreeSceneLike | null } };
  __basher_modified_vertex_count: (id: string) => number | null;
}
interface ThreeSceneLike {
  traverse: (cb: (o: ThreeObjLike) => void) => void;
}
interface ThreeObjLike {
  type: string;
  geometry?: { attributes?: { position?: { count: number; array: ArrayLike<number> } } };
}

const BOX = 'enum_box';
const MIR = 'enum_mirror';

/** The axis-aligned span of the 48-vert mirror mesh, read off the live three scene. */
function mirrorSpan(page: import('@playwright/test').Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const w = window as unknown as EnumWindow;
    const scene = w.__basher_three.getState().scene;
    let span: { x: number; y: number } | null = null;
    scene?.traverse((o) => {
      const g = o.geometry?.attributes?.position;
      if (o.type !== 'Mesh' || !g || g.count !== 48) return;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < g.array.length; i += 3) {
        minX = Math.min(minX, g.array[i]); maxX = Math.max(maxX, g.array[i]);
        minY = Math.min(minY, g.array[i + 1]); maxY = Math.max(maxY, g.array[i + 1]);
      }
      span = { x: maxX - minX, y: maxY - minY };
    });
    return span;
  });
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
    const w = window as unknown as EnumWindow;
    return Boolean(
      w.__basher_dag && w.__basher_three && w.__basher_selection && w.__basher_dag.getState().state.outputs.scene,
    );
  });
});

test('the inspector enum dropdown authors a string-enum param (axis) through to the live render', async ({
  page,
}) => {
  await page.evaluate(
    ({ box, mir }) => {
      const w = window as unknown as EnumWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          { type: 'addNode', nodeId: box, nodeType: 'BoxMesh', params: { size: [1, 1, 1], position: [0, 0, 0] } },
          { type: 'addNode', nodeId: mir, nodeType: 'MirrorModifier', params: { axis: 'x', offset: 2, muted: false } },
          { type: 'connect', from: { node: box, socket: 'out' }, to: { node: mir, socket: 'target' } },
          { type: 'connect', from: { node: mir, socket: 'out' }, to: { node: sceneId, socket: 'children' } },
        ],
        'e2e',
        'box → mirror → scene',
      );
      w.__basher_selection.getState().select(mir); // open the modifier's inspector
    },
    { box: BOX, mir: MIR },
  );

  await page.waitForFunction(
    (mir) => (window as unknown as EnumWindow).__basher_modified_vertex_count(mir) === 48,
    MIR,
    { timeout: 15_000 },
  );

  // The axis param is a <select> (not a read-only span), with the schema's options.
  const select = page.getByTestId(`inspector-enum-${MIR}-axis`);
  await expect(select).toBeVisible({ timeout: 10_000 });
  await expect(select).toHaveValue('x');
  expect((await select.locator('option').allTextContents()).sort()).toEqual(['x', 'y', 'z']);

  // axis 'x' at offset 2 → the mesh spans ≈5 in x, ≈1 in y.
  await expect.poll(() => mirrorSpan(page).then((s) => s && Math.round(s.x))).toBe(5);
  const spanX = await mirrorSpan(page);
  expect(Math.round(spanX!.y)).toBe(1);

  // Change the dropdown to 'y' — UI → setParam → DAG.
  await select.selectOption('y');
  await expect
    .poll(() => page.evaluate((mir) => (window as unknown as EnumWindow).__basher_dag.getState().state.nodes[mir].params.axis, MIR))
    .toBe('y');

  // …and the LIVE render followed: the SAME mesh now spans ≈5 in y, ≈1 in x.
  await expect.poll(() => mirrorSpan(page).then((s) => s && Math.round(s.y))).toBe(5);
  const spanY = await mirrorSpan(page);
  expect(Math.round(spanY!.x)).toBe(1);
});
