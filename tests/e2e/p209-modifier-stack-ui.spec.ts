// #209 increment 3 — the Modifier-stack inspector UI (epic #201, §5; the
// OperatorStack's authoring surface). Observes on the LIVE app that clicking
// "+ Array" in the selected mesh's Modifiers section actually adds a modifier to
// the DAG and the viewport re-renders the MERGED array; that muting it (the row's
// ● toggle) bypasses the operator; and that a second add + delete drives the stack
// — every action through operatorStack's atomic Op builders.
//
// #365 Slice 2: the modifier BASE is a fused SphereMesh, not the retired fused
// BoxMesh. The seed cube is now a split `Object` → `BoxData`, and neither half
// declares the 'modifier' inspector section (a split Object as a modifier target
// is the undecided #377 path), so it has no Modifiers UI to drive. A fused
// SphereMesh declares ['mesh','transform','constraint','driver','material','modifier'],
// so its stack renders. The arrayed vertex count is asserted as a RATIO against the
// runtime-derived source count, never a box constant — primitive-agnostic.
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

const SPHERE = 'p209ui_sphere';

/** The largest position-attribute vertex count among live scene meshes. A default
 *  sphere (425 verts) dwarfs the seed cube (24), so before any modifier this is the
 *  sphere's own count; after "+ Array" it is the merged array (COUNT × source). */
function maxMeshVerts(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as UiWindow;
    const scene = w.__basher_three.getState().scene;
    let max = 0;
    scene?.traverse((o) => {
      const g = (o as ThreeObjLike).geometry?.attributes?.position;
      if ((o as ThreeObjLike).type === 'Mesh' && g && g.count > max) max = g.count;
    });
    return max;
  });
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
  // A fresh fused SphereMesh, wired into the scene — the modifier BASE the UI drives.
  await page.evaluate((sphere) => {
    const w = window as unknown as UiWindow;
    const dag = w.__basher_dag.getState();
    const sceneId = dag.state.outputs.scene!.node;
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: sphere,
          nodeType: 'SphereMesh',
          params: { radius: 0.5, position: [4, 0, 0] },
        },
        {
          type: 'connect',
          from: { node: sphere, socket: 'out' },
          to: { node: sceneId, socket: 'children' },
        },
      ],
      'e2e',
      'modifier-base sphere',
    );
  }, SPHERE);
  // Select the sphere and reveal its Modifiers section (last in its section list, so
  // default-collapsed — open idempotently).
  await page.evaluate(
    (sphere) => (window as unknown as UiWindow).__basher_selection.getState().select(sphere),
    SPHERE,
  );
  await openInspectorSection(page, 'modifier');
});

test('#209 — "+ Array" adds a modifier and the viewport renders the merged array', async ({
  page,
}) => {
  const stack = page.getByTestId('modifier-stack');
  await expect(stack).toBeVisible();
  await expect(stack.getByText('No modifiers.')).toBeVisible();

  // The bare source count (sphere) before any modifier — derived, never hardcoded.
  const base = await maxMeshVerts(page);
  expect(base).toBeGreaterThan(0);

  await page.getByTestId('modifier-add-ArrayModifier').click();

  // A modifier row appears in the stack...
  await expect(stack.locator('[data-testid^="modifier-row-"]')).toHaveCount(1);
  // ...and the live viewport now renders a merged array: an integer multiple of the
  // source (COUNT × base), so strictly larger than the bare source.
  await expect.poll(() => maxMeshVerts(page), { timeout: 10_000 }).toBeGreaterThan(base);
  const arrayed = await maxMeshVerts(page);
  expect(arrayed % base).toBe(0); // genuinely COUNT copies of the source

  // Mute the modifier (the row's ● toggle) → the operator is bypassed, the merged
  // array collapses back to the bare source.
  await stack.locator('[data-testid^="modifier-mute-"]').first().click();
  await expect.poll(() => maxMeshVerts(page), { timeout: 10_000 }).toBe(base);

  // Un-mute → the array comes back.
  await stack.locator('[data-testid^="modifier-mute-"]').first().click();
  await expect.poll(() => maxMeshVerts(page), { timeout: 10_000 }).toBe(arrayed);
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
