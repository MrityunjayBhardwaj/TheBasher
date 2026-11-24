// p1717 (#1717) — Video space: one clip per shot from a ComfyUI workflow, marked generated, stale
// or generating.
//
// Decided design (editor board 12a): the Video space holds one clip per shot (the cuts from the
// Shots editor), each sourced from that shot's ComfyUI workflow fed by the shot's render passes.
// Each clip reads generated, stale or generating; "Generate stale shots (N)" runs only those. The
// viewer compares Generated with the 3D render it came from, or wipes between them.
//
// Done when: moving one shot's camera marks only that shot stale, and regenerating it calls
// ComfyUI once (one run of that shot's workflow: each of its frames sent once, nothing else).
//
// No server: the stub capability is installed through the dev seam and its submissions are read
// back (`__basher_stubComfySubmissions`). The passes are really rendered (the still render's road).
//
// REF: src/app/video/shotClips.ts; src/app/video/shotClipActions.ts; src/app/video/shotCompare.ts;
//      src/app/render/workflowMadeFrom.ts.

import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';
import { openDrawerTab } from './_drawer';
import { splitCameraOps } from './_splitCamera';

test.setTimeout(240_000);

interface W {
  __basher_useStubComfy: () => void;
  __basher_stubComfySubmissions: () => string[][] | null;
  __basher_dag: {
    getState: () => {
      dispatch: (op: unknown, source?: string, label?: string) => void;
      state: {
        outputs: Record<string, { node: string } | undefined>;
        nodes: Record<string, { type: string; params: Record<string, unknown> }>;
      };
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
}

const CAM2 = 'p1717_cam2';
const CAM3 = 'p1717_cam3';

const SHOT_DIR = process.env.P1717_SHOT_DIR ?? null;
async function observe(page: Page, name: string): Promise<void> {
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/p1717-${name}.png` });
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
    localStorage.removeItem('basher.timelineDock.v1');
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
      w.__basher_time &&
      w.__basher_useStubComfy &&
      w.__basher_stubComfySubmissions,
    );
  });
  await page.evaluate(() => (window as unknown as W).__basher_useStubComfy());
}

/** A 0.6 s film (three 0.2 s shots: frames 0–5, 6–11, 12–17 at the runner's 30 fps). */
async function seedFilm(page: Page): Promise<void> {
  await page.evaluate(
    (ops) => {
      const dag = (window as unknown as W).__basher_dag.getState();
      const scene = dag.state.outputs.scene!.node;
      dag.dispatch({ type: 'setParam', nodeId: scene, paramPath: 'frameEnd', value: 36 });
      for (const op of ops) dag.dispatch(op);
    },
    [
      ...splitCameraOps({ objectId: CAM2, position: [6, 3, 6], lookAt: [0, 0, 0] }),
      ...splitCameraOps({ objectId: CAM3, position: [-6, 4, 2], lookAt: [0, 0, 0] }),
    ],
  );
  // The cuts, from the Shots editor: at 0.2 s to the second camera, at 0.4 s to the third.
  await openDrawerTab(page, 'shots');
  const setPlayhead = (s: number) =>
    page.evaluate((sec) => (window as unknown as W).__basher_time.getState().setTime(sec), s);
  await setPlayhead(0.2);
  await page.getByTestId('shots-cut-camera').selectOption(CAM2);
  await page.getByTestId('shots-cut-here').click();
  await setPlayhead(0.4);
  await page.getByTestId('shots-cut-camera').selectOption(CAM3);
  await page.getByTestId('shots-cut-here').click();
  await expect(page.locator('[data-testid^="shot-row-"]')).toHaveCount(3);
}

const submissions = async (page: Page) =>
  (await page.evaluate(() => (window as unknown as W).__basher_stubComfySubmissions())) ?? [];

/** Each shot clip's state, top to bottom in film order (layers named Shot 1..3). */
async function clipStates(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    const layers = Object.entries(nodes)
      .filter(([, n]) => n.type === 'Layer' && /^Shot \d$/.test(String(n.params.name)))
      .sort(([, a], [, b]) => String(a.params.name).localeCompare(String(b.params.name)));
    return layers.map(
      ([id]) =>
        document
          .querySelector(`[data-testid="layer-clip-state-${id}"]`)
          ?.getAttribute('data-state') ?? 'missing',
    );
  });
}

/** Each shot workflow's (madeFrom, lastGoodFrame), in film order. */
async function workflowRecords(page: Page): Promise<[unknown, unknown][]> {
  return page.evaluate(() => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    return Object.values(nodes)
      .filter((n) => n.type === 'ComfyUIWorkflow')
      .sort((a, b) => Number(a.params.frameStart) - Number(b.params.frameStart))
      .map((n) => [n.params.madeFrom, n.params.lastGoodFrame] as [unknown, unknown]);
  });
}

/** The composite canvas's pixel at (fx, fy) of its size, after the next completed draw. */
async function pixelAfterDraw(page: Page, before: number, fx: number, fy: number) {
  const canvas = page.getByTestId('composite-canvas');
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-composite-nonce')))
    .toBeGreaterThan(before);
  return page.evaluate(
    ({ fx, fy }) => {
      const c = document.querySelector('[data-testid="composite-canvas"]') as HTMLCanvasElement;
      const d = c
        .getContext('2d')!
        .getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    { fx, fy },
  );
}
const nonce = async (page: Page) =>
  Number(await page.getByTestId('composite-canvas').getAttribute('data-composite-nonce'));

test('Video space: a clip per shot; moving shot 2’s camera stales only shot 2, and Generate stale shots runs it once', async ({
  page,
}) => {
  await boot(page);
  await seedFilm(page);

  // Into the Video space, a composition, and a clip per shot.
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
  await page.getByTestId('video-mode-make-shot-clips').click();
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('3 layers');
  await expect.poll(() => clipStates(page)).toEqual(['unmade', 'unmade', 'unmade']);
  await expect(page.getByTestId('video-mode-generate-stale')).toHaveText(
    'Generate stale shots (3)',
  );

  // Generate all three: each shot's passes are rendered, then its workflow runs, frame by frame.
  await page.getByTestId('video-mode-generate-stale').click();
  await expect
    .poll(() => clipStates(page), { timeout: 150_000 })
    .toEqual(['current', 'current', 'current']);
  expect(await submissions(page)).toHaveLength(18);
  await expect(page.getByTestId('video-mode-generate-stale')).toHaveText(
    'Generate stale shots (0)',
  );
  const made = await workflowRecords(page);

  // Move shot 2's camera, keyed at a frame in the middle of the shot (0.3 s, frame 9).
  await page.evaluate((cam) => {
    (window as unknown as W).__basher_dag.getState().dispatch(
      {
        type: 'addNode',
        nodeId: 'p1717_cam2_move',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'position',
          target: cam,
          paramPath: 'position',
          keyframes: [{ time: 0.3, value: [7, 5, 3], easing: 'linear' }],
        },
      },
      'user',
      'move shot 2 camera',
    );
  }, CAM2);
  await expect.poll(() => clipStates(page)).toEqual(['current', 'stale', 'current']);
  await expect(page.getByTestId('video-mode-generate-stale')).toHaveText(
    'Generate stale shots (1)',
  );
  await observe(page, 'mixed-states');

  // Generate stale shots (1): shot 2 alone, once — its six frames, each sent once.
  const before = (await submissions(page)).length;
  await page.getByTestId('video-mode-generate-stale').click();
  await expect
    .poll(() => clipStates(page), { timeout: 90_000 })
    .toEqual(['current', 'current', 'current']);
  expect((await submissions(page)).length - before).toBe(6);
  const after = await workflowRecords(page);
  expect(after[0]).toEqual(made[0]);
  expect(after[2]).toEqual(made[2]);
  expect(after[1][0]).not.toEqual(made[1][0]);

  // The viewer at a frame of shot 2: Generated and the 3D render it came from differ, and the wipe
  // shows the render on its left and the generated picture on its right.
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(0.3));
  let n = await nonce(page);
  await page.getByTestId('video-viewer-compare-generated').click();
  const generated = await pixelAfterDraw(page, n - 1, 0.75, 0.5);
  n = await nonce(page);
  await page.getByTestId('video-viewer-compare-render').click();
  const rendered = await pixelAfterDraw(page, n, 0.75, 0.5);
  expect(rendered).not.toEqual(generated);
  // Generated IS what the runner stored for this frame: shot 2's picture for frame 9.
  const stored = await page.evaluate(async () => {
    const w = window as unknown as W & {
      __basher_opfs: { read: (p: string) => Promise<Uint8Array> };
    };
    const shot2 = Object.values(w.__basher_dag.getState().state.nodes).find(
      (x) => x.type === 'ComfyUIWorkflow' && x.params.frameStart === 6,
    )!;
    const bytes = await w.__basher_opfs.read(`${String(shot2.params.outputPath)}_0009.png`);
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }));
    const c = new OffscreenCanvas(1, 1);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  expect(generated).toEqual(stored);
  await observe(page, 'compare-render');
  n = await nonce(page);
  await page.getByTestId('video-viewer-compare-wipe').click();
  const right = await pixelAfterDraw(page, n, 0.75, 0.5);
  const left = await pixelAfterDraw(page, n, 0.25, 0.5);
  expect(right).toEqual(generated);
  const renderLeft = await (async () => {
    const m = await nonce(page);
    await page.getByTestId('video-viewer-compare-render').click();
    return pixelAfterDraw(page, m, 0.25, 0.5);
  })();
  expect(left).toEqual(renderLeft);
  expect(left).not.toEqual(right);
  await page.getByTestId('video-viewer-compare-wipe').click();
  await expect(page.getByTestId('composite-canvas')).toHaveAttribute('data-viewer-compare', 'wipe');
  await observe(page, 'compare-wipe');

  // The right panel for shot 2's clip: its state, its locked seed, and its actions.
  const shot2Layer = await page.evaluate(() => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    return Object.entries(nodes).find(
      ([, n]) => n.type === 'Layer' && n.params.name === 'Shot 2',
    )![0];
  });
  await page.getByTestId(`layer-row-${shot2Layer}`).click();
  await expect(page.getByTestId('controls-shot-state')).toHaveAttribute('data-state', 'current');
  await expect(page.getByTestId('controls-shot-seed')).toHaveAttribute('data-locked', 'true');
  await expect(page.getByTestId('controls-shot-regenerate')).toHaveText('Regenerate');
  await expect(page.getByTestId('controls-shot-open-nodes')).toBeVisible();
  await expect(page.getByTestId('controls-shot-open-comfy')).toBeVisible();
  await observe(page, 'right-panel');
});
