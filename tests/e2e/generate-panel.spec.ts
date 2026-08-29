// #764 — the director-facing generate trigger. Both generators were reachable
// only by the agent; this spec is the observation that a PERSON can now reach
// one, through the UI, with no account and no server.
//
// It exists because the unit tier structurally cannot cover it: this project has
// no React Testing Library (W2 acceptance gate #15 forbids new external deps),
// so `GeneratePanel`'s two decisions are unit-tested as functions and everything
// the JSX does — the kind toggle, the disabled affordance, the busy state, the
// clear-on-success — has e2e as its only witness.
//
// 🔑 IT ASSERTS THE SHAPE, NOT THE COUNT. A generated clip is supposed to be
// indistinguishable from an imported one, and `buildGeneratedMotionOps` delivers
// that by calling `buildBvhImportOps` outright — so the pair this press lands
// must be exactly the pair a dropped .bvh lands: a `Skeleton` and an
// `AnimationClip`, the clip wired to the skeleton. "Two more nodes appeared"
// would pass for two nodes of any type at all.
//
// The MOTION road is chosen deliberately over the model road: it is pure DAG
// ops with no OPFS write, and OPFS is this suite's known flake source (#591,
// #643). The model road's ingest is covered at the unit tier in
// src/app/asset/generateModel.test.ts.
//
// REF: src/app/GeneratePanel.tsx; src/core/import/bvhImportChain.ts (the road
//      the generated clip enters by); ref/architecture/ai-track.md phase A1.

import { test, expect } from './_fixtures';

interface DagWindow {
  __basher_dag?: {
    getState: () => { state: { nodes: Record<string, { id: string; type: string }> } };
  };
}

const nodeTypes = () =>
  Object.values((window as unknown as DagWindow).__basher_dag?.getState().state.nodes ?? {}).map(
    (n) => n.type,
  );

test('a director types a prompt and gets the pair a .bvh import would have landed (#764)', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => Boolean((window as unknown as DagWindow).__basher_dag));

  await page.getByTestId('top-toolbar-assets').click();
  const panel = page.getByTestId('generate-panel');
  await expect(panel).toBeVisible();

  // The prompt road sits with the file road, not in a home of its own — the
  // placement is the phase's claim, so it is asserted rather than assumed.
  await expect(page.getByTestId('left-sidebar-import')).toBeVisible();

  // Affordance: nothing to submit yet. The schemas in core/motiongen are the
  // enforcement; this is only the button agreeing with them.
  const submit = page.getByTestId('generate-submit');
  await expect(submit).toBeDisabled();

  const before = await page.evaluate(nodeTypes);

  await page.getByTestId('generate-kind-motion').click();
  await page.getByTestId('generate-prompt').fill('a figure walks forward');
  await expect(submit).toBeEnabled();
  await submit.click();

  // No motion server ships (DEFAULT_MOTIONGEN_URL is a localhost port nothing
  // listens on), so this runs on the offline stub — which is the point: the
  // road is provable with no account and no backend.
  await page.waitForFunction(
    (n) =>
      Object.keys((window as unknown as DagWindow).__basher_dag?.getState().state.nodes ?? {})
        .length > n,
    before.length,
    { timeout: 15_000 },
  );

  const after = await page.evaluate(nodeTypes);
  const added = [...after];
  for (const t of before) added.splice(added.indexOf(t), 1);
  // Exactly the import road's pair, and nothing else.
  expect(added.sort()).toEqual(['AnimationClip', 'Skeleton']);

  // The clip is wired to the skeleton and to time — the connects the import
  // chain makes, not a pair of orphans.
  const wired = await page.evaluate(() => {
    const nodes = Object.values(
      (
        window as unknown as {
          __basher_dag?: {
            getState: () => {
              state: {
                nodes: Record<
                  string,
                  { type: string; inputs: Record<string, { node: string } | undefined> }
                >;
              };
            };
          };
        }
      ).__basher_dag?.getState().state.nodes ?? {},
    );
    const clip = nodes.find((n) => n.type === 'AnimationClip');
    const skeletonIds = nodes.filter((n) => n.type === 'Skeleton').map((n) => n.type);
    return {
      hasSkeletonInput: Boolean(clip?.inputs?.skeleton),
      hasTimeInput: Boolean(clip?.inputs?.time),
      skeletons: skeletonIds.length,
    };
  });
  expect(wired).toEqual({ hasSkeletonInput: true, hasTimeInput: true, skeletons: 1 });

  // Back to idle, prompt consumed, and the failure surface stayed quiet.
  await expect(page.getByTestId('generate-prompt')).toHaveValue('');
  await expect(submit).toBeDisabled();
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// The Character road and the reference-image slot.
//
// Both are JSX decisions, so e2e is their only witness — `canSubmit`,
// `acceptsImage` and `runGeneration` are unit-tested as functions, and nothing
// but a browser can show that the shell actually renders and wires them.
// ---------------------------------------------------------------------------

