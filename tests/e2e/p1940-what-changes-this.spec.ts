// #1940 — "What changes this": the inspector's read-only list of every lane that layers onto the
// selected object, drawn last applied on top, each row opening the editor it is edited in.
//
// The box gets a Track To and an Array through the panels' own builders, and a keyed channel on its
// material. The section stands under Transform (and the stack frame under it), opens collapsed,
// and lists Constraints above Modifiers above Channels. A modifier row selects the Array and turns
// the frame to Modifiers; a constraint row turns it to Constraints; the material channel turns it
// to Materials. No click edits the scene.

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
      state: { nodes: Record<string, Node> };
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
const nodeCount = (page: Page) =>
  page.evaluate(
    () => Object.keys((window as unknown as W).__basher_dag.getState().state.nodes).length,
  );

/** The box with a Track To, an Array and a keyed material channel. */
async function dressBox(
  page: Page,
): Promise<{ box: string; modifier: string; constraint: string }> {
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
    const m = os.buildAddModifierOps(dag().state as never, base, 'ArrayModifier')!;
    dag().dispatchAtomic(m.ops, 'user', 'add modifier');
    dag().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'p1940_metal',
          nodeType: 'KeyframeChannelNumber',
          params: {
            name: 'boxMetal',
            target: box,
            paramPath: 'material.base.metalness',
            keyframes: [
              { time: 0, value: 0, easing: 'linear' },
              { time: 1, value: 1, easing: 'linear' },
            ],
          },
        },
      ],
      'user',
      'key metalness',
    );
    const modifier = Object.entries(dag().state.nodes).find(
      ([, n]) => n.type === 'ArrayModifier',
    )![0];
    return { box, modifier, constraint: c.constraintId };
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
});

test('the section lists what changes the box, last applied on top, under Transform', async ({
  page,
}) => {
  const { box } = await dressBox(page);
  await select(page, box);

  const section = page.getByTestId('inspector-section-layers');
  await expect(section).toBeVisible();
  await expect(page.getByTestId('inspector-section-header-layers')).toHaveText('What Changes This');
  // Under Transform: the Transform card, then the frame, then this section.
  const transformBox = await page.getByTestId('inspector-section-transform').boundingBox();
  const frameBox = await page.getByTestId('stack-frame').boundingBox();
  const sectionBox = await section.boundingBox();
  expect(transformBox!.y).toBeLessThan(frameBox!.y);
  expect(frameBox!.y).toBeLessThan(sectionBox!.y);

  // A non-primary section: it opens collapsed, and opens on a click.
  await expect(page.getByTestId('object-layer-surface')).toHaveCount(0);
  await page.getByTestId('inspector-section-toggle-layers').click();
  const surface = page.getByTestId('object-layer-surface');
  await expect(surface).toBeVisible();
  await expect(page.getByTestId('object-layer-order-hint')).toHaveText(
    'top of the list is applied last',
  );

  const lanes = await surface
    .locator('[data-testid^="object-layer-group-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice(19)));
  expect(lanes).toEqual(['constraint', 'modifier', 'channel']);
  await expect(page.getByTestId('object-layer-row-channel')).toContainText('boxMetal');
  await expect(page.getByTestId('object-layer-row-base-only')).toHaveCount(1);
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: test.info().outputPath('p1940-what-changes-this.png') });
});

test('a row opens the editor it is edited in, and no click edits the scene', async ({ page }) => {
  const { box, modifier, constraint } = await dressBox(page);
  await select(page, box);
  await page.getByTestId('inspector-section-toggle-layers').click();
  const before = await nodeCount(page);

  // A modifier row: the Array is selected and the frame shows Modifiers.
  await page.getByTestId('object-layer-row-modifier').click();
  await expect.poll(() => selected(page)).toBe(modifier);
  await expect(page.getByTestId('stack-frame')).toHaveAttribute('data-shown', 'modifiers');

  // A constraint row: back on the box's row list, the Track To is selected, frame on Constraints.
  await select(page, box);
  await page.getByTestId('object-layer-row-constraint').click();
  await expect.poll(() => selected(page)).toBe(constraint);
  await expect(page.getByTestId('stack-frame')).toHaveAttribute('data-shown', 'constraints');

  // The material channel: the box is selected and the frame shows Materials.
  await select(page, box);
  await page.getByTestId('object-layer-row-channel').click();
  await expect.poll(() => selected(page)).toBe(box);
  await expect(page.getByTestId('stack-frame')).toHaveAttribute('data-shown', 'materials');

  expect(await nodeCount(page), 'a pick only moves the view').toBe(before);
});
