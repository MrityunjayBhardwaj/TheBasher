// #209 increment 3 — the Modifier-stack inspector UI (epic #201, §5; the
// OperatorStack's authoring surface). Observes on the LIVE app that clicking
// "+ Array" in the selected mesh's Modifiers section actually adds a modifier to
// the DAG and the viewport re-renders the MERGED array; that muting it (the row's
// ● toggle) bypasses the operator; and that a second add + delete drives the stack
// — every action through operatorStack's atomic Op builders.
//
// #377 retargets the BASE back to a CUBE — which is now a split `Object` → `BoxData`.
// Slice 2 had moved this spec onto a fused SphereMesh because neither half of the
// split declared the 'modifier' section and the attachment was undecided. It is
// decided: the stack attaches to the OBJECT and evaluates over its data, so `Object`
// declares 'modifier' and this drives the shape a user actually has. The arrayed
// vertex count is asserted as a RATIO against the runtime-derived source count,
// never a box constant — primitive-agnostic, so the retarget changes no numbers.
//
// REF: src/app/ModifierStackControls.tsx; src/app/operatorStack.ts;
//      src/app/NPanel.tsx (the 'modifier' section); vyapti V58.

import { expect, test } from './_fixtures';
import { openInspectorSection } from './_inspectorSections';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface UiWindow {
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_three: { getState: () => { scene: ThreeSceneLike | null } };
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
}
interface ThreeSceneLike {
  traverse: (cb: (o: ThreeObjLike) => void) => void;
}
interface ThreeObjLike {
  type: string;
  geometry?: { attributes?: { position?: { count: number } } };
}

/** The cube's own vertex count, derived live in beforeEach — never a box constant. */
let cubeVerts = 0;

const CUBE = 'p209ui_cube';
const CUBE_DATA = 'p209ui_cube_data';

/** The position-attribute vertex count of the meshes under the scene child named
 *  `nodeId` — `SceneFromDAG` names each child's wrapper `<group name={pickId}>`,
 *  so this measures ONE object's geometry and nothing else.
 *
 *  It replaces a scene-wide MAX, which worked only because a default sphere (425
 *  verts) dwarfed everything else. A cube is 24 verts and the starter scene carries
 *  thousands, so neither a max NOR a sum-minus-baseline can see it: the scene's
 *  meshes mount asynchronously, so any whole-scene baseline is a race that silently
 *  poisons every ratio derived from it. Measuring the subtree is exact and needs no
 *  baseline at all. Still primitive-agnostic — the assertions are ratios against the
 *  source's own runtime count, never a box constant. */
function vertsUnder(page: import('@playwright/test').Page, nodeId: string): Promise<number> {
  return page.evaluate((id) => {
    const w = window as unknown as UiWindow;
    const scene = w.__basher_three.getState().scene;
    let root: ThreeObjLike | null = null;
    scene?.traverse((o) => {
      if ((o as unknown as { name?: string }).name === id && !root) root = o;
    });
    if (!root) return -1;
    let total = 0;
    (root as unknown as ThreeSceneLike).traverse((o) => {
      const g = (o as ThreeObjLike).geometry?.attributes?.position;
      if ((o as ThreeObjLike).type === 'Mesh' && g) total += g.count;
    });
    return total;
  }, nodeId);
}

/** The node id of the single modifier row in the stack (`modifier-row-<id>`). #415 — it
 *  is NOT the scene child any more: the stack splices onto the object's data lane, so the
 *  Object stays the scene child and the modifier is a property of it. Measure geometry
 *  under `CUBE`; use this id only to address the operator itself. */
async function soleModifierId(page: import('@playwright/test').Page): Promise<string> {
  const testId = await page
    .locator('[data-testid^="modifier-row-"]')
    .first()
    .getAttribute('data-testid');
  return testId!.replace('modifier-row-', '');
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
  // A fresh split cube — an `Object` (the pose + the modifier stack) over a `BoxData`
  // (the geometry the stack reshapes), wired into the scene. This is exactly what
  // Add ▸ Mesh ▸ Cube builds, so the spec drives the real user-facing shape.
  await page.evaluate(
    ({ cube, data }) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          { type: 'addNode', nodeId: data, nodeType: 'BoxData', params: { size: [1, 1, 1] } },
          {
            type: 'addNode',
            nodeId: cube,
            nodeType: 'Object',
            params: { position: [4, 0, 0] },
          },
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
        'modifier-base split cube',
      );
    },
    { cube: CUBE, data: CUBE_DATA },
  );
  // Select the Object and reveal its Modifiers section (last in its section list, so
  // default-collapsed — open idempotently).
  await page.evaluate(
    (cube) => (window as unknown as UiWindow).__basher_selection.getState().select(cube),
    CUBE,
  );
  await openInspectorSection(page, 'modifier');
  // The cube's own vertex count, once its mesh has actually mounted.
  await expect.poll(() => vertsUnder(page, CUBE)).toBeGreaterThan(0);
  cubeVerts = await vertsUnder(page, CUBE);
});

