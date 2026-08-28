// #394 P7 — promoting two params onto ONE control, authored and turned in the browser.
//
// ── WHY THIS DEMO AND NOT THE ONE THE PLAN NAMES ────────────────────────────────────
//
// PLAN-3 §4 P7 says "promote a modifier's `count` and an override op's `roughness` onto one
// control". Both halves were measured impossible while building the builder:
//
//   • `count` cannot be driven AT ALL. It is consumed by `evaluate` to BUILD geometry, and
//     every overlay species folds at the render and read seams — after the cook. Driving it
//     moves the resolver 2→9 and leaves the geometry at 2 (filed as #524, live on `main`).
//   • `count` + `roughness` is int + float, and one knob cannot carry both — refused rather
//     than coerced, because a shared knob would make one of its drives lie about its steps.
//
// So the demo is two FLOAT MATERIAL params on one knob. Both fold through the lane overlay
// the same way, and their paths differ in the composed value (`specular.roughness` versus
// `base.metalness`), so a translation that collapsed them would be visible here.
//
// ── WHAT IS OBSERVED, AND WHY IT IS THE RENDERED MATERIAL ───────────────────────────
//
// The assertion reads `__basher_mesh_material` — what the mesh ACTUALLY carries — and never
// the resolver. That is #524's whole lesson: the read road and the render road are the two
// things that fold, so anything asking the resolver confirms the rail's answer rather than
// the cook's. A promote that moved the resolver and not the mesh would pass a resolver
// assertion and be worthless.
//
// VACUITY GUARDS: the two seeded values DIFFER from each other and BOTH differ from the
// value the knob is moved to, so a row that never bound, a drive that never landed, and a
// knob that wrote nothing are all separable from a pass. The falsification is in the test
// itself — one drive is unbound and the other must keep following.

import { expect, test } from './_fixtures';
import { openInspectorSection } from './_inspectorSections';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface UiWindow {
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<string, { type: string; params?: unknown; spare?: unknown }>;
      };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_mesh_material?: (
    id: string,
  ) => { roughness: number | null; metalness: number | null } | null;
}

const CUBE = 'p394p7_cube';
const DATA = 'p394p7_data';
const OP = 'p394p7_op';

const SEED_ROUGHNESS = 0.2; // what the operator authors for roughness
const SEED_METALNESS = 0.8; // …and for metalness — DIFFERENT, so one knob is visible
const KNOB = 0.55; // where the control is moved — differs from both seeds

function rendered(page: import('@playwright/test').Page) {
  return page.evaluate((id) => (window as unknown as UiWindow).__basher_mesh_material!(id), CUBE);
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
    const w = window as unknown as UiWindow;
    return Boolean(
      w.__basher_selection &&
      w.__basher_mesh_material &&
      w.__basher_dag &&
      w.__basher_dag.getState().state.outputs.scene,
    );
  });

  //   DATA ──▶ OP (forces roughness + metalness) ──▶ CUBE(.data) ──▶ scene
  await page.evaluate(
    ({ cube, data, op, rough, metal }) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: data,
            nodeType: 'BoxData',
            params: { size: [1, 1, 1], material: { name: 'inline' } },
          },
          {
            type: 'addNode',
            nodeId: op,
            nodeType: 'MaterialOverrideOp',
            params: {
              roughness: rough,
              metalness: metal,
              overridden: { roughness: true, metalness: true },
            },
          },
          { type: 'addNode', nodeId: cube, nodeType: 'Object', params: { position: [4, 0, 0] } },
          {
            type: 'connect',
            from: { node: data, socket: 'out' },
            to: { node: op, socket: 'target' },
          },
          {
            type: 'connect',
            from: { node: op, socket: 'out' },
            to: { node: cube, socket: 'data' },
            // Splicing the operator in displaces the object's data edge (#759).
            replace: true,
          },
          {
            type: 'connect',
            from: { node: cube, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ],
        'e2e',
        '#394 P7 cube with a two-field material operator',
      );
    },
    { cube: CUBE, data: DATA, op: OP, rough: SEED_ROUGHNESS, metal: SEED_METALNESS },
  );

  await page.evaluate(
    (cube) => (window as unknown as UiWindow).__basher_selection.getState().select(cube),
    CUBE,
  );
  await openInspectorSection(page, 'material');
});

