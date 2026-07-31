// #394 S3d — the material data-block row, the operator stack, and the MASK PRECEDENCE
// that no other tier can reach.
//
// ── WHY THIS SPEC IS TRACKED RATHER THAN A PROBE ────────────────────────────────────
//
// Two claims in this slice were falsified and came back GREEN, for the same reason: the
// repo has no component-render tier for the inspector, so nothing below a browser can
// see them. Both were declared in place rather than demoted, and this is where they are
// covered:
//
//   1. MASK PRECEDENCE — `maskedBy?.[path] ?? suppliedBy`. Flipping that expression
//      reddens ZERO unit tests and ZERO type errors. It decides which of TWO coverings
//      a row names when both are present, and getting it backwards makes every row name
//      the wrong layer without any assertion noticing.
//   2. THE OFF-LANE RETURN — the stack and the data-block row must be ABSENT on a node
//      that declares the material section without being on the data lane. Replacing the
//      guard with a fallback kind renders both surfaces on a Material node, and every
//      tier stays green.
//
// ── THE DISCRIMINATOR, READ OFF THE SOURCE RATHER THAN GUESSED ──────────────────────
//
// Precedence is only observable where the two coverings DISAGREE about a field, and the
// first attempt at this fixture failed to produce that: both fields it checked were
// masked by the operator, so both labels read the same and the test proved nothing.
// `composeMaterial.ts:80` settles which is which — an override op writes `base.color`
// UNCONDITIONALLY (there is no `?? base.base.color` there), while roughness and metalness
// are conditional on the authored bit and `specular.ior` is not in the override
// vocabulary at all. So with a linked Material AND an override op on one data node:
//
//   base.color    → masked by the OPERATOR   (maskedBy wins)
//   specular.ior  → supplied by the MATERIAL (suppliedBy fills the rest)
//
// Two different answers from one expression is what makes this a test of the precedence
// rather than of either covering alone.
//
// VACUITY GUARDS: every value differs from every other (base, material and operator each
// author distinct numbers), the two mark titles are asserted to DIFFER, and the Material
// node case leads with a positive control so an absence is an absence of the two surfaces
// and not of the panel.

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
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_mesh_material?: (id: string) => { roughness: number; color: string } | null;
}

const CUBE = 'p394s3d_cube';
const DATA = 'p394s3d_data';
const CUBE2 = 'p394s3d_cube2';
const DATA2 = 'p394s3d_data2';
const MAT = 'p394s3d_mat';
const OP = 'p394s3d_op';

const BASE_COLOR = '#ff8800'; // authored on the data node — covered by both layers
const BASE_ROUGH = 0.9;
const MAT_COLOR = '#2244ff'; // the linked Material's colour
const MAT_IOR = 1.9; // ONLY the Material can supply this — the op has no ior
const OP_ROUGH = 0.2;

function rendered(page: import('@playwright/test').Page, id: string) {
  return page.evaluate((n) => (window as unknown as UiWindow).__basher_mesh_material!(n), id);
}

async function boot(page: import('@playwright/test').Page) {
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
}

function cubeOps(data: string, cube: string, x: number, material: unknown): Op[] {
  return [
    {
      type: 'addNode',
      nodeId: data,
      nodeType: 'BoxData',
      params: { size: [1, 1, 1], material },
    },
    { type: 'addNode', nodeId: cube, nodeType: 'Object', params: { position: [x, 0, 0] } },
    { type: 'connect', from: { node: data, socket: 'out' }, to: { node: cube, socket: 'data' } },
  ];
}

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('#394 S3d — the data-block row and the operator stack both render on a data node', async ({
  page,
}) => {
  await page.evaluate(
    (a) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const scene = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          ...(a.ops as Op[]),
          {
            type: 'connect',
            from: { node: a.cube, socket: 'out' },
            to: { node: scene, socket: 'children' },
          },
        ],
        'e2e',
        '#394 S3d cube',
      );
    },
    {
      cube: CUBE,
      ops: cubeOps(DATA, CUBE, 4, {
        name: 'inline',
        base: { color: BASE_COLOR },
        specular: { roughness: BASE_ROUGH },
      }) as unknown,
    },
  );
  await page.evaluate(
    (c) => (window as unknown as UiWindow).__basher_selection.getState().select(c),
    CUBE,
  );
  await openInspectorSection(page, 'material');

  await expect(page.getByTestId('material-link')).toBeVisible();
  await expect(page.getByTestId('material-op-stack')).toBeVisible();
  // Unlinked reads as INLINE, not as an empty pointer — sharing is a stated fact in
  // both directions or the count means nothing.
  await expect(page.getByTestId('material-link-status')).toContainText('inline');
  // Nothing to unlink yet: the affordance is absent rather than inert.
  await expect(page.getByTestId('material-link-unlink')).toHaveCount(0);

  // NEW MATERIAL IS VALUE-PRESERVING — the graph changes, the picture does not. Blender
  // mints a default grey here; doing that would discard the authored material at the
  // exact moment the user asked to make it shareable.
  const before = await rendered(page, CUBE);
  expect(before!.color).toBe(BASE_COLOR); // the fixture really did author a distinct colour
  await page.getByTestId('material-link-new').click();
  await expect(page.getByTestId('material-link-unlink')).toBeVisible();
  expect(await rendered(page, CUBE)).toEqual(before);
  await expect(page.getByTestId('material-link-users')).toHaveText('1');
});