test('the image slot appears exactly where a road exists for it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('top-toolbar-assets').click();
  await expect(page.getByTestId('generate-panel')).toBeVisible();

  // 🔑 Motion has NO image road in `motiongen`. A slot rendered there would be
  // an affordance for something that cannot happen — the lying label again.
  await page.getByTestId('generate-kind-motion').click();
  await expect(page.getByTestId('generate-image-slot')).toHaveCount(0);

  for (const kind of ['model', 'character']) {
    await page.getByTestId(`generate-kind-${kind}`).click();
    await expect(page.getByTestId('generate-image-slot')).toBeVisible();
  }
});

test('an attached image satisfies submit on its own, and takes over from the prompt', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('top-toolbar-assets').click();
  await page.getByTestId('generate-kind-model').click();

  // Empty prompt, nothing attached: refused.
  await expect(page.getByTestId('generate-submit')).toBeDisabled();

  // A 1x1 PNG is enough — this asserts the WIRING, not the decoder.
  await page.getByTestId('generate-image-input').setInputFiles({
    name: 'reference.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  });

  await expect(page.getByTestId('generate-image-name')).toHaveText('reference.png');
  // 🔑 `ImageModelRequest` carries no prompt — the image REPLACES the text. So
  // the button unlocks with an empty prompt, and the prompt goes read-only
  // rather than sitting there implying it will be sent.
  await expect(page.getByTestId('generate-submit')).toBeEnabled();
  await expect(page.getByTestId('generate-prompt')).toBeDisabled();

  // Clearing it puts the prompt back in charge.
  await page.getByTestId('generate-image-clear').click();
  await expect(page.getByTestId('generate-image-name')).toHaveCount(0);
  await expect(page.getByTestId('generate-prompt')).toBeEnabled();
  await expect(page.getByTestId('generate-submit')).toBeDisabled();
});

test('the Character road lands a rigged mesh on the ordinary glTF import road', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => Boolean((window as unknown as DagWindow).__basher_dag));
  await page.getByTestId('top-toolbar-assets').click();

  await page.getByTestId('generate-kind-character').click();
  await page.getByTestId('generate-prompt').fill('a stocky dwarf blacksmith');

  const before = await page.evaluate(nodeTypes);
  await page.getByTestId('generate-submit').click();
  await expect(page.getByTestId('generate-submit')).toContainText('Generate', { timeout: 60_000 });
  await page.waitForFunction(
    (n) =>
      Object.keys((window as unknown as DagWindow).__basher_dag?.getState().state.nodes ?? {})
        .length > n,
    before.length,
    { timeout: 60_000 },
  );
  const after = await page.evaluate(nodeTypes);

  // 🔑 THE SHAPE, NOT THE COUNT — the same discipline the motion road uses. A
  // rigged character arrives as the trio a dropped .glb produces, and its
  // SKELETON shows up as GltfChild nodes. "More nodes appeared" would pass for
  // an unrigged mesh, which is the one failure this road exists to avoid.
  expect(after).toContain('GltfAsset');
  expect(after).toContain('Group');
  expect(after.filter((t) => t === 'GltfChild').length).toBeGreaterThan(
    before.filter((t) => t === 'GltfChild').length + 5,
  );

  await expect(page.getByTestId('generate-prompt')).toHaveValue('');
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
});
