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
  __basher_selection: {
    getState: () => { select: (id: string) => void; primaryNodeId: string | null };
  };
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
const OP_COLOR = '#11dd66'; // authored ON the operator — distinct from base AND from the link

// ── S5 (the payoff) ──────────────────────────────────────────────────────────────────
const CUBE3 = 'p394s5_cube3';
const DATA3 = 'p394s5_data3';
const OP3 = 'p394s5_op3';
const SHARED_ROUGH = 0.72; // the Material's roughness — MUST differ from OP3_ROUGH, or
const OP3_ROUGH = 0.11; //   "the third one differs" is true without anything doing it
const EDITED_COLOR = '#ff00aa'; // distinct from every authored colour in the fixture

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
            // #529 — the operator AUTHORS colour as well as roughness. It used to author
            // only roughness and still claim `base.color`, because an override wrote every
            // channel it had a param for whether the director asked or not. The
            // discriminator below is unchanged, but it now rests on authorship rather than
            // on that defect.
            params: {
              roughness: a.opRough,
              color: a.opColor,
              overridden: { roughness: true, color: true },
            },
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
            // Splicing the operator in displaces the object's data edge (#759).
            replace: true,
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
      opColor: OP_COLOR,
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

  // THE PRECEDENCE. `base.color` is AUTHORED on the operator, so the per-field mask wins
  // there; `specular.ior` is outside the override vocabulary entirely, so the wholesale
  // supplier fills it in. Flipping `maskedBy?.[path] ?? suppliedBy` swaps these.
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

// #529 — THE OPERATOR WRITES WHAT THE DIRECTOR AUTHORED, AND NOTHING ELSE.
//
// This lives at the browser tier because BOTH halves of the fix do. The composition half
// has unit coverage; the AUTHORING half does not and cannot — whether the panel writes the
// authored bit alongside the value is a fact about what a React component dispatches, and
// this repo has no component-render tier. Before the decorator was wired into the
// linked-data block, every unit test still passed while an edit to a material operator was
// silently discarded by the fold: the value landed, the bit did not, and the fold reads the
// bit. That is precisely the gap only this tier sees.
test('#529 — an operator at its defaults changes nothing; an edit authors and lands', async ({
  page,
}) => {
  await page.evaluate(
    (a) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const scene = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: a.mat,
            nodeType: 'Material',
            params: {
              material: {
                name: 'authored',
                base: { color: a.matColor, metalness: 0.9 },
                specular: { roughness: a.matRough },
              },
            },
          },
          ...(a.ops as Op[]),
          // EMPTY params — the exact shape that used to reset six of seven channels.
          { type: 'addNode', nodeId: a.op, nodeType: 'MaterialOverrideOp', params: {} },
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
            // Splicing the operator in displaces the object's data edge (#759).
            replace: true,
          },
          {
            type: 'connect',
            from: { node: a.cube, socket: 'out' },
            to: { node: scene, socket: 'children' },
          },
        ],
        'e2e',
        '#529',
      );
    },
    {
      cube: CUBE,
      data: DATA,
      mat: MAT,
      op: OP,
      matColor: MAT_COLOR,
      matRough: OP_ROUGH,
      // No material connect in cubeOps — the Material node above supplies it.
      ops: cubeOps(DATA, CUBE, 4, { name: 'inline', base: { color: BASE_COLOR } }) as unknown,
    },
  );
  await page.evaluate(
    (c) => (window as unknown as UiWindow).__basher_selection.getState().select(c),
    CUBE,
  );
  await openInspectorSection(page, 'material');

  // 1. THE DEFAULT OPERATOR IS A NO-OP, asserted on what the renderer actually drew.
  const atDefaults = await rendered(page, CUBE);
  expect(atDefaults!.color).toBe(MAT_COLOR); // was '#ffffff' before the fix
  expect(atDefaults!.roughness).toBeCloseTo(OP_ROUGH, 5); // was 0.5
  expect(atDefaults!.metalness).toBeCloseTo(0.9, 5); // was 0

  // 2. THE DECORATOR IS THERE TO AUTHOR WITH. Its absence is what made the fix incomplete:
  // the rows were editable and unmarkable, so the fold discarded every edit.
  await expect(page.getByTestId(`inspector-override-dot-${OP}-roughness`)).toBeVisible();

  // 3. AN EDIT AUTHORS THE BIT AND MOVES THE RENDER — one dispatch, both halves.
  const input = page.getByTestId(`inspector-input-${OP}-roughness`);
  await input.fill('0.83');
  await input.press('Enter');
  await expect(page.getByTestId(`inspector-override-dot-${OP}-roughness`)).toHaveAttribute(
    'data-overridden',
    'true',
  );
  await expect.poll(async () => (await rendered(page, CUBE))!.roughness).toBeCloseTo(0.83, 5);

  // 4. …AND ONLY THAT CHANNEL. The sparse claim, on the evaluated material: colour and
  // metalness are still the linked Material's, because nobody authored them on the op.
  const after = await rendered(page, CUBE);
  expect(after!.color).toBe(MAT_COLOR);
  expect(after!.metalness).toBeCloseTo(0.9, 5);
});

