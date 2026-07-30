// #394 P3 / #518 — the material section shows the LANE, and every row edits its own node.
//
// ── WHAT WAS BROKEN, MEASURED BEFORE THE FIX ────────────────────────────────────────
//
// A data-lane material operator's fields were in the projection and rendered NOWHERE, so
// the authority for a field the operator supplies could not be reached from the interface
// at all. The base row was still editable, still accepted the edit, and the viewport did
// not move — because the composed material takes that field from the operator. Reproduced
// live before this slice: stored `#ff0066`, rendered stayed `#00ff88`, nothing thrown and
// nothing logged.
//
// The mechanism was NOT "the editor writes past the owner", which is what the issue
// originally said. Every widget already addressed the node its rows came from. The fault
// was one layer earlier: the panel regrouped rows into bare param-path strings and then
// re-attached ONE block-level node id to all of them. Harmless while a block was fed by a
// single node; wrong the moment the material section is fed by the base AND an operator.
//
// ── WHAT THIS PINS ──────────────────────────────────────────────────────────────────
//
// 1. the operator's rows are SHOWN, addressed to the OPERATOR;
// 2. the base's rows are still shown, addressed to the BASE, and still editable;
// 3. editing the operator's row moves the viewport;
// 4. editing the base's masked row does NOT move the viewport — deliberately. A base row
//    stays editable and masking is a LABEL, never a redirect: redirecting the write is
//    what makes the failure silent. The label itself is the next stage; this asserts the
//    write target, which is what P3 owns.
//
// VACUITY GUARDS: the base and operator roughness values DIFFER, and the edits move
// AWAY from both, so a row that never rendered, never took the edit, or addressed the
// wrong node cannot pass. The op's id and the base's id are asserted to be distinct.
//
// The graph is built by hand because no UI road mints a material operator yet — which is
// exactly why this defect was latent rather than reported.

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
        nodes: Record<string, { type: string; params?: unknown }>;
      };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_mesh_material?: (id: string) => { roughness: number | null } | null;
}

const CUBE = 'p394p3_cube';
const DATA = 'p394p3_data';
const OP = 'p394p3_op';

const BASE_ROUGHNESS = 0.9; // what the DATA node authors
const OP_ROUGHNESS = 0.2; // what the operator FORCES
const TYPED_ON_OP = 0.45; // an edit to the operator's row — must reach the viewport
const TYPED_ON_BASE = 0.65; // an edit to the masked base row — must NOT reach it

function renderedRoughness(page: import('@playwright/test').Page): Promise<number | null> {
  return page.evaluate(
    (id) => (window as unknown as UiWindow).__basher_mesh_material!(id)?.roughness ?? null,
    CUBE,
  );
}

function storedNumber(
  page: import('@playwright/test').Page,
  nodeId: string,
  path: readonly string[],
): Promise<number | null> {
  return page.evaluate(
    ({ id, p }) => {
      const nodes = (window as unknown as UiWindow).__basher_dag.getState().state.nodes;
      let cur: unknown = nodes[id]?.params;
      for (const seg of p) cur = (cur as Record<string, unknown> | undefined)?.[seg];
      return typeof cur === 'number' ? cur : null;
    },
    { id: nodeId, p: [...path] },
  );
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

  //   DATA ──▶ OP (forces roughness) ──▶ CUBE(.data) ──▶ scene
  await page.evaluate(
    ({ cube, data, op, baseRough, opRough }) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: data,
            nodeType: 'BoxData',
            params: {
              size: [1, 1, 1],
              material: { name: 'inline', specular: { roughness: baseRough } },
            },
          },
          {
            type: 'addNode',
            nodeId: op,
            nodeType: 'MaterialOverrideOp',
            // The authored BIT is what makes the operator the authority for roughness —
            // the composition rule consults it for roughness/metalness (the two channels
            // where forcing a scalar over a source map is a real choice).
            params: { roughness: opRough, overridden: { roughness: true } },
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
          },
          {
            type: 'connect',
            from: { node: cube, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ],
        'e2e',
        '#394 P3 cube with a forcing material operator',
      );
    },
    { cube: CUBE, data: DATA, op: OP, baseRough: BASE_ROUGHNESS, opRough: OP_ROUGHNESS },
  );

  await page.evaluate(
    (cube) => (window as unknown as UiWindow).__basher_selection.getState().select(cube),
    CUBE,
  );
  await openInspectorSection(page, 'material');
});

