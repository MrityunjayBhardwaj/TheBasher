// #1715 — one ComfyUI workflow node whose sockets come from its workflow file, in the running app.
//
// Add the node in the Nodes view, pick a workflow file through the real file picker, and its
// Basher markers are drawn as the node's sockets with their types. Pick another file and the
// sockets change; a wire on a socket the new file lacks is kept and shown broken, never dropped.
// A number input is keyed with I over its row. And an old project holding the stylized-realism
// preset opens as the generic node with the preset's file, its pass wires on the matching sockets.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';
import { openDrawerTab } from './_drawer';

interface W {
  __basher_dag: {
    getState(): {
      state: {
        nodes: Record<
          string,
          { type: string; params: Record<string, unknown>; inputs: Record<string, unknown> }
        >;
        outputs: { scene?: { node: string } };
      };
      dispatch: (op: unknown, src: string, d: string) => void;
    };
  };
  __basher_export_scene_bundle?: () => Promise<{ bundle: unknown }>;
  __basher_import_scene_bundle?: (bundle: unknown) => Promise<string>;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = path.join(ROOT, 'src/core/comfy/fixtures');
const SHOT = (name: string) =>
  process.env.P1715_SHOT_DIR ? path.join(process.env.P1715_SHOT_DIR, `p1715-${name}.png`) : null;

async function boot(page: Page) {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as Partial<W>).__basher_dag?.getState().state.outputs.scene),
  );
}

/** For a reader's eyes only (P1715_SHOT_DIR set): the node up close, and its inspector section. */
async function observe(page: Page, nodeId: string, name: string) {
  const shot = SHOT(name);
  if (!shot) return;
  await page.setViewportSize({ width: 1600, height: 1400 });
  await page.getByTestId('graph-view-fit').click();
  const node = page.locator(`[data-graph-node="${nodeId}"]`);
  // Pan the node to the middle of the canvas (drag the empty corner), then zoom in on it.
  const canvas = (await page.getByTestId('graph-view-canvas').boundingBox())!;
  const box = (await node.boundingBox())!;
  const dx = canvas.x + canvas.width / 2 - (box.x + box.width / 2);
  const dy = canvas.y + canvas.height / 2 - (box.y + box.height / 2);
  await page.mouse.move(canvas.x + 4, canvas.y + 4);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 4 + dx, canvas.y + 4 + dy, { steps: 8 });
  await page.mouse.up();
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.wheel(0, -450);
  await page.waitForTimeout(200);
  await node.screenshot({ path: shot });
  const section = page.getByTestId('comfy-workflow-section');
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: shot.replace('.png', '-inspector.png') });
  await page.screenshot({ path: shot.replace('.png', '-page.png') });
}

async function pickWorkflow(page: Page, file: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('comfy-workflow-pick').click();
  await (await chooser).setFiles(path.join(FIXTURES, file));
}

/** Each drawn socket row of node `id` as `name:type`, read off the Nodes view. */
async function drawnInputs(page: Page, id: string) {
  return page
    .locator(`[data-graph-node="${id}"] [data-graph-row]`)
    .evaluateAll((els) =>
      els.map(
        (e) =>
          `${e.getAttribute('data-graph-row')}:${e.getAttribute('data-graph-socket-type') ?? (e.getAttribute('data-graph-broken') ? 'broken' : '')}`,
      ),
    );
}
async function drawnOutputs(page: Page, id: string) {
  return page
    .locator(`[data-graph-node="${id}"] [data-graph-output]`)
    .evaluateAll((els) =>
      els.map(
        (e) => `${e.getAttribute('data-graph-output')}:${e.getAttribute('data-graph-socket-type')}`,
      ),
    );
}