// ── S5 — THE PAYOFF ──────────────────────────────────────────────────────────────────
//
// The composable claim, end to end and on the rendered mesh: one Material, three objects,
// one edit, all three move — and the one carrying an override still differs, on exactly
// the channel it authored and no other.
//
// WHY THREE AND NOT TWO. Two objects prove sharing. The THIRD is the one that makes the
// claim composable rather than merely shared: it is linked to the same Material AND wears
// an override operator, so it has to follow the edit on the channels the operator is silent
// about while keeping its own on the one channel it authored. Before #529 this object could
// not have existed in a passing test — an operator at any setting wiped six of seven
// channels to its own defaults, so the third object would have stopped following the shared
// material entirely. This test is the reason that fix was worth making.
//
// VACUITY GUARDS, because "they all agree" is the easiest thing in the world to get for the
// wrong reason:
//   · each cube authors a DIFFERENT base colour underneath, so agreement cannot be accidental
//   · the Material's roughness differs from the operator's, so "the third differs" is a fact
//     about the operator rather than about two numbers that happen to coincide
//   · the edited colour differs from every colour authored anywhere in the fixture
//   · roughness is re-read AFTER the colour edit, so "the override survived" is asserted
//     rather than assumed from it having been true earlier
test('#394 S5 — three objects, one material: edit once and all three move, and the overridden one still differs', async ({
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
            params: {
              material: {
                name: 'shared',
                base: { color: a.matColor },
                specular: { roughness: a.sharedRough },
              },
            },
          },
          ...(a.opsA as Op[]),
          ...(a.opsB as Op[]),
          ...(a.opsC as Op[]),
          // The third object's override: authors roughness ONLY — and authors the BIT,
          // not just the value. A fixture that set the value alone would be silently
          // discarded by the fold and this test would assert nothing.
          {
            type: 'addNode',
            nodeId: a.op3,
            nodeType: 'MaterialOverrideOp',
            params: { roughness: a.op3Rough, overridden: { roughness: true } },
          },
          // Splice the operator between the third data node and its Object.
          {
            type: 'connect',
            from: { node: a.data3, socket: 'out' },
            to: { node: a.op3, socket: 'target' },
          },
          {
            type: 'connect',
            from: { node: a.op3, socket: 'out' },
            to: { node: a.cube3, socket: 'data' },
            // Splicing the operator in displaces the object's data edge (#759).
            replace: true,
          },
          toScene(a.cube),
          toScene(a.cube2),
          toScene(a.cube3),
          link(a.data),
          link(a.data2),
          link(a.data3),
        ],
        'e2e',
        '#394 S5 payoff',
      );
    },
    {
      mat: MAT,
      matColor: MAT_COLOR,
      sharedRough: SHARED_ROUGH,
      cube: CUBE,
      cube2: CUBE2,
      cube3: CUBE3,
      data: DATA,
      data2: DATA2,
      data3: DATA3,
      op3: OP3,
      op3Rough: OP3_ROUGH,
      // Three DIFFERENT authored colours underneath — only the shared material can make
      // all three agree.
      opsA: cubeOps(DATA, CUBE, 4, { name: 'a', base: { color: '#ff0000' } }) as unknown,
      opsB: cubeOps(DATA2, CUBE2, 7, { name: 'b', base: { color: '#00ff00' } }) as unknown,
      opsC: cubeOps(DATA3, CUBE3, 10, { name: 'c', base: { color: '#0000ff' } }) as unknown,
    },
  );

  // Sharing is a STATED fact on the surface, not something the director has to infer.
  await page.evaluate(
    (c) => (window as unknown as UiWindow).__basher_selection.getState().select(c),
    CUBE,
  );
  await openInspectorSection(page, 'material');
  await expect(page.getByTestId('material-link-users')).toHaveText('3');

  // 1. ALL THREE draw the shared material's colour — including the overridden one, whose
  //    operator authored roughness and therefore has no opinion about colour.
  expect((await rendered(page, CUBE))!.color).toBe(MAT_COLOR);
  expect((await rendered(page, CUBE2))!.color).toBe(MAT_COLOR);
  expect((await rendered(page, CUBE3))!.color).toBe(MAT_COLOR);

  // 2. AND THE THIRD DIFFERS — on exactly the channel its operator authored.
  expect((await rendered(page, CUBE))!.roughness).toBeCloseTo(SHARED_ROUGH, 5);
  expect((await rendered(page, CUBE2))!.roughness).toBeCloseTo(SHARED_ROUGH, 5);
  expect((await rendered(page, CUBE3))!.roughness).toBeCloseTo(OP3_ROUGH, 5);

  // 3. ONE edit, on the Material node, through its own inspector row.
  await page.evaluate(
    (m) => (window as unknown as UiWindow).__basher_selection.getState().select(m),
    MAT,
  );
  await openInspectorSection(page, 'material');
  const hex = page.getByTestId(`inspector-colorhex-${MAT}-material.base.color`);
  await hex.fill(EDITED_COLOR);
  await hex.press('Enter');

  // 4. ALL THREE MOVE — the overridden one included. This is the claim #394 exists to make,
  //    and the third object is the half of it that only became true with #529.
  await expect.poll(async () => (await rendered(page, CUBE))!.color).toBe(EDITED_COLOR);
  expect((await rendered(page, CUBE2))!.color).toBe(EDITED_COLOR);
  expect((await rendered(page, CUBE3))!.color).toBe(EDITED_COLOR);

  // 5. …AND THE OVERRIDE SURVIVED THE EDIT. Re-read rather than assumed: a fold that
  //    rebuilt the third object from the edited material would satisfy step 4 and lose this.
  expect((await rendered(page, CUBE3))!.roughness).toBeCloseTo(OP3_ROUGH, 5);
  expect((await rendered(page, CUBE))!.roughness).toBeCloseTo(SHARED_ROUGH, 5);
});

