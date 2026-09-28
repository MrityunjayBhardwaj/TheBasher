// #1226 — a re-cook says what it moved under a layer, on the surface a director reads.
//
// Driven on the offline generator the app falls back to (no server, no paid call): generate from
// the Assets panel, put an additive layer keyed on one bone over the generated rig's Object, change
// the prompt, press the card's Re-cook. The new prompt is new motion, so the layer's result moves,
// and the warning toast must name the layer. The layer is written as ops through the live store:
// what is under test is the cook's report, not the gesture that makes a layer.

import { test, expect, type Page } from './_fixtures';

interface DagNode {
  type: string;
  inputs: Record<string, unknown>;
  params: Record<string, unknown>;
}
interface Win {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, DagNode> };
      dispatchAtomic: (ops: unknown[], source: string, label: string) => void;
    };
  };
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

test('a re-cook names the layer whose result it moved', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' || /WebGL|GPU/i.test(m.text())) return;
    // The capability probe asks the local motion server first and none ships; only that URL is
    // excused (the same rule as the re-cook spec).
    if (m.location().url.startsWith('http://127.0.0.1:8600')) return;
    errors.push(`${m.text()} @ ${m.location().url}`);
  });

  await page.getByTestId('top-toolbar-assets').click();
  await page.getByTestId('generate-kind-motion').click();
  await page.getByTestId('generate-prompt').fill('a figure walks forward');
  await page.getByTestId('generate-submit').click();
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
  expect({ producer, clip, object }).toEqual({
    producer: expect.any(String),
    clip: expect.any(String),
    object: expect.any(String),
  });
  // The Object stands on the clip's pose, with no layer yet.
  expect(ref(nodes[object!].inputs.pose)).toBe(clip);
  const skeleton = ref(nodes[clip!].inputs.skeleton)!;
  const bones = nodes[skeleton].params.bones as { name: string }[];
  // A bone below the root: the one a walk swings.
  const bone = bones[1].name;

  await page.evaluate(
    ([clipId, objectId, boneName]) => {
      (window as unknown as Win).__basher_dag.getState().dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: 'layer_e2e',
            nodeType: 'PoseLayer',
            params: {
              name: 'lean',
              mode: 'additive',
              members: [{ bone: boneName, rotationMode: 'XYZ' }],
              channels: [
                {
                  bone: boneName,
                  component: 'rotation',
                  keyframes: [{ time: 0.5, value: [10, 0, 0], easing: 'linear' }],
                },
              ],
            },
          },
          {
            type: 'connect',
            from: { node: clipId, socket: 'pose' },
            to: { node: 'layer_e2e', socket: 'pose' },
          },
          {
            type: 'connect',
            from: { node: 'layer_e2e', socket: 'out' },
            to: { node: objectId, socket: 'pose' },
            replace: true,
          },
        ],
        'user',
        'layer',
      );
    },
    [clip!, object!, bone] as const,
  );

  const bakedHash = nodes[clip!].params.sourceHash;
  await select(page, producer!);
  const prompt = page.getByTestId(`inspector-text-${producer}-prompt`);
  await prompt.fill('a figure runs');
  await prompt.press('Enter');
  const run = page.getByTestId('motion-cook-run');
  await expect(run).toHaveText('Re-cook (inputs changed)');
  await run.click();
  await page.waitForFunction(
    ([id, before]) =>
      (window as unknown as Win).__basher_dag.getState().state.nodes[id].params.sourceHash !==
      before,
    [clip!, bakedHash] as const,
    { timeout: 30_000 },
  );

  const warn = page.getByTestId('toast-warn');
  await expect(warn).toHaveCount(1);
  await expect(warn).toContainText(`"lean" ${bone} moved`);
  // Sticky: still there after a warning's default lifetime would have ended.
  await page.waitForTimeout(6_500);
  await expect(warn).toHaveCount(1);
  expect(errors).toEqual([]);
});
