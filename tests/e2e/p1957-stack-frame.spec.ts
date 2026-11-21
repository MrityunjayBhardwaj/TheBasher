// #1957 — the frame around the inspector's stacks: a Modifiers · Constraints · Materials switch with
// counts, a flow strip in apply order that takes you to each stack (Anim layers opens the drawer
// tab), no presets bar (no stack presets exist), and a picked row's settings below the list.
//
// The box gets a Track To and an Array through the panels' own builders. The switch shows one
// stack's cards at a time; picking the Array row keeps the frame on Modifiers and its settings
// follow below. The skinned bar's armature puts Anim layers first in the flow, and that step opens
// the drawer on the Anim Layers tab.

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
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_selection: {
    getState: () => { select: (id: string | null) => void; selectedNodeId: string | null };
  };
}

const select = (page: Page, id: string | null) =>
  page.evaluate((x) => (window as unknown as W).__basher_selection.getState().select(x), id);

/** The box with a Track To and an Array, through the stack panels' own builders. */
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
    const modifier = Object.entries(dag().state.nodes).find(
      ([, n]) => n.type === 'ArrayModifier',
    )![0];
    return { box, modifier, constraint: c.constraintId };
  });
}

const body = (page: Page, id: string) => page.getByTestId(`inspector-section-body-${id}`);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
});

test('the switch counts each stack, shows one at a time, and the flow reads in apply order', async ({
  page,
}) => {
  const { box, modifier } = await dressBox(page);
  await select(page, box);
  const frame = page.getByTestId('stack-frame');
  await expect(frame).toBeVisible();
  await expect(page.getByTestId('stack-frame-count-modifiers')).toHaveText('1');
  await expect(page.getByTestId('stack-frame-count-constraints')).toHaveText('1');
  await expect(page.getByTestId('stack-frame-count-materials')).toHaveText('0');
  await expect(frame.getByRole('tab')).toHaveText([/^Modifiers/, /^Constraints/, /^Materials/]);
  await expect(page.getByTestId('stack-frame-order-hint')).toHaveText(
    'top of the list is applied first',
  );

  // The flow: the object's constraints, then its shape's modifiers (no anim layers on a box).
  await expect(page.getByTestId('stack-frame-flow').getByRole('button')).toHaveText([
    /Constraints\s*1/,
    /Modifiers\s*1/,
  ]);
  // No presets bar: there are no stack presets to offer.
  await expect(frame.getByText(/preset/i)).toHaveCount(0);

  // Constraints: their cards open, the modifier card folds.
  await page.getByTestId('stack-frame-tab-constraints').click();
  await expect(page.getByTestId('stack-frame-tab-constraints')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(body(page, 'constraint')).toBeVisible();
  await expect(body(page, 'modifier')).toHaveCount(0);

  // The flow's Modifiers step does what the switch does.
  await page.getByTestId('stack-frame-flow-modifiers').click();
  await expect(page.getByTestId('stack-frame-tab-modifiers')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(body(page, 'modifier')).toBeVisible();
  await expect(body(page, 'constraint')).toHaveCount(0);

  // Picking the Array row: the frame stays on Modifiers, and the row's settings follow below it.
  await page.getByTestId(`modifier-row-${modifier}`).getByRole('button').first().click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as W).__basher_selection.getState().selectedNodeId),
    )
    .toBe(modifier);
  await expect(frame).toHaveAttribute('data-shown', 'modifiers');
  await expect(page.getByTestId('stack-frame-selected')).toContainText('its settings follow below');
  const count = page.getByTestId(`inspector-input-${modifier}-count`);
  await expect(count).toBeVisible();
  const frameBox = await frame.boundingBox();
  const countBox = await count.boundingBox();
  expect(countBox!.y).toBeGreaterThan(frameBox!.y + frameBox!.height);

  // Switching stack from a picked row goes back to the object, on the stack picked.
  await page.getByTestId('stack-frame-tab-constraints').click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as W).__basher_selection.getState().selectedNodeId),
    )
    .toBe(box);
  await expect(frame).toHaveAttribute('data-shown', 'constraints');
});

test('a character: Anim layers leads the flow and opens the drawer’s Anim Layers tab', async ({
  page,
}) => {
  const armature = await page.evaluate(async () => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1957/skinned-bar.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const nodes = w.__basher_dag.getState().state.nodes;
    const mod = Object.values(nodes).find((n) => n.type === 'ArmatureModifier')!;
    return (mod.inputs.armature as { node: string }).node;
  });
  await select(page, armature);
  const steps = page.getByTestId('stack-frame-flow').getByRole('button');
  await expect(steps.first()).toHaveText(/Anim layers\s*0/);
  await expect(page.getByTestId('timeline-drawer')).toHaveAttribute('data-open', 'false');
  await page.getByTestId('stack-frame-flow-animLayers').click();
  await expect(page.getByTestId('timeline-drawer')).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('timeline-tab-animLayers')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByTestId('anim-layers-subject')).toBeVisible();
});