test('#394 S3d — MASK PRECEDENCE: the operator names its own field, the link names the rest', async ({
  page,
}) => {
  await page.evaluate(
    (a) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const scene = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          ...(a.ops as Op[]),
          {
            type: 'addNode',
            nodeId: a.mat,
            nodeType: 'Material',
            params: {
              material: {
                name: 'shared',
                base: { color: a.matColor },
                specular: { ior: a.matIor },
              },
            },
          },
          {
            type: 'addNode',
            nodeId: a.op,
            nodeType: 'MaterialOverrideOp',
            params: { roughness: a.opRough, overridden: { roughness: true } },
          },
          // BOTH coverings at once — this is the only shape where precedence is visible.
          {
            type: 'connect',
            from: { node: a.mat, socket: 'out' },
            to: { node: a.data, socket: 'material' },
          },
          {
            type: 'connect',
            from: { node: a.data, socket: 'out' },
            to: { node: a.op, socket: 'target' },
          },
          {
            type: 'connect',
            from: { node: a.op, socket: 'out' },
            to: { node: a.cube, socket: 'data' },
          },
          {
            type: 'connect',
            from: { node: a.cube, socket: 'out' },
            to: { node: scene, socket: 'children' },
          },
        ],
        'e2e',
        '#394 S3d precedence',
      );
    },
    {
      cube: CUBE,
      data: DATA,
      mat: MAT,
      op: OP,
      matColor: MAT_COLOR,
      matIor: MAT_IOR,
      opRough: OP_ROUGH,
      // NOTE: the data node's material has NO `material` connect in cubeOps — the
      // connect below supplies it, which is what makes the base a covered layer.
      ops: cubeOps(DATA, CUBE, 4, {
        name: 'inline',
        base: { color: BASE_COLOR },
        specular: { roughness: BASE_ROUGH },
      }) as unknown,
    },
  );
  await page.evaluate(
    (c) => (window as unknown as UiWindow).__basher_selection.getState().select(c),
    CUBE,
  );
  await openInspectorSection(page, 'material');

  const colorTitle = await page
    .getByTestId(`inspector-masked-${DATA}-material.base.color`)
    .getAttribute('title');
  const iorTitle = await page
    .getByTestId(`inspector-masked-${DATA}-material.specular.ior`)
    .getAttribute('title');

  // Both rows ARE marked — the base is covered either way, so an unmarked row would be
  // the #525 defect (a widget showing a number the viewport is not drawing, unlabelled).
  expect(colorTitle, 'base.color must be marked').toBeTruthy();
  expect(iorTitle, 'specular.ior must be marked').toBeTruthy();

  // THE PRECEDENCE. `base.color` is written unconditionally by the operator, so the
  // per-field mask wins there; `specular.ior` is outside the override vocabulary, so the
  // wholesale supplier fills it in. Flipping `maskedBy?.[path] ?? suppliedBy` swaps these.
  expect(iorTitle).toContain(MAT);
  expect(colorTitle).not.toContain(MAT);
  // …and they genuinely differ, which is the assertion a single-covering fixture cannot
  // make and the reason the first version of this test proved nothing.
  expect(colorTitle).not.toBe(iorTitle);

  // THE LABEL IS NOT A LOCK. Ruled, and measured: removing a covering restores the
  // authored value, so the base is a fallback and must stay editable.
  const baseColorInput = page.getByTestId(`inspector-colorhex-${DATA}-material.base.color`);
  await expect(baseColorInput).toBeEnabled();
  await expect(baseColorInput).not.toHaveAttribute('readonly', /.*/);
});

