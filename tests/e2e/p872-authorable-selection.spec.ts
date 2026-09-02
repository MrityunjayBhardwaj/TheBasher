// #872 / #873 — A DIRECTOR AUTHORS A COMPONENT SELECTION BY TYPING IT, IN THE RUNNING APP.
//
// ── WHAT ONLY THIS ROAD CAN SEE ────────────────────────────────────────────────────────
//
// The unit gate pins that the widget is declared, that it reaches all six scoped operators,
// and that the refusal message is the schema's own. Three claims are invisible to it:
//
// 1. **THE CONTROL IS REAL AND EDITABLE, AND WHAT IS TYPED ARRIVES.** Until now `scope`
//    rendered as a label with its value and no input, so every scoped operator was driven in
//    e2e through `setParam` instead. `p847-angle-limit-bevel.spec.ts` says exactly that in its
//    own header, and called `angleLimit` "the FIRST selection an author can name" precisely
//    because a number got a generic row and a string did not. This file retires that sentence
//    for the string too.
//
// 2. **🔴 A REFUSED QUERY IS A STATE, NOT AN EVENT (#873).** `applySetParam` re-validates and
//    THROWS, and a text control's valid range — any text a person can type — is far wider than
//    the query grammar. `arm*` is Houdini's documented wildcard AND is named in this project's
//    own deferred list, so it is among the first things a director will try. The field parses
//    the draft against the param's declared schema and only dispatches what will be accepted,
//    so the refusal becomes something the row HOLDS and shows. Only this road proves the page
//    survives it and that the message is genuinely on screen.
//
// 3. **IT RECOVERS.** A refusal that stuck would satisfy claim 2 and be useless. The author
//    must be able to fix the query and carry on — and the draft must still be there to fix,
//    rather than having been reverted underneath them.
//
// ── 🔴 MEASURE THE INDEX, NEVER THE POSITIONS — AND THIS COST AN ISSUE ────────────────
//
// A scoped build is an INDEX subset over UNCHANGED attribute buffers. The positions of the
// faces it drops stay in the buffer and `mergeGeometries` copies them out verbatim, so
// `position.count` is exactly the number a scope does NOT move. `geometryRegistry.ts` says so
// above `elementSubset`: *"it is why every assertion about a scoped build reads
// `getIndex().count` and never `position.count`."*
//
// This file was first written counting positions — the helper was lifted from the bevel spec,
// where positions ARE the right measure because a bevel mints real vertices — and every query
// then read the same 72. That was filed as a defect (#875, now closed as invalid) before the
// instrument was checked. A count that is identical across a swept parameter is the signature
// of the wrong instrument, not of a dead feature, and the swept parameter here included the
// value at which the operation is a no-op.
//
// So `countsUnder` below returns BOTH: `idx` is the measure that moves, `pos` is asserted as
// the one that must stay put, and they travel together so neither can be read alone.
//
// ── WHAT ONLY THIS ROAD CAN SEE, CONTINUED ────────────────────────────────────────────
//
// A box face is two triangles, so six index entries. A `MaskModifier` keeping the faces its
// scope names therefore gives, on a unit cube:
//
//   blank scope  → nothing authored → all six faces  → 36 index entries (and 24 positions)
//   `0-2`        → three faces                       → 18
//   `0`          → one face                          →  6
//
// Each is a face count times six, so a wrong answer cannot coincidentally look right, and the
// positions stay 24 throughout by design.
//
// REF: src/nodes/paramWidget.ts (the declaration); src/app/NPanel.tsx (`QueryField`, and why
//      it validates before dispatching); src/nodes/componentSelection.ts (`scopeParam`, the
//      refusal message); src/app/geometryRegistry.ts (`elementSubset`, and why the index is
//      the measure); src/app/paramWidgetDeclaration.gate.test.ts (the same claims at the unit
//      tier); issues #872, #873, #667, #521.

import { expect, test } from './_fixtures';
import { openInspectorSection } from './_inspectorSections';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface UiWindow {
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_three: {
    getState: () => { scene: { traverse: (cb: (o: unknown) => void) => void } | null };
  };
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<string, { type: string; params: Record<string, unknown> }>;
      };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
}

const CUBE = 'p872_cube';
const CUBE_DATA = 'p872_cube_data';

/** Six quad faces, one renderer position per face-corner — what a scope must NOT move. */
const CUBE_POS = 6 * 4;
/** A box face is two triangles, so six index entries. This is what a scope DOES move. */
const PER_FACE = 6;
const ALL_SIX_FACES = 6 * PER_FACE;

