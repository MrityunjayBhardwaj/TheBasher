// #1960 — the inspector's stack frame is the one home for an object's stacks, a camera's or a light's
// included. Their frame offers Modifiers as a tab the object cannot take (dimmed, counted as not
// applicable); picking it shows the Modifier section's note inside the frame, and the separate
// Modifier section no longer renders. A Null has no frame and keeps its cards.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';

// Works inside the inspector, so both side panels start open (#1952).
test.use({ sidePanels: 'open' });

interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } }; nodes: Record<string, unknown> };
      dispatch: (op: unknown) => void;
    };
  };
  __basher_selection: {
    getState: () => { select: (id: string | null) => void };
  };
}

const select = (page: Page, id: string | null) =>
  page.evaluate((x) => (window as unknown as W).__basher_selection.getState().select(x), id);

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
