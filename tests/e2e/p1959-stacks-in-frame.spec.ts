// #1959 — the stack frame holds the stack it shows. The picked stack's rows and its + Add are drawn
// INSIDE the frame, by the same panels the Modifier / Constraint / Constraint Stack / Material
// cards drew them with; those cards no longer render as separate sections for an object with the
// frame, and the switch swaps what the frame draws.
//
// The box gets a Track To, an Array and a Bevel, and a material operator, through the panels' own
// builders. A Null has no frame, so its Constraint sections stay cards; a camera's frame shows its
// Modifiers as a tab it cannot take (#1960), so no Modifier card stays for it either.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';

// Works inside the inspector, so both side panels start open (#1952).
test.use({ sidePanels: 'open' });

interface Node {
  type: string;
  params: Record<string, unknown>;
  inputs: Record<string, unknown>;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } }; nodes: Record<string, Node> };
      dispatch: (op: unknown) => void;
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_selection: {
    getState: () => { select: (id: string | null) => void; selectedNodeId: string | null };
  };
}

const select = (page: Page, id: string | null) =>
  page.evaluate((x) => (window as unknown as W).__basher_selection.getState().select(x), id);
const selected = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_selection.getState().selectedNodeId);
const param = (page: Page, id: string, key: string) =>
  page.evaluate(
    ([n, k]) => (window as unknown as W).__basher_dag.getState().state.nodes[n]?.params[k],
    [id, key] as const,
  );

/** The box with a Track To, an Array, a Bevel and a material operator. */
async function dressBox(page: Page) {
  return page.evaluate(async () => {
    const w = window as unknown as W;
    const cs = await import('/src/app/constraintStack.ts');
    const os = await import('/src/app/operatorStack.ts');
    const dag = () => w.__basher_dag.getState();
    const nodes = dag().state.nodes;
    const box = Object.entries(nodes).find(
      ([, n]) =>
        n.type === 'Object' &&
        nodes[(n.inputs.data as { node?: string } | undefined)?.node ?? '']?.type === 'BoxData',
    )![0];
    const c = cs.buildAddConstraintOps(dag().state as never, box, 'TrackTo')!;
    dag().dispatchAtomic(c.ops, 'user', 'add constraint');
    const base = os.resolveStackBase(dag().state as never, box);
    for (const type of ['ArrayModifier', 'BevelModifier']) {
      const m = os.buildAddModifierOps(dag().state as never, base, type)!;
      dag().dispatchAtomic(m.ops, 'user', 'add modifier');
    }
    const mat = os.buildAddMaterialOpOps(dag().state as never, base, 'MaterialOverrideOp')!;
    dag().dispatchAtomic(mat.ops, 'user', 'add material operator');
    const of = (type: string) =>
      Object.entries(dag().state.nodes).find(([, n]) => n.type === type)![0];
    return {
      box,
      base,
      array: of('ArrayModifier'),
      bevel: of('BevelModifier'),
      material: of('MaterialOverrideOp'),
      constraint: c.constraintId,
    };
  });
}

const STACK_SECTIONS = ['modifier', 'constraint', 'stack', 'material'] as const;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
});

test('the frame draws the picked stack inside itself, and the switch swaps it', async ({
  page,
}) => {
  const ids = await dressBox(page);
  await select(page, ids.box);
  const frame = page.getByTestId('stack-frame');
  const body = page.getByTestId('stack-frame-body');
  await expect(frame).toBeVisible();

  // No separate section header for any stack: the frame is the one box.
  for (const id of STACK_SECTIONS) {
    await expect(page.getByTestId(`inspector-section-${id}`)).toHaveCount(0);
  }

  // Modifiers: both rows and the + Add, inside the frame.
  await page.getByTestId('stack-frame-tab-modifiers').click();
  await expect(body).toHaveAttribute('data-stack', 'modifiers');
  await expect(frame.getByTestId(`modifier-row-${ids.array}`)).toBeVisible();
  await expect(frame.getByTestId(`modifier-row-${ids.bevel}`)).toBeVisible();
  await expect(frame.getByTestId('modifier-add-ArrayModifier')).toBeVisible();
  // The rows are drawn once, in the frame.
  await expect(page.getByTestId(`modifier-row-${ids.array}`)).toHaveCount(1);
  // A modifier's own settings open when its row is picked; they are not piled under the list.
  await expect(page.getByTestId(`inspector-input-${ids.array}-count`)).toHaveCount(0);
  await expect(frame.getByTestId(`constraint-row-${ids.constraint}`)).toHaveCount(0);

  // Constraints: the swap. Its rows and + Add come in, the modifiers go.
  await page.getByTestId('stack-frame-tab-constraints').click();
  await expect(body).toHaveAttribute('data-stack', 'constraints');
  await expect(frame.getByTestId(`constraint-row-${ids.constraint}`)).toBeVisible();
  await expect(frame.getByTestId('constraint-add-TrackTo')).toBeVisible();
  // The stack panel on the object's lane (the Constraint Stack section's body) comes too.
  await expect(frame.getByTestId('stack-frame-section-stack')).toHaveCount(1);
  await expect(page.getByTestId(`modifier-row-${ids.array}`)).toHaveCount(0);

  // Materials: the material operator's row, and the material's own settings keep their home here.
  await page.getByTestId('stack-frame-tab-materials').click();
  await expect(body).toHaveAttribute('data-stack', 'materials');
  await expect(frame.getByTestId(`material-op-row-${ids.material}`)).toBeVisible();
  await expect(frame.getByTestId('material-op-add-MaterialOverrideOp')).toBeVisible();
  await expect(page.getByTestId(`constraint-row-${ids.constraint}`)).toHaveCount(0);

  // Still no separate stack sections, whichever stack shows.
  for (const id of STACK_SECTIONS) {
    await expect(page.getByTestId(`inspector-section-${id}`)).toHaveCount(0);
  }
});

