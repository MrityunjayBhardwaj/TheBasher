// #1720 — a generated model keeps a Model generate node, and Regenerate makes a new variant from
// that SAME node.
//
// Done when: "Regenerate on a kept model produces a new variant from the same node, and the
// asset's details show where it came from." This walks the director's whole road in the Library:
// the Generate form with its cost shown before running, the placeholder while it runs, four
// variants, Keep, the kept asset's details (prompt, seed, provider, node), and Regenerate from
// those details.
//
// 🔴 NO PAID CALL CAN HAPPEN HERE, AND THE SPEC CHECKS IT RATHER THAN ASSUMING IT. No Tripo key
// is set, so the offline stub answers; every route to Tripo (the dev proxy and the host itself)
// is aborted and counted, the count must be zero, and the node must record the stub as its
// provider. A run that somehow reached a real service would red on all three.
//
// REF: src/app/asset/generateModel.ts; src/nodes/ModelGenerate.ts;
//      src/app/library/ModelVariants.tsx; src/viewport/GenerationPlaceholder.tsx.

import { expect, test } from './_fixtures';

interface Node {
  id: string;
  type: string;
  params: Record<string, unknown>;
}
interface Variant {
  seed: number;
  path: string;
  taskId: string;
  kept: boolean;
}
interface BasherWindow {
  __basher_three?: {
    getState: () => {
      scene: {
        getObjectByName: (
          n: string,
        ) => { position: { x: number; y: number; z: number } } | undefined;
      } | null;
    };
  };
  __basher_dag: { getState: () => { state: { nodes: Record<string, Node> } } };
  __basher_modelgen?: {
    useSlowStub: (ms: number) => void;
  };
}

const PROMPT = 'a worn leather armchair';

/** The placeholder box the viewport draws, read off the live three.js scene: its centre, or null
 *  when nothing is drawn. */
function placeholderCentre(): [number, number, number] | null {
  const box = (window as unknown as BasherWindow).__basher_three
    ?.getState()
    .scene?.getObjectByName('generation-placeholder');
  return box ? [box.position.x, box.position.y, box.position.z] : null;
}

function modelGenerateNodes(): Node[] {
  return Object.values(
    (window as unknown as BasherWindow).__basher_dag.getState().state.nodes,
  ).filter((n) => n.type === 'ModelGenerate');
}

test('generate → variants → keep → details → regenerate from the SAME node (#1720)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const tripoCalls: string[] = [];
  await page.route('**/__tripo/**', (route) => {
    tripoCalls.push(route.request().url());
    return route.abort('failed');
  });
  await page.route('**/*tripo3d.ai/**', (route) => {
    tripoCalls.push(route.request().url());
    return route.abort('failed');
  });

  await page.goto('/');
  // A clean asset store, so Your imports holds only what this test keeps.
  await page.evaluate(async () => {
    localStorage.removeItem('basher.settings.v1');
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry('basher', { recursive: true });
    } catch {
      /* not present */
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => Boolean((window as unknown as BasherWindow).__basher_modelgen));
  // Hold each stub generation open long enough to see the placeholder.
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_modelgen!.useSlowStub(400),
  );

  await page.getByTestId('top-toolbar-assets').click();
  const library = page.getByTestId('library-pane');
  await library.getByTestId('library-generate-tile').click();
  await library.getByTestId('generate-kind-model').click();
  await library.getByTestId('generate-prompt').fill(PROMPT);

  // The cost, BEFORE running: four variants by default, labelled an estimate, and — with no key —
  // free on the stub.
  await expect(library.getByTestId('generate-variant-count')).toHaveValue('4');
  const cost = library.getByTestId('generate-cost');
  await expect(cost).toContainText('estimate');
  await expect(cost).toContainText('4 ×');
  await expect(cost).toContainText('Free');

  await library.getByTestId('generate-submit').click();

  // While it runs, a placeholder stands where the model will land — drawn in the viewport, at
  // the origin the import puts a generated model.
  await expect.poll(() => page.evaluate(placeholderCentre)).toEqual([0, 0.5, 0]);
  await expect(library.getByTestId('model-variant-pending').first()).toBeVisible();

  // Four variants arrive, on ONE node, from the stub.
  await expect(library.locator('[data-testid^="model-variant-keep-"]')).toHaveCount(4, {
    timeout: 30_000,
  });
  // And gone once the run is over.
  await expect.poll(() => page.evaluate(placeholderCentre)).toBeNull();
  const minted = await page.evaluate(modelGenerateNodes);
  expect(minted).toHaveLength(1);
  const node = minted[0];
  expect(node.params.prompt).toBe(PROMPT);
  expect(node.params.provider).toBe('stub-modelgen');
  const variants = node.params.variants as Variant[];
  expect(variants).toHaveLength(4);
  expect(new Set(variants.map((v) => v.seed)).size).toBe(4);
  expect(variants.every((v) => !v.kept)).toBe(true);
  // Nothing is in the scene or the library until one is kept.
  await expect(library.getByTestId('library-popover-my-imports')).toHaveCount(0);

  // Keep the first: it is placed (the import road's nodes) and saved to Your imports.
  const before = await page.evaluate(
    () =>
      Object.keys((window as unknown as BasherWindow).__basher_dag.getState().state.nodes).length,
  );
  const first = variants[0];
  await library.getByTestId(`model-variant-keep-${first.seed}`).click();
  await expect(library.getByTestId(`model-variant-${first.seed}`)).toHaveAttribute(
    'data-kept',
    'true',
  );
  const after = await page.evaluate(() =>
    Object.values((window as unknown as BasherWindow).__basher_dag.getState().state.nodes).map(
      (n) => n.type,
    ),
  );
  expect(after.length).toBeGreaterThan(before);
  expect(after).toContain('PolyMeshData');

  // The kept asset's details say where it came from.
  const mine = library.getByTestId('library-popover-my-imports');
  await expect(mine.locator('[data-library-tile]')).toHaveCount(1);
  await mine.locator('[data-library-tile]').first().click();
  const generated = library.getByTestId('library-details-generated');
  await expect(generated).toBeVisible();
  await expect(library.getByTestId('library-details-generated-prompt')).toHaveText(PROMPT);
  await expect(library.getByTestId('library-details-generated-seed')).toHaveText(
    String(first.seed),
  );
  await expect(library.getByTestId('library-details-generated-provider')).toHaveText(
    'stub-modelgen',
  );
  await expect(library.getByTestId('library-details-generated-node')).toHaveText(node.id);

  // Regenerate, from the details: a NEW variant on the SAME node.
  await generated.getByTestId('model-regenerate').click();
  await expect(generated.locator('[data-testid^="model-variant-keep-"]')).toHaveCount(4, {
    timeout: 30_000,
  });
  const regenerated = await page.evaluate(modelGenerateNodes);
  expect(regenerated.map((n) => n.id)).toEqual([node.id]);
  const now = regenerated[0].params.variants as Variant[];
  expect(now).toHaveLength(5);
  const fresh = now[4];
  expect(variants.map((v) => v.seed)).not.toContain(fresh.seed);
  await expect(generated.getByTestId(`model-variant-${fresh.seed}`)).toBeVisible();

  // And nothing reached a paid service, and nothing failed.
  expect(tripoCalls).toEqual([]);
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
});
