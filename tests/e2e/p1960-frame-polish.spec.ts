// #1960 — the inspector's stack frame is the one home for an object's stacks, a camera's or a light's
// included. Their frame offers Modifiers as a tab the object cannot take (dimmed, counted as not
// applicable); picking it shows the Modifier section's note inside the frame, and the separate
// Modifier section no longer renders. A Null has no frame and keeps its cards.
//
// #1961 — the frame stands directly under Transform, so Transform stays near the top however long
// the picked stack runs, and the "Pick a row" line sits under the list, above the picked row's
// settings.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';

// Works inside the inspector, so both side panels start open (#1952).
test.use({ sidePanels: 'open' });

interface Node {
  type: string;
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
    getState: () => { select: (id: string | null) => void };
  };
}

const select = (page: Page, id: string | null) =>
  page.evaluate((x) => (window as unknown as W).__basher_selection.getState().select(x), id);

/** The box with a Track To, an Array and a Bevel, and a material operator, through the panels'
 *  own builders (as p1959 dresses it). */
async function dressBox(page: Page) {
  return page.evaluate(async () => {
    const w = window as unknown as W;
    const cs = await import(/* @vite-ignore */ '/src/app/constraintStack.ts');
    const os = await import(/* @vite-ignore */ '/src/app/operatorStack.ts');
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
    return { box, array: of('ArrayModifier'), bevel: of('BevelModifier') };
  });
}

async function box(page: Page, testId: string, nth = 0) {
  const loc = page.getByTestId(testId).nth(nth);
  await expect(loc).toBeVisible();
  const b = await loc.boundingBox();
  if (!b) throw new Error(`${testId} has no box`);
  return b;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
});

test('#1960 a camera and a light: Modifiers is an unavailable tab whose note shows in the frame', async ({
  page,
}) => {
  // The box first, with Modifiers picked: the camera must not open on its unavailable tab.
  await select(page, 'n_box');
  await page.getByTestId('stack-frame-tab-modifiers').click();
  await expect(page.getByTestId('stack-frame-body')).toHaveAttribute('data-stack', 'modifiers');

  for (const id of ['n_camera', 'n_light']) {
    await select(page, id);
    const frame = page.getByTestId('stack-frame');
    await expect(page.getByTestId('inspector-node-name')).toHaveText(id);
    await expect(frame).toBeVisible();
    // No separate Modifier section: the frame is the one home.
    await expect(page.getByTestId('inspector-section-modifier')).toHaveCount(0);

    const tab = frame.getByTestId('stack-frame-tab-modifiers');
    await expect(tab).toBeVisible();
    await expect(tab).toContainText('not applicable');
    await expect(tab).toHaveAttribute('data-available', 'false');
    await expect(frame.getByTestId('stack-frame-count-modifiers')).toHaveText('–');
    // It opens on a stack it can take, not on the unavailable one picked on the box.
    await expect(page.getByTestId('stack-frame-body')).toHaveAttribute('data-stack', 'constraints');
    // The flow strip leaves an unavailable stack out (a camera's has one step, so none shows).
    await expect(frame.getByTestId('stack-frame-flow-modifiers')).toHaveCount(0);

    await tab.click();
    await expect(page.getByTestId('stack-frame-body')).toHaveAttribute('data-stack', 'modifiers');
    await expect(frame.getByTestId('modifier-not-applicable')).toBeVisible();
    await expect(frame.getByTestId('modifier-not-applicable')).toContainText(
      'Modifiers reshape mesh data',
    );
    await expect(page.getByTestId('modifier-not-applicable')).toHaveCount(1);
    await expect(page.locator('[data-testid^="modifier-add-"]')).toHaveCount(0);
    // Nothing to pick in a stack the object cannot take.
    await expect(frame.getByTestId('stack-frame-selected')).toHaveCount(0);

    // Back to Constraints.
    await frame.getByTestId('stack-frame-tab-constraints').click();
    await expect(page.getByTestId('stack-frame-body')).toHaveAttribute('data-stack', 'constraints');
    await expect(page.getByTestId('modifier-not-applicable')).toHaveCount(0);
  }

  // Looking at the camera's Modifiers is not a pick: the box keeps the last real one (Constraints).
  await select(page, 'n_camera');
  await page.getByTestId('stack-frame-tab-modifiers').click();
  await expect(page.getByTestId('stack-frame-body')).toHaveAttribute('data-stack', 'modifiers');
  await select(page, 'n_box');
  await expect(page.getByTestId('stack-frame-body')).toHaveAttribute('data-stack', 'constraints');
  await expect(page.getByTestId('stack-frame-tab-modifiers')).toHaveAttribute(
    'data-available',
    'true',
  );
});