test('a row in the frame still selects, and its settings still edit', async ({ page }) => {
  const ids = await dressBox(page);
  await select(page, ids.box);
  const frame = page.getByTestId('stack-frame');
  await page.getByTestId('stack-frame-tab-modifiers').click();

  await frame.getByTestId(`modifier-row-${ids.array}`).getByRole('button').first().click();
  await expect.poll(() => selected(page)).toBe(ids.array);
  await expect(frame).toHaveAttribute('data-shown', 'modifiers');
  // The selected row is still listed in the frame, with its settings.
  await expect(frame.getByTestId(`modifier-row-${ids.array}`)).toBeVisible();
  const count = frame.getByTestId(`inspector-input-${ids.array}-count`);
  await expect(count).toBeVisible();
  const before = await param(page, ids.array, 'count');
  const next = Number(before ?? 0) + 2;
  await count.fill(String(next));
  await count.press('Enter');
  await expect.poll(() => param(page, ids.array, 'count')).toBe(next);
  // The Array's own Modifier section is drawn by the frame, not as a card under it.
  await expect(page.getByTestId('inspector-section-modifier')).toHaveCount(0);
});

test('a node with no frame keeps its sections; a camera keeps no Modifier card', async ({
  page,
}) => {
  // A Null is not an Object: no frame, so its Constraint and Constraint Stack stay cards.
  await page.evaluate(() => {
    const w = window as unknown as W;
    const dag = w.__basher_dag.getState();
    const scene = dag.state.outputs.scene!.node;
    dag.dispatch({ type: 'addNode', nodeId: 'n_null1959', nodeType: 'Null', params: {} });
    dag.dispatch({
      type: 'connect',
      from: { node: 'n_null1959', socket: 'out' },
      to: { node: scene, socket: 'children' },
    });
  });
  await select(page, 'n_null1959');
  await expect(page.getByTestId('inspector-node-name')).toBeVisible();
  await expect(page.getByTestId('stack-frame')).toHaveCount(0);
  await expect(page.getByTestId('inspector-section-constraint')).toBeVisible();
  await expect(page.getByTestId('inspector-section-stack')).toBeVisible();

  // The camera's frame opens on Constraints, drawn in the frame. Since #1960 its Modifiers are a
  // tab it cannot take, inside the frame, so no Modifier card stays either.
  await select(page, 'n_camera');
  const frame = page.getByTestId('stack-frame');
  await expect(frame).toBeVisible();
  await expect(page.getByTestId('stack-frame-body')).toHaveAttribute('data-stack', 'constraints');
  await expect(page.getByTestId('inspector-section-constraint')).toHaveCount(0);
  await expect(frame.getByTestId('stack-frame-tab-modifiers')).toHaveAttribute(
    'data-available',
    'false',
  );
  await expect(page.getByTestId('inspector-section-modifier')).toHaveCount(0);
});

test('a selected data node shows the stack it carries, and another stack goes to the object', async ({
  page,
}) => {
  const ids = await dressBox(page);
  // Leave Modifiers picked, then select the box's data node: it carries only Material.
  await select(page, ids.box);
  await page.getByTestId('stack-frame-tab-modifiers').click();
  await select(page, ids.base);
  const frame = page.getByTestId('stack-frame');
  await expect(frame).toHaveAttribute('data-shown', 'materials');
  await expect(frame.getByTestId(`material-op-row-${ids.material}`)).toBeVisible();
  await expect(page.getByTestId('inspector-section-material')).toHaveCount(0);
  await page.getByTestId('stack-frame-tab-modifiers').click();
  await expect.poll(() => selected(page)).toBe(ids.box);
  await expect(frame.getByTestId(`modifier-row-${ids.array}`)).toBeVisible();
});

test('a selected material operator: its stack is listed once, and its settings follow', async ({
  page,
}) => {
  const ids = await dressBox(page);
  await select(page, ids.box);
  await page.getByTestId('stack-frame-tab-materials').click();
  await page
    .getByTestId('stack-frame')
    .getByTestId(`material-op-row-${ids.material}`)
    .getByRole('button')
    .first()
    .click();
  await expect.poll(() => selected(page)).toBe(ids.material);
  const frame = page.getByTestId('stack-frame');
  await expect(frame).toHaveAttribute('data-shown', 'materials');
  // The operator's own section and its data node's both draw the material list; the frame
  // draws it once.
  await expect(page.getByTestId(`material-op-row-${ids.material}`)).toHaveCount(1);
  await expect(page.getByTestId('material-op-add-MaterialOverrideOp')).toHaveCount(1);
  await expect(page.getByTestId('inspector-section-material')).toHaveCount(0);
});
