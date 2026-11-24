// #1716 — frames wired into a still input pick a frame, and the Nodes editor says which, in the
// running app. A video clip feeds two ComfyUI workflows: an imported one (a still workflow, run
// once) and a preset one (a video workflow, run frame by frame). The still workflow's input row
// reads "frame 0"; the video workflow's does not, because it steps through the clip. Unwiring
// the marker from the row, or the pick from the evaluator, drops one of these assertions.

import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';
import { openDrawerTab } from './_drawer';

interface W {
  __basher_dag: {
    getState(): {
      state: { outputs: { scene?: { node: string } } };
      dispatch: (op: unknown, src: string, d: string) => void;
    };
  };
}

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

// #1715 — a workflow file whose `picture` input takes a still (kind image) or frames (video).
const graphTaking = (kind: 'image' | 'video') => ({
  apiJson: { '1': { class_type: 'basher_controller', inputs: { name: 'picture', kind } } },
  meta: { name: `takes_${kind}`, importedAt: 'e2e', fps: 30, frames: 1 },
});
const GRAPHS = { still: graphTaking('image'), video: graphTaking('video') };

test('a still workflow fed a video says on its input which frame it takes', async ({ page }) => {
  await boot(page);
  await page.evaluate((graphs) => {
    const d = (window as unknown as W).__basher_dag.getState();
    const ops = [
      {
        type: 'addNode',
        nodeId: 'p1716_clip',
        nodeType: 'MediaClip',
        params: { src: 'clips/run.mp4', mediaKind: 'video', srcFps: 30, srcFrames: 90 },
      },
      {
        type: 'addNode',
        nodeId: 'p1716_still',
        nodeType: 'ComfyUIWorkflow',
        params: { graph: graphs.still },
      },
      {
        type: 'addNode',
        nodeId: 'p1716_video',
        nodeType: 'ComfyUIWorkflow',
        params: { graph: graphs.video, frameStart: 0, frameEnd: 30 },
      },
      {
        type: 'connect',
        from: { node: 'p1716_clip', socket: 'out' },
        to: { node: 'p1716_still', socket: 'picture' },
      },
      {
        type: 'connect',
        from: { node: 'p1716_clip', socket: 'out' },
        to: { node: 'p1716_video', socket: 'picture' },
      },
    ];
    for (const op of ops) d.dispatch(op, 'user', 'e2e');
  }, GRAPHS);

  await openDrawerTab(page, 'nodes');
  const still = page.locator('[data-graph-node="p1716_still"]');
  const video = page.locator('[data-graph-node="p1716_video"]');
  await expect(still).toHaveCount(1);
  await expect(video).toHaveCount(1);

  // The still workflow's row names the frame it is handed; the video workflow's row does not.
  const picked = still.locator('[data-graph-pick="picture:0"]');
  await expect(picked).toHaveCount(1);
  await expect(picked.locator('text')).toContainText('frame 0');
  await expect(video.locator('[data-graph-pick]')).toHaveCount(0);
  await expect(video.locator('[data-graph-row="picture"]')).toHaveCount(1);

  if (process.env.P1716_SHOT) {
    await still.scrollIntoViewIfNeeded();
    await page.getByTestId('graph-view').screenshot({ path: process.env.P1716_SHOT });
    await still.screenshot({ path: process.env.P1716_SHOT.replace(/\.png$/, '-still.png') });
    await video.screenshot({ path: process.env.P1716_SHOT.replace(/\.png$/, '-video.png') });
  }
});