/** The `scope` this modifier node currently carries in the DAG — what the control produced. */
function scopeParamOf(page: import('@playwright/test').Page, modifierId: string): Promise<unknown> {
  return page.evaluate((id) => {
    const w = window as unknown as UiWindow;
    return w.__basher_dag.getState().state.nodes[id]?.params.scope;
  }, modifierId);
}

/**
 * BOTH counts under the scene child named `nodeId` — index entries and positions.
 *
 * Returned as a pair on purpose. The index is what a scope moves and the positions are what it
 * deliberately does not, so reporting them together makes the two impossible to confuse; a row
 * that asserted only one of them is how #875 got filed. `-1` when nothing mounted, which must
 * never read as a clean zero.
 */
function countsUnder(
  page: import('@playwright/test').Page,
  nodeId: string,
): Promise<{ idx: number; pos: number }> {
  return page.evaluate((id) => {
    const w = window as unknown as UiWindow;
    const scene = w.__basher_three.getState().scene;
    let root: unknown = null;
    scene?.traverse((o) => {
      if ((o as { name?: string }).name === id && !root) root = o;
    });
    if (!root) return { idx: -1, pos: -1 };
    let idx = 0;
    let pos = 0;
    (root as { traverse: (cb: (o: unknown) => void) => void }).traverse((o) => {
      const m = o as {
        type: string;
        geometry?: {
          index?: { count: number } | null;
          attributes?: { position?: { count: number } };
        };
      };
      if (m.type === 'Mesh' && m.geometry?.attributes?.position) {
        pos += m.geometry.attributes.position.count;
        idx += m.geometry.index ? m.geometry.index.count : 0;
      }
    });
    return { idx, pos };
  }, nodeId);
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
      w.__basher_three &&
      w.__basher_dag &&
      w.__basher_dag.getState().state.outputs.scene,
    );
  });
  await page.evaluate(
    ({ cube, data }) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          { type: 'addNode', nodeId: data, nodeType: 'BoxData', params: { size: [1, 1, 1] } },
          { type: 'addNode', nodeId: cube, nodeType: 'Object', params: { position: [4, 0, 0] } },
          {
            type: 'connect',
            from: { node: data, socket: 'out' },
            to: { node: cube, socket: 'data' },
          },
          {
            type: 'connect',
            from: { node: cube, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ],
        'e2e',
        'p872 base split cube',
      );
    },
    { cube: CUBE, data: CUBE_DATA },
  );
  await page.evaluate(
    (cube) => (window as unknown as UiWindow).__basher_selection.getState().select(cube),
    CUBE,
  );
  await openInspectorSection(page, 'modifier');
  await expect.poll(() => countsUnder(page, CUBE)).toEqual({ idx: ALL_SIX_FACES, pos: CUBE_POS });
});

/**
 * Adds the mask through the panel and EXPANDS its row so the param controls mount. The expand
 * is load-bearing: a modifier's controls exist only while its row is open, and a collapsed row
 * and an absent control are the same `false`.
 */
async function addExpandedMask(page: import('@playwright/test').Page): Promise<string> {
  const stack = page.getByTestId('modifier-stack');
  await page.getByTestId('modifier-add-MaskModifier').click();
  await expect(stack.locator('[data-testid^="modifier-row-"]')).toHaveCount(1);
  const row = stack.locator('[data-testid^="modifier-row-"]').first();
  const modifierId = (await row.getAttribute('data-testid'))!.replace('modifier-row-', '');
  await row.click();
  // Assert the controls mounted rather than assuming the click landed.
  await expect(page.getByTestId(`inspector-query-${modifierId}-scope`)).toBeVisible();
  return modifierId;
}