test('a workflow file’s markers are the node’s sockets; another file, other sockets; a number keys with I', async ({
  page,
}) => {
  await boot(page);
  await openDrawerTab(page, 'nodes');
  await page.getByTestId('graph-view-add-comfy-workflow').click();
  const id = 'comfy_workflow_1';
  const node = page.locator(`[data-graph-node="${id}"]`);
  await expect(node).toHaveCount(1);
  await expect(page.getByTestId('comfy-workflow-file')).toHaveText('none picked');

  // The still-edit file: an image, a prompt and a strength in; one still out.
  await pickWorkflow(page, 'workflow-still-edit.json');
  await expect(page.getByTestId('comfy-workflow-file')).toHaveText('workflow-still-edit');
  await expect
    .poll(() => drawnInputs(page, id))
    .toEqual(['picture:still image', 'prompt:text', 'strength:number', 'time:time']);
  expect(await drawnOutputs(page, id)).toEqual(['result:still image']);
  await expect(page.getByTestId('comfy-socket-in-strength')).toHaveAttribute(
    'data-socket-type',
    'number',
  );
  await observe(page, id, 'still-edit-file');

  // Wire a number into `strength`, then swap to the video file, which has no `strength`.
  await page.evaluate((nodeId) => {
    const d = (window as unknown as W).__basher_dag.getState();
    d.dispatch(
      { type: 'addNode', nodeId: 'p1715_value', nodeType: 'Value', params: { value: 0.4 } },
      'user',
      'e2e',
    );
    d.dispatch(
      {
        type: 'connect',
        from: { node: 'p1715_value', socket: 'out' },
        to: { node: nodeId, socket: 'strength' },
      },
      'user',
      'e2e',
    );
  }, id);
  await pickWorkflow(page, 'workflow-video.json');
  await expect(page.getByTestId('comfy-workflow-file')).toHaveText('workflow-video');
  await expect
    .poll(() => drawnInputs(page, id))
    .toEqual(['footage:frames', 'seed:number', 'style:text', 'time:time', 'strength:broken']);
  expect(await drawnOutputs(page, id)).toEqual(['clip:frames', 'poster:still image']);
  // The fed input is listed in the inspector, never drawn as a socket.
  await expect(page.getByTestId('comfy-socket-fed-previous')).toContainText(
    'previous frame of clip',
  );
  await expect(page.getByTestId('comfy-socket-broken-strength')).toBeVisible();
  // The wire is still in the graph: kept, not dropped.
  expect(
    await page.evaluate(
      (nodeId) =>
        (window as unknown as W).__basher_dag.getState().state.nodes[nodeId].inputs.strength,
      id,
    ),
  ).toEqual({ node: 'p1715_value', socket: 'out' });

  // I over the `seed` row keys it on its controller path.
  await page.getByTestId('comfy-workflow-value-seed').hover();
  await page.keyboard.press('i');
  await expect
    .poll(() =>
      page.evaluate((nodeId) => {
        const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
        return Object.values(nodes)
          .filter((n) => n.type.startsWith('KeyframeChannel') && n.params.target === nodeId)
          .map((n) => `${n.type}:${String(n.params.paramPath)}`);
      }, id),
    )
    .toEqual(['KeyframeChannelNumber:controller:11']);

  await observe(page, id, 'video-file');
});

test('an old project with the stylized-realism preset opens as the node holding its file', async ({
  page,
}) => {
  await boot(page);
  await page.waitForFunction(
    () => !!(window as unknown as Partial<W>).__basher_import_scene_bundle,
  );
  // Today's scene, saved as v30 with the preset node an AI pass used to add.
  await page.evaluate(async () => {
    const w = window as unknown as W;
    const { bundle } = await w.__basher_export_scene_bundle!();
    const b = JSON.parse(JSON.stringify(bundle)) as {
      formatVersion: number;
      state: { nodes: Record<string, unknown> };
    };
    const nodes = w.__basher_dag.getState().state.nodes;
    const find = (t: string) => Object.entries(nodes).find(([, n]) => n.type === t)?.[0];
    const time = find('TimeSource')!;
    const ref = (node: string, socket = 'out') => ({ node, socket });
    const n = (id: string, type: string, params: object, inputs: object = {}) => ({
      id,
      type,
      version: 1,
      params,
      inputs,
    });
    Object.assign(b.state.nodes, {
      old_prompt: n('old_prompt', 'Prompt', { text: 'golden hour', negative: 'blurry', tags: [] }),
      old_beauty: n('old_beauty', 'BeautyPass', {}, { time: ref(time) }),
      old_depth: n('old_depth', 'DepthPass', {}, { time: ref(time) }),
      old_normal: n('old_normal', 'NormalPass', {}, { time: ref(time) }),
      old_ai: n(
        'old_ai',
        'ComfyUIWorkflow',
        {
          presetId: 'stylizedRealism',
          graph: null,
          frameStart: 0,
          frameEnd: 30,
          lastGoodFrame: -1,
          outputPath: 'renders/job/stylized_stylizedRealism',
        },
        {
          prompt: ref('old_prompt'),
          'pass-input': [ref('old_beauty'), ref('old_depth'), ref('old_normal')],
          time: ref(time),
        },
      ),
    });
    b.formatVersion = 30;
    await w.__basher_import_scene_bundle!(b);
  });
  await page.waitForFunction(
    () => (window as unknown as W).__basher_dag.getState().state.nodes.old_ai !== undefined,
  );
  const migrated = await page.evaluate(() => {
    const n = (window as unknown as W).__basher_dag.getState().state.nodes.old_ai;
    return { params: Object.keys(n.params), inputs: n.inputs };
  });
  expect(migrated.params).not.toContain('presetId');
  expect(migrated.inputs).toMatchObject({
    beauty: { node: 'old_beauty' },
    depth: { node: 'old_depth' },
    normal: { node: 'old_normal' },
    prompt: { node: 'old_prompt' },
  });

  await openDrawerTab(page, 'nodes');
  await page.locator('[data-graph-node="old_ai"]').click();
  await expect(page.getByTestId('comfy-workflow-file')).toHaveText('Stylized realism');
  await expect
    .poll(() => drawnInputs(page, 'old_ai'))
    .toEqual([
      'beauty:frames',
      'depth:frames',
      'normal:frames',
      'prompt:text',
      'negative:text',
      'time:time',
    ]);
  expect(await drawnOutputs(page, 'old_ai')).toEqual(['stylized:frames']);
  await expect(page.getByTestId('comfy-socket-fed-prev_frame_image')).toContainText(
    'previous frame of stylized',
  );
  await observe(page, 'old_ai', 'migrated-preset');
});