test('#394 S3d — a Material node gets neither surface, and the section still renders', async ({
  page,
}) => {
  await page.evaluate((mat) => {
    (window as unknown as UiWindow).__basher_dag
      .getState()
      .dispatchAtomic(
        [{ type: 'addNode', nodeId: mat, nodeType: 'Material', params: {} }],
        'e2e',
        '#394 S3d material node',
      );
  }, MAT);
  await page.evaluate(
    (m) => (window as unknown as UiWindow).__basher_selection.getState().select(m),
    MAT,
  );
  await openInspectorSection(page, 'material');

  // POSITIVE CONTROL FIRST. Without it, the two absences below are indistinguishable
  // from a panel that failed to render at all — a uniform null result indicting the
  // instrument rather than the product.
  await expect(page.getByTestId(`inspector-input-${MAT}-material.specular.roughness`)).toHaveCount(
    1,
  );
  // A Material node is what the lane POINTS AT. A stack panel here would be a category
  // error, and an empty one reads as "this material has no operators yet" — a sentence
  // about the wrong noun.
  await expect(page.getByTestId('material-link')).toHaveCount(0);
  await expect(page.getByTestId('material-op-stack')).toHaveCount(0);
});

test('#394 S3d — two objects, one material, edited once: the payoff on the rendered mesh', async ({
  page,
}) => {
  await page.evaluate(
    (a) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const scene = dag.state.outputs.scene!.node;
      const link = (data: string): Op => ({
        type: 'connect',
        from: { node: a.mat, socket: 'out' },
        to: { node: data, socket: 'material' },
      });
      const toScene = (cube: string): Op => ({
        type: 'connect',
        from: { node: cube, socket: 'out' },
        to: { node: scene, socket: 'children' },
      });
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: a.mat,
            nodeType: 'Material',
            params: { material: { name: 'shared', base: { color: a.matColor } } },
          },
          ...(a.opsA as Op[]),
          ...(a.opsB as Op[]),
          toScene(a.cube),
          toScene(a.cube2),
          link(a.data),
          link(a.data2),
        ],
        'e2e',
        '#394 S3d sharing',
      );
    },
    {
      mat: MAT,
      matColor: MAT_COLOR,
      cube: CUBE,
      cube2: CUBE2,
      data: DATA,
      data2: DATA2,
      // Each cube authors a DIFFERENT colour underneath, so "both are the same" cannot
      // be true by accident — only the shared material can make them agree.
      opsA: cubeOps(DATA, CUBE, 4, { name: 'a', base: { color: '#ff0000' } }) as unknown,
      opsB: cubeOps(DATA2, CUBE2, 7, { name: 'b', base: { color: '#00ff00' } }) as unknown,
    },
  );

  await page.evaluate(
    (c) => (window as unknown as UiWindow).__basher_selection.getState().select(c),
    CUBE,
  );
  await openInspectorSection(page, 'material');
  // Sharing is a STATED fact, not something the user has to remember wiring.
  await expect(page.getByTestId('material-link-users')).toHaveText('2');

  expect((await rendered(page, CUBE))!.color).toBe(MAT_COLOR);
  expect((await rendered(page, CUBE2))!.color).toBe(MAT_COLOR);

  // ONE edit, on the Material node, through its own inspector row.
  await page.evaluate(
    (m) => (window as unknown as UiWindow).__basher_selection.getState().select(m),
    MAT,
  );
  await openInspectorSection(page, 'material');
  const hex = page.getByTestId(`inspector-colorhex-${MAT}-material.base.color`);
  await hex.fill('#00ff44');
  await hex.press('Enter');

  // BOTH move, on the rendered mesh — not on the store, and not on a param that happens
  // to match. This is the claim #394 exists to make.
  expect((await rendered(page, CUBE))!.color).toBe('#00ff44');
  expect((await rendered(page, CUBE2))!.color).toBe('#00ff44');
});
