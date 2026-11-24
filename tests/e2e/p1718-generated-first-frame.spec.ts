// p1718 (#1718) — 2D ▸ Generated: a reference still made from a shot's first frame, used as the
// shot's first frame.
//
// Decided design (editor board 12b): the Generated tab runs a still workflow (a ComfyUI workflow
// node whose file has a still output) on Basher's render of the shot's first frame plus a prompt,
// shows four variants, and "Use as first frame of Shot N" wires the kept still into the shot's
// video workflow. Basher runs the still before the shot that needs it.
//
// Done when: changing the still's prompt marks the shot that uses it stale, and regenerating
// runs the still first, then the shot.
//
// No server: the stub capability is installed through the dev seam, and what it was sent is read
// back through `__basher_stubComfySubmissions` (per submission, the outputs the submitted
// workflow declares). The wire and the stale state are read off the live graph and the badges.
//
// REF: src/app/GeneratedView.tsx; src/app/generated/generatedStill.ts;
//      src/nodes/comfyWorkflowMade.ts; src/app/render/regenerateWorkflow.ts.

import type { Page } from '@playwright/test';
import { FIXTURE_META, STILL_FILE, VIDEO_FILE } from '../../src/test-utils/stillAndShots';
import { expect, test } from './_fixtures';
import { openDrawerTab } from './_drawer';

test.setTimeout(120_000);