test('#209 — "+ Array" adds a modifier and the viewport renders the merged array', async ({
  page,
}) => {
  const stack = page.getByTestId('modifier-stack');
  await expect(stack).toBeVisible();
  await expect(stack.getByText('No modifiers.')).toBeVisible();

  expect(cubeVerts).toBeGreaterThan(0);

  await page.getByTestId('modifier-add-ArrayModifier').click();

  // A modifier row appears in the stack...
  await expect(stack.locator('[data-testid^="modifier-row-"]')).toHaveCount(1);
  const modifierId = await soleModifierId(page);

  // ...and the live viewport renders the merged array UNDER THE CUBE — an integer
  // multiple of the source, strictly more than the bare cube.
  //
  // ⚠️ #415 MOVED THE SUBJECT OF EVERY MEASUREMENT BELOW, from `modifierId` to `CUBE`,
  // and this is the assertion that proves the whole slice from a user's seat. The
  // modifier used to BE the scene child, so the merged geometry hung under a group named
  // after the operator; the cube the user selected had been displaced behind it. Now the
  // geometry hangs under the CUBE, which is the point: a modifier is a property of the
  // object, not a thing standing in front of it. This failed loudly (-1, no such scene
  // object) rather than silently when the flip landed — the good arm of [[H218]].
  await expect.poll(() => vertsUnder(page, CUBE), { timeout: 10_000 }).toBeGreaterThan(cubeVerts);
  const arrayed = await vertsUnder(page, CUBE);
  expect(arrayed % cubeVerts).toBe(0); // genuinely COUNT copies of the source

  // POSSESSION, not type names: the operator is not a scene object at all any more.
  // Without this, `vertsUnder(CUBE)` growing would be consistent with the modifier ALSO
  // still rendering separately — which is exactly the double-render the flip could have
  // produced and did produce in the inspector before it was fixed.
  expect(await vertsUnder(page, modifierId)).toBe(-1);

  // Mute the modifier (the row's ● toggle) → the operator is bypassed, the merged
  // array collapses back to the bare source — still measured under the cube.
  await stack.locator('[data-testid^="modifier-mute-"]').first().click();
  await expect.poll(() => vertsUnder(page, CUBE), { timeout: 10_000 }).toBe(cubeVerts);

  // Un-mute → the array comes back.
  await stack.locator('[data-testid^="modifier-mute-"]').first().click();
  await expect.poll(() => vertsUnder(page, CUBE), { timeout: 10_000 }).toBe(arrayed);

  // …and the cube's OWN data rows survived the modifier. This is the regression the
  // stack-count failure was a symptom of: the Object's `data` input now names the top of
  // the stack, so a panel reading it directly showed the operator's sections in place of
  // the cube's — the size and colour rows silently disappeared behind a second, empty
  // modifier stack. The linked-data block resolves through the chain instead.
  await expect(page.getByTestId('inspector-linked-data')).toHaveCount(1);
  await expect(page.getByTestId('inspector-linked-data')).toContainText('BoxData');
});

test('#209 — a second add stacks, and delete removes a modifier', async ({ page }) => {
  const stack = page.getByTestId('modifier-stack');
  await page.getByTestId('modifier-add-ArrayModifier').click();
  await expect(stack.locator('[data-testid^="modifier-row-"]')).toHaveCount(1);
  await page.getByTestId('modifier-add-ArrayModifier').click();
  await expect(stack.locator('[data-testid^="modifier-row-"]')).toHaveCount(2);

  // Delete the first row → back to one modifier (chain splices closed).
  await stack.locator('[data-testid^="modifier-remove-"]').first().click();
  await expect(stack.locator('[data-testid^="modifier-row-"]')).toHaveCount(1);
});