// #394 S5 — DUPLICATING AN OBJECT KEEPS THE MATERIAL SHARED, observed rather than derived.
//
// The rule lives in `OWNED_SOCKETS` (`sceneNodeActions.ts`): duplicate deep-copies what an
// object OWNS — children, wrapper target, its data node — and keeps every other input
// shared. `material` is deliberately absent from that list, so the copy points at the same
// Material node. That is pinned at the unit tier; this is the browser witness for it.
//
// 🔴 THE DISCRIMINATOR, and it is the whole design of this test. "The duplicate renders the
// same colour" CANNOT tell sharing from copying — a private copy of a material holds the
// same values and draws identically. The two hypotheses only separate under a PERTURBATION:
// edit the Material once AFTER duplicating. If the copy is still linked, it moves; if
// duplicate had deep-copied the material, it keeps the old colour. So the assertion that
// carries this test is step 3, and steps 1-2 exist to prove the mesh was found at all.
test('#394 S5 — duplicating a linked object keeps the material shared, not copied', async ({
  page,
}) => {
  await page.evaluate(
    (a) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const scene = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: a.mat,
            nodeType: 'Material',
            params: { material: { name: 'shared', base: { color: a.matColor } } },
          },
          ...(a.ops as Op[]),
          {
            type: 'connect',
            from: { node: a.cube, socket: 'out' },
            to: { node: scene, socket: 'children' },
          },
          {
            type: 'connect',
            from: { node: a.mat, socket: 'out' },
            to: { node: a.data, socket: 'material' },
          },
        ],
        'e2e',
        '#394 S5 duplicate',
      );
      w.__basher_selection.getState().select(a.cube);
    },
    {
      mat: MAT,
      matColor: MAT_COLOR,
      cube: CUBE,
      data: DATA,
      // A DIFFERENT colour authored underneath, so drawing the link's colour is a fact
      // about the link rather than about the cube's own material.
      ops: cubeOps(DATA, CUBE, 4, { name: 'a', base: { color: '#ff0000' } }) as unknown,
    },
  );

  await openInspectorSection(page, 'material');
  await expect(page.getByTestId('material-link-users')).toHaveText('1');

  await page.keyboard.press('Shift+D');

  // Duplicate selects the copy — that is how the new id is known without guessing it.
  const copyId = await page.evaluate(
    () => (window as unknown as UiWindow).__basher_selection.getState().primaryNodeId,
  );
  expect(copyId).toBeTruthy();
  expect(copyId).not.toBe(CUBE);

  // 1. THE COUNT IS A STATED FACT and it moved: the copy is a second USER of one material,
  //    not an owner of a second material.
  await openInspectorSection(page, 'material');
  await expect(page.getByTestId('material-link-users')).toHaveText('2');

  // 2. POSITIVE CONTROL — the copy's mesh is reachable and drawing the shared colour. On
  //    its own this proves nothing about sharing (a copy would look identical); it proves
  //    the probe found the right object, so that step 3's answer means something.
  expect((await rendered(page, copyId!))!.color).toBe(MAT_COLOR);

  // 3. THE DISCRIMINATOR — edit the Material once and the COPY must follow. This is the
  //    only observation in the test that a deep-copied material would fail.
  await page.evaluate(
    (m) => (window as unknown as UiWindow).__basher_selection.getState().select(m),
    MAT,
  );
  await openInspectorSection(page, 'material');
  const hex = page.getByTestId(`inspector-colorhex-${MAT}-material.base.color`);
  await hex.fill(EDITED_COLOR);
  await hex.press('Enter');

  await expect.poll(async () => (await rendered(page, copyId!))!.color).toBe(EDITED_COLOR);
  // …and the original moved with it, so the edit reached both users of the one material.
  expect((await rendered(page, CUBE))!.color).toBe(EDITED_COLOR);
});