interface Ref {
  node: string;
  socket: string;
}
interface W {
  __basher_useStubComfy: () => void;
  __basher_stubComfySubmissions: () => string[][] | null;
  __basher_dag: {
    getState: () => {
      state: {
        outputs: Record<string, Ref | undefined>;
        nodes: Record<string, { type: string; inputs: Record<string, Ref | Ref[]> }>;
      };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
}

const SHOT_DIR = process.env.P1718_SHOT_DIR ?? null;
async function observe(page: Page, name: string): Promise<void> {
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/p1718-${name}.png` });
}

async function boot(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* not present */
      }
    }
    for (const k of ['basher.splitView.v1', 'basher.twoDView.v1']) localStorage.removeItem(k);
  });
  await page.reload();
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 30_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 30_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(
      w.__basher_dag?.getState().state.outputs.scene &&
      w.__basher_useStubComfy &&
      w.__basher_stubComfySubmissions,
    );
  });
  await page.evaluate(() => (window as unknown as W).__basher_useStubComfy());
}

/** A still workflow and Shot 1's video workflow (frames 0..2, a still input `first_frame`). */
async function seed(page: Page): Promise<void> {
  await page.evaluate(
    ({ still, video, meta }) => {
      (window as unknown as W).__basher_dag.getState().dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: 'ref_still',
            nodeType: 'ComfyUIWorkflow',
            params: {
              graph: { apiJson: still, meta: { ...meta, name: 'Reference still' } },
              frameStart: 0,
              frameEnd: 0,
            },
          },
          {
            type: 'addNode',
            nodeId: 'shot1_video',
            nodeType: 'ComfyUIWorkflow',
            params: {
              graph: { apiJson: video, meta: { ...meta, name: 'Shot video' } },
              frameStart: 0,
              frameEnd: 2,
              outputPath: 'renders/shot1/video',
            },
          },
        ],
        'user',
        'seed #1718',
      );
    },
    { still: STILL_FILE, video: VIDEO_FILE, meta: FIXTURE_META },
  );
}

const submissions = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_stubComfySubmissions() ?? []);

/** Every wire out of `from` in the live graph, as `consumer.socket`. */
const wiresFrom = (page: Page, from: string) =>
  page.evaluate((id) => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    const out: string[] = [];
    for (const [nid, n] of Object.entries(nodes)) {
      for (const [socket, b] of Object.entries(n.inputs)) {
        for (const r of Array.isArray(b) ? b : [b]) {
          if (r?.node === id) out.push(`${nid}.${socket} <- ${r.socket}`);
        }
      }
    }
    return out;
  }, from);

test('2D ▸ Generated: a still for Shot 1, its first frame; a prompt edit makes the shot stale, and Regenerate runs still then shot', async ({
  page,
}) => {
  await boot(page);
  await seed(page);

  await page.getByTestId('space-switch-uv').click();
  await page.getByTestId('twodview-tab-generated').click();
  await expect(page.getByTestId('twodview-generated-pane')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('generated-still-select')).toHaveValue('ref_still');
  await expect(page.getByTestId('generated-still-state')).toHaveAttribute('data-state', 'unmade');
  await expect(page.getByTestId('generated-prompt')).toHaveValue('a castle at dusk');

  // Generate: Basher renders Shot 1's first frame and the still workflow runs four times.
  await page.getByTestId('generated-generate').click();
  // Four pictures, or the error the tab shows (never a bare timeout). The first Generate on a
  // cold dev server compiles the render road, hence the long wait.
  const status = page.getByTestId('generated-status');
  await expect
    .poll(
      async () =>
        (await status.getAttribute('data-status')) === 'error'
          ? `error: ${await status.innerText()}`
          : await page.getByTestId('generated-variants').locator('img').count(),
      { timeout: 90_000 },
    )
    .toBe(4);
  for (const seedValue of [7, 8, 9, 10]) {
    await expect(page.getByTestId(`generated-variant-${seedValue}`)).toBeVisible();
  }
  expect(await submissions(page)).toEqual([['still'], ['still'], ['still'], ['still']]);
  // The render reached the still workflow as an image clip on its render input.
  const renderWire = await page.evaluate(() => {
    const n = (window as unknown as W).__basher_dag.getState().state.nodes;
    const ref = n.ref_still.inputs.render as Ref;
    return { type: n[ref.node]?.type };
  });
  expect(renderWire).toEqual({ type: 'MediaClip' });
  await observe(page, 'variants');

  // Pick the third, keep it.
  await page.getByTestId('generated-variant-9').click();
  await expect(page.getByTestId('generated-variant-9')).toHaveAttribute('data-picked', 'true');
  await page.getByTestId('generated-keep').click();
  await expect(page.getByTestId('generated-still-state')).toHaveAttribute('data-state', 'current');

  // Use as first frame of Shot 1: exactly one wire, into the shot's first-frame input.
  await expect(page.getByTestId('generated-use-first-frame')).toHaveText(
    'Use as first frame of Shot 1',
  );
  await page.getByTestId('generated-use-first-frame').click();
  await expect
    .poll(() => wiresFrom(page, 'ref_still'))
    .toEqual(['shot1_video.first_frame <- still']);
  // Wired so already: the button says so and adds nothing more.
  await expect(page.getByTestId('generated-use-first-frame')).toHaveText('First frame of Shot 1');
  await expect(page.getByTestId('generated-use-first-frame')).toBeDisabled();
  await expect(page.getByTestId('generated-shot-state-shot1_video')).toHaveAttribute(
    'data-state',
    'unmade',
  );

  // Make the shot: the kept still is current, so only the shot runs (its three frames).
  await page.getByTestId('generated-regenerate-shot1_video').click();
  await expect(page.getByTestId('generated-shot-state-shot1_video')).toHaveAttribute(
    'data-state',
    'current',
    { timeout: 30_000 },
  );
  expect((await submissions(page)).slice(4)).toEqual([['video'], ['video'], ['video']]);

  // Change the still's prompt: the still and the shot it feeds read stale.
  await page.getByTestId('generated-prompt').fill('a castle at dawn, low fog');
  await page.getByTestId('generated-prompt').blur();
  await expect(page.getByTestId('generated-still-state')).toHaveAttribute('data-state', 'stale');
  await expect(page.getByTestId('generated-shot-state-shot1_video')).toHaveAttribute(
    'data-state',
    'stale',
  );
  await observe(page, 'stale');

  // Regenerate the shot: the still first, then the shot, each once.
  const before = (await submissions(page)).length;
  await page.getByTestId('generated-regenerate-shot1_video').click();
  await expect(page.getByTestId('generated-shot-state-shot1_video')).toHaveAttribute(
    'data-state',
    'current',
    { timeout: 30_000 },
  );
  await expect(page.getByTestId('generated-still-state')).toHaveAttribute('data-state', 'current');
  expect((await submissions(page)).slice(before)).toEqual([
    ['still'],
    ['video'],
    ['video'],
    ['video'],
  ]);
  await expect(page.getByTestId('generated-status')).toHaveText('Ran ref_still → shot1_video.');
  await observe(page, 'regenerated');

  // The wire in the Nodes view.
  if (SHOT_DIR) {
    await openDrawerTab(page, 'nodes');
    await page.getByTestId('graph-view-fit').click();
    await expect(page.locator('[data-graph-node="shot1_video"]')).toBeVisible();
    await observe(page, 'nodes-wire');
  }
});