test('#872 — a director types a component selection into a real control', async ({ page }) => {
  const modifierId = await addExpandedMask(page);
  const scope = page.getByTestId(`inspector-query-${modifierId}-scope`);

  // 🔑 THE CLAIM #667 SAID COULD NOT BE MADE. Not a label with a value beside it — an input,
  // enabled and editable, arriving with no UI code of its own because the SCHEMA asked for it.
  await expect(scope).toBeVisible();
  await expect(scope).toBeEditable();
  await expect(scope).toHaveValue('');
  await expect.poll(() => scopeParamOf(page, modifierId)).toBe('');
  // Blank means "nothing authored", which is the whole mesh.
  await expect.poll(() => countsUnder(page, CUBE)).toEqual({ idx: ALL_SIX_FACES, pos: CUBE_POS });

  // 🔑 A range, and THE MESH ACTUALLY CHANGES. Three faces survive, so eighteen index
  // entries — and the positions stay put, because a face subset slices the index and leaves
  // the attribute buffers alone.
  await scope.fill('0-2');
  await scope.press('Enter');
  await expect.poll(() => scopeParamOf(page, modifierId)).toBe('0-2');
  await expect.poll(() => countsUnder(page, CUBE)).toEqual({ idx: 3 * PER_FACE, pos: CUBE_POS });

  // A second, different query — so the row is proven to keep RESPONDING rather than to have
  // worked once. A single edit could be a fluke of first render.
  await scope.fill('0');
  await scope.press('Enter');
  await expect.poll(() => scopeParamOf(page, modifierId)).toBe('0');
  await expect.poll(() => countsUnder(page, CUBE)).toEqual({ idx: 1 * PER_FACE, pos: CUBE_POS });

  // Every construct v1 ships, through the real control: step, negation, removal.
  for (const q of ['0-10:2', '!1', '^0']) {
    await scope.fill(q);
    await scope.press('Enter');
    await expect.poll(() => scopeParamOf(page, modifierId)).toBe(q);
  }

  // And back to "nothing authored", which is the state the row started in — the whole mesh
  // returns, so a scope is genuinely reversible from the panel.
  await scope.fill('');
  await scope.press('Enter');
  await expect.poll(() => scopeParamOf(page, modifierId)).toBe('');
  await expect.poll(() => countsUnder(page, CUBE)).toEqual({ idx: ALL_SIX_FACES, pos: CUBE_POS });

  // Committing on BLUR as well as Enter — a director who types and clicks away has authored
  // just as much as one who pressed a key, and losing that edit silently would be its own bug.
  await scope.fill('1-3');
  await scope.blur();
  await expect.poll(() => scopeParamOf(page, modifierId)).toBe('1-3');
});

test('#873 — a refused query is shown, survivable, and recoverable', async ({ page }) => {
  // Any uncaught page error fails this test. The whole point is that the throw is gone, so a
  // silent console error would be the defect surviving its own fix.
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const modifierId = await addExpandedMask(page);
  const scope = page.getByTestId(`inspector-query-${modifierId}-scope`);
  const refusal = page.getByTestId(`inspector-refusal-${modifierId}-scope`);

  // Start from a good, committed state so the refusal below has something to fail to disturb.
  await scope.fill('0-2');
  await scope.press('Enter');
  await expect.poll(() => scopeParamOf(page, modifierId)).toBe('0-2');
  await expect.poll(() => countsUnder(page, CUBE)).toEqual({ idx: 3 * PER_FACE, pos: CUBE_POS });
  await expect(refusal).toHaveCount(0);

  // 🔴 THE WILDCARD. Houdini's documented syntax, named in this project's deferred list, and
  // one of the first things a director will reach for. v1 does not parse it.
  await scope.fill('arm*');
  await scope.press('Enter');

  // The refusal is ON SCREEN, and it is the schema's own wording.
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText('not a component range');
  await expect(scope).toHaveAttribute('aria-invalid', 'true');

  // The draft is KEPT, so the director can correct the typo instead of retyping the query.
  await expect(scope).toHaveValue('arm*');

  // 🔑 AND NEITHER THE COMMITTED VALUE NOR THE MESH MOVED. A refused query must not
  // half-apply, and must certainly not fall back to a blank — which every generator reads as
  // EVERYTHING, the lost-scope hazard this refusal exists to prevent. Asserting the geometry
  // here is what would catch that fallback: it would show as all six faces returning.
  await expect.poll(() => scopeParamOf(page, modifierId)).toBe('0-2');
  await expect.poll(() => countsUnder(page, CUBE)).toEqual({ idx: 3 * PER_FACE, pos: CUBE_POS });

  // The other two deferred constructs refuse the same way, so the row is about the GRAMMAR
  // rather than about one unlucky string.
  for (const q of ['@v>0', 'garbage!!']) {
    await scope.fill(q);
    await scope.press('Enter');
    await expect(refusal).toBeVisible();
    await expect.poll(() => scopeParamOf(page, modifierId)).toBe('0-2');
  }

  // RECOVERY — the third thing an author-reachable refusal owes.
  await scope.fill('0');
  await scope.press('Enter');
  await expect(refusal).toHaveCount(0);
  // Absent, not empty — the invalid flag is removed rather than set to a falsy string.
  await expect(scope).not.toHaveAttribute('aria-invalid', /.*/);
  await expect.poll(() => scopeParamOf(page, modifierId)).toBe('0');
  // Recovery is not only the message clearing — the MESH follows the corrected query.
  await expect.poll(() => countsUnder(page, CUBE)).toEqual({ idx: 1 * PER_FACE, pos: CUBE_POS });

  // The app never threw. Asserted last so a failure above still reports its own reason first.
  expect(pageErrors).toEqual([]);
});
