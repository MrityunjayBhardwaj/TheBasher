// #1124 — a generated motion's clip owns its name, so a re-cook lands motion and keeps the name
// a director gave the clip.
//
// Driven through the director's own road, on the offline generator the app falls back to (no
// server, no paid call — the reason `generate-panel.spec.ts` can run in CI): generate from the
// Assets panel, rename the clip in the inspector, change the prompt on the generator's card,
// press the card's Re-cook. Measured before #1124 with the same gestures: the re-cook put the
// clip back to the generator's name, and the stand-in Object's row (which follows the clip since
// #1122) went back with it.

import { test, expect, type Page } from './_fixtures';

interface DagNode {
  type: string;
  inputs: Record<string, unknown>;
  params: Record<string, unknown>;
}
interface Win {
  __basher_dag: { getState: () => { state: { nodes: Record<string, DagNode> } } };
  __basher_selection: { getState: () => { select: (id: string) => void } };
}

const nodesOf = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__basher_dag.getState().state.nodes);
const select = (page: Page, id: string) =>
  page.evaluate((i) => (window as unknown as Win).__basher_selection.getState().select(i), id);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* OPFS entry absent on first run */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Win;
    return Boolean(w.__basher_dag && w.__basher_selection);
  });
});

test('a re-cook keeps the name the director gave the clip, and the Object keeps following it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' || /WebGL|GPU/i.test(m.text())) return;
    // The capability probe asks the local motion server first (`DEFAULT_MOTIONGEN_URL`), and no
    // server ships, so that one request is refused before the offline generator answers. Only
    // that URL is excused; any other error still fails the row.
    if (m.location().url.startsWith('http://127.0.0.1:8600')) return;
    errors.push(`${m.text()} @ ${m.location().url}`);
  });

  await page.getByTestId('top-toolbar-assets').click();
  await page.getByTestId('generate-kind-motion').click();
  await page.getByTestId('generate-prompt').fill('a figure walks forward');
  await page.getByTestId('generate-submit').click();
  // Cooked, not merely minted: the clip carries the receipt of a landed result.
  await page.waitForFunction(
    () =>
      Object.values((window as unknown as Win).__basher_dag.getState().state.nodes).some(
        (n) =>
          n.type === 'AnimationClip' &&
          typeof n.params.sourceHash === 'string' &&
          n.params.sourceHash !== '',
      ),
    undefined,
    { timeout: 30_000 },
  );

  const nodes = await nodesOf(page);
  const ref = (v: unknown) => (v as { node?: string } | undefined)?.node;
  const producer = Object.entries(nodes).find(([, n]) => n.type === 'MotionGenerate')?.[0];
  const clip = Object.entries(nodes).find(([, n]) => n.type === 'AnimationClip')?.[0];
  const object = Object.entries(nodes).find(
    ([, n]) => n.type === 'Object' && nodes[ref(n.inputs.data) ?? '']?.type === 'Skeleton',
  )?.[0];
  expect({ producer, clip, object }, 'the generate road landed an incomplete chain').toEqual({
    producer: expect.any(String),
    clip: expect.any(String),
    object: expect.any(String),
  });
  const bakedHash = nodes[clip!].params.sourceHash;

  // The generator's card offers no name of its own — the clip's is the one to edit.
  await select(page, producer!);
  await expect(page.getByTestId(`inspector-text-${producer}-prompt`)).toBeVisible();
  await expect(page.getByTestId(`inspector-text-${producer}-name`)).toHaveCount(0);

  // The director renames the clip.
  await select(page, clip!);
  const clipName = page.getByTestId(`inspector-text-${clip}-name`);
  await clipName.fill('my take');
  await clipName.press('Enter');
  await page.getByTestId('left-sidebar-tab-outliner').click();
  const row = page.getByTestId(`scene-tree-row-${object}`);
  await expect(row).toHaveText('my take');

  // … changes what to generate, and re-cooks from the generator's card.
  await select(page, producer!);
  const prompt = page.getByTestId(`inspector-text-${producer}-prompt`);
  await prompt.fill('a figure runs');
  await prompt.press('Enter');
  const run = page.getByTestId('motion-cook-run');
  await expect(run).toHaveText('Re-cook (inputs changed)');
  await run.click();
  // New motion landed: the receipt moved.
  await page.waitForFunction(
    ([id, before]) =>
      (window as unknown as Win).__basher_dag.getState().state.nodes[id].params.sourceHash !==
      before,
    [clip!, bakedHash] as const,
    { timeout: 30_000 },
  );

  const after = await nodesOf(page);
  expect(after[clip!].params.name).toBe('my take');
  await expect(row).toHaveText('my take');
  expect(errors).toEqual([]);
});
