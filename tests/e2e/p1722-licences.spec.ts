// #1722 — licences where a director decides.
//
// DONE WHEN: a project using a non-commercial model cannot be exported as commercial without the
// warning, and the warning names the asset and the model. Driven through the director's roads: the
// compositor's Export menu and File ▸ Render Animation, with "For commercial use" switched on in
// the menu itself. The non-commercial model is a motion generator naming a checkpoint the licence
// manifest records as BLOCKED — DERIVED from the manifest, never spelled, because the licence audit
// scans source for blocked ids. No generation runs: the generator refuses a blocked checkpoint
// before any request, and the motion server's address is answered with an abort regardless.
//
// The Library half: every tile carries its licence, the details give the exact credit owed, and an
// import is unknown until its director says otherwise.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { openDrawerTab } from './_drawer';
import { aBlockedRecord } from '../../src/core/licensing/blockedModelForTests';
import { MODEL_RECORDS } from '../../src/core/licensing/allowedModels';

/** A real checkpoint name the manifest blocks. */
const BLOCKED = aBlockedRecord().name.split(',')[0]!.trim();
const CLIP_NAME = 'Hero walk';

interface Win {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: unknown[]) => void;
      dispatch: (op: unknown) => void;
    };
  };
  __basher_render_animation_store: {
    getState: () => { active: boolean };
    subscribe: (fn: (s: { active: boolean }) => void) => () => void;
  };
  __basher_ingestBvhFile?: (bytes: Uint8Array, name: string) => Promise<string>;
  __renderBegan?: boolean;
}

/** A motion generator naming the blocked checkpoint, and the clip it fills. */
async function addNonCommercialMotion(page: Page): Promise<void> {
  await page.evaluate(
    ({ model, name }) => {
      (window as unknown as Win).__basher_dag.getState().dispatchAtomic([
        {
          type: 'addNode',
          nodeId: 'p1722_gen',
          nodeType: 'MotionGenerate',
          params: { prompt: 'a heroic walk', seed: 7, model },
        },
        {
          type: 'addNode',
          nodeId: 'p1722_clip',
          nodeType: 'AnimationClip',
          params: { name, loop: 'hold', poses: [], sourceHash: '' },
        },
        {
          type: 'connect',
          from: { node: 'p1722_gen', socket: 'out' },
          to: { node: 'p1722_clip', socket: 'source' },
        },
      ]);
    },
    { model: BLOCKED, name: CLIP_NAME },
  );
}

/** Record whether a render ever starts from here on — "the export did not proceed". */
async function watchRenderStart(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Win;
    w.__renderBegan = w.__basher_render_animation_store.getState().active;
    w.__basher_render_animation_store.subscribe((s) => {
      if (s.active) w.__renderBegan = true;
    });
  });
}
const renderBegan = (page: Page) =>
  page.evaluate(() => Boolean((window as unknown as Win).__renderBegan));

test.beforeEach(async ({ page }) => {
  // No real motion server is ever reached, whatever is running on this machine.
  await page.route(/127\.0\.0\.1:8600\//, (route) => route.abort());
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as unknown as Win).__basher_render_animation_store),
  );
});

test('a commercial compositor export lists the non-commercial model, and exports only once confirmed', async ({
  page,
}) => {
  // An export renders every frame of the comp (150), and CI renders in software: in one CI run the
  // PNG export finished just past the default 60 s budget, its download notice already on screen.
  // The work is real, so the budget triples (test.slow) rather than the work being skipped.
  test.slow();
  await addNonCommercialMotion(page);
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
  await page.getByTestId('video-mode-add-layer').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('video-mode-add-media').click(),
  ]);
  await chooser.setFiles('public/fixtures/multifile/flat/texture.png');
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('1 layer', {
    timeout: 8_000,
  });

  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await watchRenderStart(page);

  // Switch commercial use on, in the Export menu itself.
  await page.getByTestId('video-mode-export').click();
  const toggle = page.getByTestId('video-mode-export-commercial');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('video-mode-export-mp4').click();

  // The warning names the asset and the model.
  const warning = page.getByTestId('licence-warning');
  await expect(warning).toBeVisible();
  const blockedPart = warning.getByTestId('licence-warning-part').filter({
    has: page.getByTestId('licence-warning-asset').getByText(CLIP_NAME, { exact: true }),
  });
  await expect(blockedPart).toHaveCount(1);
  await expect(blockedPart).toHaveAttribute('data-commercial', 'no');
  await expect(blockedPart.getByTestId('licence-warning-model')).toHaveText(BLOCKED);
  // The imported image has no recorded licence: listed as unknown, not waved through.
  await expect(
    warning.locator('[data-testid="licence-warning-part"][data-commercial="unknown"]'),
  ).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('p1722-export-warning.png') });

  // Nothing renders while the warning waits — and Cancel keeps it that way.
  await page.waitForTimeout(1_000);
  expect(await renderBegan(page), 'no render starts before the director answers').toBe(false);
  await page.getByTestId('licence-warning-cancel').click();
  await expect(warning).toHaveCount(0);
  await expect(page.getByTestId('toast-info')).toContainText('cancelled');
  await page.waitForTimeout(1_000);
  expect(await renderBegan(page), 'a cancelled export never renders').toBe(false);
  expect(downloads, 'a cancelled export downloads nothing').toEqual([]);

  // Confirming is the only way through: the export then runs and downloads.
  await page.getByTestId('video-mode-export').click();
  await expect(page.getByTestId('video-mode-export-commercial')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByTestId('video-mode-export-mp4').click();
  await expect(warning).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 150_000 }),
    page.getByTestId('licence-warning-confirm').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.(mp4|zip)$/);
});

