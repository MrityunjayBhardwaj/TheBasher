// p1953 (#1953) — the Nodes tab as decided (design board 8b, gen_nodes.py): values on the nodes,
// its own N panel, a view flag, and no Scene node.
//
// Done when: in the Nodes tab, a node shows its values and editing one changes the scene (and is
// keyable with I); N toggles the panel; the view flag shows that node's result in the viewport; no
// Scene node is drawn.
//
// Read off the live surfaces: the DAG (`__basher_dag`), the drawn mesh's world bounds
// (`__basher_mesh_world_bounds`), the graph's own data attributes, and the Nodes tab's store.
//
// REF: src/app/GraphView.tsx; src/core/dag/nodeValues.ts; src/app/viewFlag.ts;
//      src/app/stores/nodesTabStore.ts; src/app/KeyboardShortcuts.tsx (N).
import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';
import { openDrawerTab } from './_drawer';

test.setTimeout(120_000);

interface W {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<
          string,
          {
            id: string;
            type: string;
            params: Record<string, unknown>;
            inputs: Record<string, unknown>;
          }
        >;
      };
      dispatchAtomic: (ops: unknown[], source: string, label: string) => void;
    };
  };
  __basher_mesh_world_bounds: (id: string) => [number, number, number] | null;
}

const SHOTS =
  '/private/tmp/claude-501/-Users-mrityunjaybhardwaj-Documents-projects-basher-ai/eda82755-8702-4c9c-a8d7-95247e70fa04/scratchpad';

async function boot(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.evaluate(() => {
    for (const k of ['basher.nodesTab.v1', 'basher.timelineDock.v1', 'basher.chatColumn.v1'])
      localStorage.removeItem(k);
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as Partial<W>).__basher_mesh_world_bounds),
  );
}

const params = (page: Page, id: string) =>
  page.evaluate(
    (id) => (window as unknown as W).__basher_dag.getState().state.nodes[id]?.params,
    id,
  );

const graph = (page: Page) => page.getByTestId('graph-view');

async function openNodes(page: Page): Promise<void> {
  await openDrawerTab(page, 'nodes');
  await expect(graph(page)).toBeVisible();
}

test('no Scene node is drawn: a network ends at its object', async ({ page }) => {
  await boot(page);
  await openNodes(page);
  const drawn = await page
    .locator('[data-graph-node]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-graph-node')!));
  const types = await page.evaluate(
    (ids) => ids.map((id) => (window as unknown as W).__basher_dag.getState().state.nodes[id].type),
    drawn,
  );
  // The premise: the graph holds a Scene node to leave out, and objects to end at.
  expect(
    await page.evaluate(() =>
      Object.values((window as unknown as W).__basher_dag.getState().state.nodes).some(
        (n) => n.type === 'Scene',
      ),
    ),
  ).toBe(true);
  expect(types).not.toContain('Scene');
  expect(types).not.toContain('RenderOutput');
  expect(types).toContain('Object');
  // No line runs past an object into the scene.
  await expect(page.locator('[data-graph-line*=">n_scene"]')).toHaveCount(0);
});

test('a node shows its values; editing one changes the scene, and I keys it', async ({ page }) => {
  await boot(page);
  await openNodes(page);
  const values = graph(page).getByTestId('graph-view-values-n_box_data');
  await expect(values.locator('[data-graph-value="size"]')).toBeVisible();
  // An object end carries none (its pose is the viewport's).
  await expect(graph(page).getByTestId('graph-view-values-n_box')).toHaveCount(0);

  const before = await page.evaluate(() =>
    (window as unknown as W).__basher_mesh_world_bounds('n_box'),
  );
  expect(before).not.toBeNull();
  const x = values.getByTestId('inspector-vec-n_box_data-size-x');
  await x.fill('3');
  await x.press('Enter');
  await expect.poll(async () => ((await params(page, 'n_box_data'))!.size as number[])[0]).toBe(3);
  // The viewport follows: the box is three wide now.
  await expect
    .poll(async () =>
      page.evaluate(() => (window as unknown as W).__basher_mesh_world_bounds('n_box')![0]),
    )
    .toBeCloseTo(3 * (before![0] / 1), 3);

  // I over the value row keys that setting (the inspector's own row, so the same keyer). Out of
  // the field first: a key typed into a focused field is the field's, as in the inspector.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const keysOn = () =>
    page.evaluate(
      () =>
        Object.values((window as unknown as W).__basher_dag.getState().state.nodes).filter(
          (n) =>
            n.type.startsWith('KeyframeChannel') &&
            n.params.target === 'n_box_data' &&
            n.params.paramPath === 'size',
        ).length,
    );
  expect(await keysOn()).toBe(0);
  await values.locator('[data-graph-value="size"]').hover();
  await page.keyboard.press('i');
  await expect.poll(keysOn).toBe(1);
  await page.screenshot({ path: `${SHOTS}/p1953-values.png` });
});