test('#1960 a Null has no frame and keeps its own sections', async ({ page }) => {
  await page.evaluate(() => {
    const dag = (window as unknown as W).__basher_dag.getState();
    const scene = dag.state.outputs.scene!.node;
    dag.dispatch({ type: 'addNode', nodeId: 'n_null1960', nodeType: 'Null', params: {} });
    dag.dispatch({
      type: 'connect',
      from: { node: 'n_null1960', socket: 'out' },
      to: { node: scene, socket: 'children' },
    });
  });
  await select(page, 'n_null1960');
  await expect(page.getByTestId('inspector-node-name')).toHaveText('n_null1960');
  await expect(page.getByTestId('stack-frame')).toHaveCount(0);
  await expect(page.getByTestId('inspector-section-constraint')).toBeVisible();
  await expect(page.getByTestId('inspector-section-stack')).toBeVisible();
});

test('#1961 the frame stands directly under Transform, for every stack', async ({ page }) => {
  await dressBox(page);
  await select(page, 'n_box');
  for (const kind of ['modifiers', 'constraints', 'materials'] as const) {
    await page.getByTestId(`stack-frame-tab-${kind}`).click();
    await expect(page.getByTestId('stack-frame-body')).toHaveAttribute('data-stack', kind);
    const transform = await box(page, 'inspector-section-transform');
    const frame = await box(page, 'stack-frame');
    // Below Transform, and directly: nothing stands between the two.
    expect(frame.y, kind).toBeGreaterThanOrEqual(transform.y + transform.height - 1);
    expect(frame.y - (transform.y + transform.height), kind).toBeLessThan(2);
    const next = await page
      .getByTestId('inspector-section-transform')
      .evaluate((el) => el.nextElementSibling?.getAttribute('data-testid'));
    expect(next, kind).toBe('stack-frame');
  }
  // A camera too: Transform first, then the frame.
  await select(page, 'n_camera');
  await expect(page.getByTestId('inspector-node-name')).toHaveText('n_camera');
  const transform = await box(page, 'inspector-section-transform');
  const frame = await box(page, 'stack-frame');
  expect(frame.y).toBeGreaterThanOrEqual(transform.y + transform.height - 1);
});

test("#1961 the pick-a-row line sits under the list, above the picked row's settings", async ({
  page,
}) => {
  const ids = await dressBox(page);
  await select(page, 'n_box');
  await page.getByTestId('stack-frame-tab-modifiers').click();
  const frame = page.getByTestId('stack-frame');
  const line = frame.getByTestId('stack-frame-selected');
  await expect(line).toHaveText('Pick a row: its settings open below.');
  const lastRow = await box(page, `modifier-row-${ids.bevel}`);
  const list = await box(page, 'modifier-stack');
  const tabs = await box(page, 'stack-frame-tab-modifiers');
  let at = await box(page, 'stack-frame-selected');
  expect(at.y).toBeGreaterThanOrEqual(lastRow.y + lastRow.height);
  expect(at.y).toBeGreaterThanOrEqual(list.y + list.height);
  expect(at.y).toBeGreaterThan(tabs.y);

  // A picked row: the line names it, and its settings follow right under the line.
  await frame.getByTestId(`modifier-row-${ids.array}`).getByRole('button').first().click();
  await expect(line).toContainText('its settings follow below.');
  at = await box(page, 'stack-frame-selected');
  const list2 = await box(page, 'modifier-stack');
  const count = await box(page, `inspector-input-${ids.array}-count`);
  expect(at.y).toBeGreaterThanOrEqual(list2.y + list2.height);
  expect(count.y).toBeGreaterThanOrEqual(at.y + at.height);
  // The line is the list section's next sibling: nothing else stands between them.
  const after = await page
    .getByTestId('modifier-stack')
    .evaluate((el) => el.nextElementSibling?.getAttribute('data-testid'));
  expect(after).toBe('stack-frame-selected');

  // Constraints and Materials: the line also comes after their lists.
  await select(page, 'n_box');
  for (const [kind, list] of [
    ['constraints', 'constraint-stack'],
    ['materials', 'material-op-stack'],
  ] as const) {
    await page.getByTestId(`stack-frame-tab-${kind}`).click();
    await expect(page.getByTestId('stack-frame-body')).toHaveAttribute('data-stack', kind);
    const l = await box(page, list);
    const a = await box(page, 'stack-frame-selected');
    expect(a.y, kind).toBeGreaterThanOrEqual(l.y + l.height);
  }
});