test('File ▸ Render Animation raises the same warning, and a cancelled render never starts', async ({
  page,
}) => {
  await addNonCommercialMotion(page);
  await watchRenderStart(page);

  await page.getByTestId('menu-file-button').click();
  await page.getByTestId('menu-file-render-animation').hover();
  const toggle = page.getByTestId('menu-file-render-animation-commercial');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('menu-file-render-animation-mp4').click();

  const warning = page.getByTestId('licence-warning');
  await expect(warning).toBeVisible();
  await expect(warning.getByTestId('licence-warning-asset')).toHaveText([CLIP_NAME]);
  await expect(warning.getByTestId('licence-warning-model')).toHaveText([BLOCKED]);
  await page.waitForTimeout(1_000);
  expect(await renderBegan(page)).toBe(false);
  await page.getByTestId('licence-warning-cancel').click();
  await expect(warning).toHaveCount(0);
  await page.waitForTimeout(1_000);
  expect(await renderBegan(page), 'the render never started').toBe(false);
});

test('with commercial use off, an export raises no warning', async ({ page }) => {
  test.slow(); // the same 150-frame export as above
  await addNonCommercialMotion(page);
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
  await page.getByTestId('video-mode-add-layer').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('video-mode-add-media').click(),
  ]);
  await chooser.setFiles('public/fixtures/multifile/flat/texture.png');
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('1 layer', {
    timeout: 8_000,
  });
  await page.getByTestId('video-mode-export').click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 150_000 }),
    page.getByTestId('video-mode-export-png').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  await expect(page.getByTestId('licence-warning')).toHaveCount(0);
});

test('every Library tile shows its licence, and the details give the credit it needs', async ({
  page,
}) => {
  // A clean asset store, so "your imports" holds only what this test puts there.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry('basher', { recursive: true });
    } catch {
      /* not present */
    }
  });
  await page.reload();
  await page.waitForFunction(() => Boolean((window as unknown as Win).__basher_ingestBvhFile));
  await page.evaluate(async () => {
    const buf = await fetch('/fixtures/anim/walk.bvh').then((r) => r.arrayBuffer());
    await (window as unknown as Win).__basher_ingestBvhFile!(new Uint8Array(buf), 'my-walk');
  });
  await openDrawerTab(page, 'library');

  // A Basher-made sample: free to use.
  const cubeBadge = page.getByTestId('library-licence-assets/cube.gltf');
  await expect(cubeBadge).toHaveText('Free to use', { timeout: 10_000 });
  await expect(cubeBadge).toHaveAttribute('data-commercial', 'yes');

  // The motion shelf owes NVIDIA's credit — the exact line NOTICE carries, from the same record.
  const shelfRecord = MODEL_RECORDS.find((r) => r.id === 'kimodo-open-model-checkpoints')!;
  await expect(page.getByTestId('library-licence-assets/motion/walk.bvh')).toHaveText(
    'Credit required',
  );
  await page.getByTestId('library-popover-item-assets/motion/walk.bvh').click();
  const details = page.getByTestId('library-details-licence');
  await expect(details.getByTestId('library-details-licence-name')).toHaveText(shelfRecord.licence);
  await expect(details.getByTestId('library-details-licence-credit')).toHaveText(
    shelfRecord.attribution!,
  );
  await expect(details.getByTestId('library-details-licence-commercial')).toHaveText('Allowed');
  await page.screenshot({ path: test.info().outputPath('p1722-library-credit.png') });

  // An import is unknown — amber, never allowed — until its director says what it is.
  const mineBadge = page.getByTestId('library-licence-user-imports/my-walk/my-walk.bvh');
  await expect(mineBadge).toHaveText('Licence unknown');
  await expect(mineBadge).toHaveAttribute('data-commercial', 'unknown');
  await page.getByTestId('library-popover-my-import-user-imports/my-walk/my-walk.bvh').click();
  await expect(details.getByTestId('library-details-licence-commercial')).toHaveText(
    'Unknown — check the terms',
  );
  await page.screenshot({ path: test.info().outputPath('p1722-library-badges.png') });
  await details.getByTestId('library-details-licence-set').selectOption('cc-by');
  const credit = details.getByTestId('library-details-licence-credit-input');
  await credit.fill('“My walk” by A. Mover, CC BY 4.0');
  await credit.press('Enter');
  await expect(mineBadge).toHaveText('Credit required');
  await expect(details.getByTestId('library-details-licence-credit')).toHaveText(
    '“My walk” by A. Mover, CC BY 4.0',
  );
  await page.screenshot({ path: test.info().outputPath('p1722-library-set-licence.png') });
});