test('N toggles the tab’s own panel, which lists the selected node’s settings', async ({
  page,
}) => {
  await boot(page);
  await openNodes(page);
  const panel = page.getByTestId('nodes-panel');
  // It opens with the tab, as the board draws it.
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('nodes-panel-empty')).toBeVisible();
  // Selecting a node in the graph fills it with that node's full params (the inspector's block).
  await graph(page)
    .locator('[data-graph-node="n_light_data"] rect')
    .first()
    .click({ force: true, position: { x: 30, y: 12 } });
  await expect(panel.getByTestId('inspector-node-name')).toBeVisible();
  await expect(panel.getByTestId('inspector-input-n_light_data-intensity')).toBeVisible();
  // More than the node carries: the panel lists every setting, the node its key few.
  await expect(panel.getByTestId('inspector-input-n_light_data-decay')).toBeVisible();
  await expect(
    graph(page)
      .getByTestId('graph-view-values-n_light_data')
      .getByTestId('inspector-input-n_light_data-decay'),
  ).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/p1953-panel.png` });

  // N, with the Nodes tab the pane last worked in: folds it, and again unfolds it.
  await page.keyboard.press('n');
  await expect(panel).toHaveCount(0);
  await page.keyboard.press('n');
  await expect(panel).toBeVisible();
  // Folded, it stays folded across a reload.
  await page.keyboard.press('n');
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await openNodes(page);
  await expect(page.getByTestId('nodes-panel')).toHaveCount(0);
  await page.getByTestId('graph-view-panel-toggle').click();
  await expect(page.getByTestId('nodes-panel')).toBeVisible();

  // N while working elsewhere (the viewport) leaves it alone.
  await page.getByTestId('viewport').click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('n');
  await expect(page.getByTestId('nodes-panel')).toBeVisible();
});

test('the view flag: one node viewing at a time, never on a constraint', async ({ page }) => {
  await boot(page);
  await openNodes(page);
  const flag = (id: string) => graph(page).getByTestId(`graph-view-flag-${id}`);
  await expect(flag('n_box')).toBeVisible();
  await expect(flag('n_box_data')).toBeVisible();
  // A constraint has no result of its own to look at.
  await expect(flag('n_light_aim')).toHaveCount(0);
  for (const id of ['n_box', 'n_box_data'])
    await expect(flag(id)).toHaveAttribute('data-viewing', 'false');

  await flag('n_box_data').click();
  await expect(flag('n_box_data')).toHaveAttribute('data-viewing', 'true');
  await flag('n_box').click();
  await expect(flag('n_box')).toHaveAttribute('data-viewing', 'true');
  await expect(flag('n_box_data')).toHaveAttribute('data-viewing', 'false');
  await expect(graph(page).locator('[data-graph-flag][data-viewing="true"]')).toHaveCount(1);
  // Clicking the viewing flag again goes back to the plain scene.
  await flag('n_box').click();
  await expect(graph(page).locator('[data-graph-flag][data-viewing="true"]')).toHaveCount(0);
  // Ctrl-click on a node views it too (board 8b).
  await graph(page)
    .locator('[data-graph-node="n_box_data"] rect')
    .first()
    .click({ force: true, modifiers: ['Control'], position: { x: 30, y: 12 } });
  await expect(flag('n_box_data')).toHaveAttribute('data-viewing', 'true');
});

test('the view flag shows that node’s result in the viewport', async ({ page }) => {
  await boot(page);
  // An Array (count 3) on the box: viewing the box data shows one box, the Array's flag three.
  await page.evaluate(async () => {
    const { buildAddModifierOps } = await import('/src/app/operatorStack.ts');
    const dag = (window as unknown as W).__basher_dag.getState();
    const add = buildAddModifierOps(dag.state as never, 'n_box_data', 'ArrayModifier', {
      count: 3,
    });
    dag.dispatchAtomic(add!.ops, 'user', 'add array');
  });
  const width = () =>
    page.evaluate(() => (window as unknown as W).__basher_mesh_world_bounds('n_box')![0]);
  await expect.poll(width).toBeGreaterThan(4);
  const final = await width();
  await openNodes(page);
  await graph(page).getByTestId('graph-view-flag-n_box_data').click();
  await expect.poll(width).toBeLessThan(final / 2);
  await page.screenshot({ path: `${SHOTS}/p1953-viewing.png` });
  // Back to the scene: the final result again.
  await graph(page).getByTestId('graph-view-flag-n_box_data').click();
  await expect.poll(width).toBeCloseTo(final, 3);
});
