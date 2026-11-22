// #498 — an Object whose data cannot host a modifier must not offer one.
//
// Before this, `ObjectNode` declared 'modifier' unconditionally and nothing filtered it
// by the data underneath, so a camera and a light both showed the stack with "+ Array"
// and "+ Mirror". Clicking SUCCEEDED: an ArrayModifier was minted and spliced into
// `CameraData → ArrayModifier → Object.data` — inert, but a real node that saved and
// reloaded.
//
// ⚠️ THE INSTRUMENT TRAP THIS SPEC IS BUILT AROUND. The first probe written for this bug
// asked for testid `modifier-add` where production emits `modifier-add-${type}`, and
// reported zero add buttons for the camera, the light AND the cube. A uniform zero across
// subject and control reads exactly like a clean bill of health. The cube is therefore
// asserted as an explicit POSITIVE CONTROL before any zero is believed — if the control
// ever reads zero, this spec is measuring itself and not the app.
//
// REF: src/app/dataSectionCapability.ts (the per-kind table);
//      src/app/ModifierStackControls.tsx (the offer);
//      src/app/operatorStack.ts (`buildAddModifierOps` — the accept). Issues #498, #415.
import { expect, test } from './_fixtures';
import { openStackInFrame } from './_inspectorSections';

// #1952 — works inside the outliner / inspector, so it runs with both panels open (see _fixtures).
test.use({ sidePanels: 'open' });

interface W {
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_dag: {
    getState: () => { state: { nodes: Record<string, unknown> } };
  };
}

async function selectAndOpenModifiers(page: import('@playwright/test').Page, nodeId: string) {
  await page.evaluate((id) => {
    (window as unknown as W).__basher_selection.getState().select(id);
  }, nodeId);
  // #1960 — every Object's modifiers live in the inspector's stack frame: the box's as a stack it
  // takes, a camera's or a light's as a tab it cannot take, whose note says why. No Modifier card
  // renders beside the frame for any of them.
  await expect(page.getByTestId('inspector-node-name')).toHaveText(nodeId);
  // Open FIRST — `modifier-stack` does not exist in the DOM until the stack is shown, so
  // asserting it visible beforehand fails on every subject including the positive control
  // (measured while writing this).
  await openStackInFrame(page, 'modifiers');
  // The select and the button read must not share a tick — React has not re-rendered
  // yet, and a same-tick query returns the PREVIOUS selection's buttons. Awaiting the
  // stack is what separates them.
  await expect(page.getByTestId('stack-frame').getByTestId('modifier-stack')).toBeVisible();
  await expect(page.getByTestId('modifier-stack')).toHaveCount(1);
  await expect(page.getByTestId('inspector-section-modifier')).toHaveCount(0);
}

async function addButtonCount(page: import('@playwright/test').Page) {
  return page.locator('[data-testid^="modifier-add-"]').count();
}

test('#498 a mesh Object offers the modifier stack (the positive control)', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => '__basher_dag' in window);

  await selectAndOpenModifiers(page, 'n_box');
  expect(
    await addButtonCount(page),
    'the cube must offer add buttons — a zero here means the selector is wrong, not the app',
  ).toBeGreaterThan(0);
  await expect(page.getByTestId('modifier-not-applicable')).toHaveCount(0);
});

test('#498 a camera and a light offer NO modifier buttons, and say why', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => '__basher_dag' in window);

  // Establish the instrument on a subject that MUST be non-zero first.
  await selectAndOpenModifiers(page, 'n_box');
  expect(await addButtonCount(page)).toBeGreaterThan(0);

  for (const objectId of ['n_camera', 'n_light']) {
    await selectAndOpenModifiers(page, objectId);
    expect(await addButtonCount(page), `${objectId} must offer no add buttons`).toBe(0);
    // …and it must EXPLAIN itself. A section that is merely empty reads as broken. The note is
    // in the frame, behind a tab marked as one the object cannot take (#1960).
    await expect(page.getByTestId('modifier-not-applicable')).toHaveCount(1);
    await expect(
      page.getByTestId('stack-frame').getByTestId('modifier-not-applicable'),
    ).toBeVisible();
    await expect(page.getByTestId('stack-frame-tab-modifiers')).toHaveAttribute(
      'data-available',
      'false',
    );
  }
});

test('#498 the camera graph is unchanged — nothing is minted where nothing is offered', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => '__basher_dag' in window);

  const before = await page.evaluate(
    () => Object.keys((window as unknown as W).__basher_dag.getState().state.nodes).length,
  );
  await selectAndOpenModifiers(page, 'n_camera');
  expect(await addButtonCount(page)).toBe(0);
  const after = await page.evaluate(
    () => Object.keys((window as unknown as W).__basher_dag.getState().state.nodes).length,
  );
  // The node count is the cheapest honest witness that the refusal is a non-event rather
  // than a partial write.
  expect(after).toBe(before);
});