test("#518 — the material section shows the operator's rows AND the base's, each on its own node", async ({
  page,
}) => {
  // The nodes are genuinely different, or every assertion below is vacuous.
  expect(OP).not.toBe(DATA);

  const opRow = page.getByTestId(`inspector-input-${OP}-roughness`);
  const baseRow = page.getByTestId(`inspector-input-${DATA}-material.specular.roughness`);

  // (1) the operator's row exists and is addressed to the OPERATOR. Before P3 this row
  // did not render at all — the operator contributed zero widgets to the panel.
  await expect(opRow).toBeVisible();
  await expect(opRow).toHaveValue(String(OP_ROUGHNESS));

  // (2) the base's row is still there, on the BASE, and still carries its own value —
  // it is masked, not hidden and not redirected.
  await expect(baseRow).toBeVisible();
  await expect(baseRow).toHaveValue(String(BASE_ROUGHNESS));

  // …and no widget in the panel addresses a node that is not in the chain. This is the
  // half that reddens if the block re-attaches one id to every row it draws.
  const nodeIds = await page.evaluate(() => {
    const ids = new Set<string>();
    document
      .querySelector('[data-testid="inspector-linked-data"]')
      ?.querySelectorAll('[data-testid]')
      .forEach((el) => {
        const m =
          /^inspector-(?:input|scrub|color|colorhex|diamond|driver-bind|override-dot|vec)-(.+?)-(.+)$/.exec(
            el.getAttribute('data-testid') ?? '',
          );
        if (m) ids.add(m[1]!);
      });
    return [...ids];
  });
  expect(new Set(nodeIds)).toEqual(new Set([DATA, OP]));
});

test("#518 — editing the operator's row moves the viewport; editing the masked base row does not", async ({
  page,
}) => {
  // PRECONDITION, asserted not assumed: the operator IS the authority before we type.
  await expect.poll(() => renderedRoughness(page)).toBeCloseTo(OP_ROUGHNESS, 5);

  // ── the operator's row ────────────────────────────────────────────────────────────
  const opRow = page.getByTestId(`inspector-input-${OP}-roughness`);
  await opRow.fill(String(TYPED_ON_OP));
  await opRow.press('Enter');

  await expect.poll(() => storedNumber(page, OP, ['roughness'])).toBeCloseTo(TYPED_ON_OP, 5);
  // The write landed on the OPERATOR, so the viewport follows. Had the row been drawn
  // against the block's node id, this would have written to the base and nothing would
  // have moved — the defect, in the direction P3 makes reachable.
  await expect.poll(() => renderedRoughness(page)).toBeCloseTo(TYPED_ON_OP, 5);

  // ── the base's masked row ─────────────────────────────────────────────────────────
  const baseRow = page.getByTestId(`inspector-input-${DATA}-material.specular.roughness`);
  await baseRow.fill(String(TYPED_ON_BASE));
  await baseRow.press('Enter');

  // It is editable and the write lands on the BASE — provenance, not a redirect.
  await expect
    .poll(() => storedNumber(page, DATA, ['material', 'specular', 'roughness']))
    .toBeCloseTo(TYPED_ON_BASE, 5);
  // …and the viewport keeps the operator's value, because the operator supplies it.
  // This is CORRECT under the declared precedence ladder, not a bug: what is still
  // missing is the label saying so, which is the stage after this one.
  expect(await renderedRoughness(page)).toBeCloseTo(TYPED_ON_OP, 5);
});

test("#518 — an operator's section that the base does NOT declare still renders", async ({
  page,
}) => {
  // The cards a linked-data block draws come from the BASE node's declared sections. An
  // operator declares its own, and they need not be a subset: `CurveData` declares
  // ['curve'] and a material operator declares ['material']. Without the union the
  // operator's six rows route to a card that is never drawn and disappear with no signal
  // — the operator is in the lane, and unreachable.
  //
  // DECLARED LIMIT, and it is a design question rather than a defect: a material operator
  // over non-mesh data is INERT (its evaluate passes the source through untouched), so
  // these rows edit nothing visible. That is the same offer-versus-accept axis the
  // modifier section answered per data kind, and it becomes reachable only when a UI road
  // mints a material operator. Showing the rows is still strictly better than hiding
  // them: hidden, the node cannot even be found.
  await page.evaluate(
    ({ curveObj, curveData, op }) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          { type: 'addNode', nodeId: curveData, nodeType: 'CurveData', params: {} },
          { type: 'addNode', nodeId: op, nodeType: 'MaterialOverrideOp', params: {} },
          {
            type: 'addNode',
            nodeId: curveObj,
            nodeType: 'Object',
            params: { position: [0, 0, 6] },
          },
          {
            type: 'connect',
            from: { node: curveData, socket: 'out' },
            to: { node: op, socket: 'target' },
          },
          {
            type: 'connect',
            from: { node: op, socket: 'out' },
            to: { node: curveObj, socket: 'data' },
          },
          {
            type: 'connect',
            from: { node: curveObj, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ],
        'e2e',
        '#394 P3 a material operator over a curve',
      );
    },
    { curveObj: 'p394p3_curve', curveData: 'p394p3_curvedata', op: 'p394p3_curveop' },
  );

  await page.evaluate(
    (id) => (window as unknown as UiWindow).__basher_selection.getState().select(id),
    'p394p3_curve',
  );

  // The base's own card is there — the control that says the block rendered at all.
  await expect(page.getByTestId('inspector-section-curve')).toBeVisible();
  // …and so is the operator's, which the base never declared.
  await openInspectorSection(page, 'material');
  await expect(page.getByTestId('inspector-input-p394p3_curveop-roughness')).toBeVisible();
});