test('#394 P7 — two float material params promoted onto one control, and the mesh follows', async ({
  page,
}) => {
  // (0) the seeds are genuinely different and the mesh shows them, or everything below is
  // vacuous — a knob that moved nothing would still "agree" with equal values.
  expect(SEED_ROUGHNESS).not.toBe(SEED_METALNESS);
  expect(KNOB).not.toBe(SEED_ROUGHNESS);
  expect(KNOB).not.toBe(SEED_METALNESS);
  await expect
    .poll(() => rendered(page), { timeout: 10_000 })
    .toMatchObject({ roughness: SEED_ROUGHNESS, metalness: SEED_METALNESS });

  // (1) PROMOTE roughness → a control named "shine". The affordance sits on the operator's
  // own row, which is an ordinary numeric row in the material card since P3.
  await page.getByTestId(`inspector-promote-${OP}-roughness`).click();
  const nameField = page.getByTestId(`inspector-promote-name-${OP}-roughness`);
  await nameField.fill('shine');
  await page.getByTestId(`inspector-promote-commit-${OP}-roughness`).click();

  // The control renders — on the Null the promote minted, in the material card. Its host id
  // is not known to this test, which is the point: the row is read back off the graph.
  // The `:not(...)` excludes the knob INPUT, whose testid is a prefix-extension of the
  // row's — without it this locator quietly matches two elements per control.
  const control = page.locator(
    '[data-testid^="inspector-promoted-"][data-testid$="-shine"]:not([data-testid^="inspector-promoted-value-"])',
  );
  await expect(control).toHaveCount(1);

  // (2) JOIN: promote metalness onto the SAME control by naming it. This is the 1:N road —
  // it must add only a drive, not a second knob.
  await page.getByTestId(`inspector-promote-${OP}-metalness`).click();
  await page.getByTestId(`inspector-promote-name-${OP}-metalness`).fill('shine');
  await page.getByTestId(`inspector-promote-commit-${OP}-metalness`).click();
  await expect(control).toHaveCount(1);

  // Two drives on one control.
  const drives = page.locator('[data-testid^="inspector-promoted-drive-"]');
  await expect(drives).toHaveCount(2);

  // Joining snaps the joined param to the control's value — one knob holds ONE value, so
  // both drives now report it. Asserted on the MESH.
  await expect
    .poll(() => rendered(page), { timeout: 10_000 })
    .toMatchObject({ roughness: SEED_ROUGHNESS, metalness: SEED_ROUGHNESS });

  // (3) TURN THE KNOB — the whole point. Both fields must follow, on the mesh.
  const knob = page.locator('[data-testid^="inspector-promoted-value-"][data-testid$="-shine"]');
  await knob.fill(String(KNOB));
  await knob.blur();
  await expect
    .poll(() => rendered(page), { timeout: 10_000 })
    .toMatchObject({ roughness: KNOB, metalness: KNOB });

  // (4) FALSIFICATION, in the test: unbind ONE drive and only the other keeps following.
  // Without this the assertions above are satisfied by anything that writes both fields.
  //
  // WHICH drive is unbound is READ off the chip, never assumed: the drives are ordered by
  // chain address, so hardcoding "the first one is metalness" would make this assertion
  // depend on a sort it does not own.
  const firstDrive = drives.first();
  const chipText = (await firstDrive.textContent()) ?? '';
  const unbound = chipText.includes('metalness') ? 'metalness' : 'roughness';
  const stillDriven = unbound === 'metalness' ? 'roughness' : 'metalness';
  await firstDrive.getByRole('button').click();
  await expect(drives).toHaveCount(1);
  // The control SURVIVES losing a drive — its value, name and home are the interface the
  // user authored, and a control that evaporated would silently reset it.
  await expect(control).toHaveCount(1);

  const AGAIN = 0.35;
  await knob.fill(String(AGAIN));
  await knob.blur();
  // The still-driven field follows. The unbound one goes back to the value its OWN node
  // authors — a driver is an overlay folded at the seam, so removing it reveals the base
  // rather than freezing the last driven number. That the two answers differ is what makes
  // this a falsification and not a restatement: only one field is following the knob now.
  const seedOf = { roughness: SEED_ROUGHNESS, metalness: SEED_METALNESS };
  await expect
    .poll(() => rendered(page), { timeout: 10_000 })
    .toMatchObject({ [stillDriven]: AGAIN, [unbound]: seedOf[unbound] });
  expect(seedOf[unbound]).not.toBe(AGAIN);
});
