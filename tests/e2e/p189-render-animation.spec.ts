// #189 — Render Animation: export the timeline to a downloadable MP4 or PNG
// sequence. These OBSERVE the REAL wired path (Lokayata): the actual browser
// download, the actual bytes (MP4 ftyp box / PNG zip entries), and the live
// playhead — not inferred state. Each assertion is FALSIFIABLE.
//
// Two test-environment constraints shape these tests:
//   1. Frame count is kept TINY (duration 0.05s → 4 frames). The default
//      duration is 10s (601 frames); headless chromium THROTTLES rAF on a
//      "hidden" page, so waitForApply (2 rAFs/frame) makes a long render exceed
//      the 30s test timeout. In a real 60fps foreground browser the full render
//      runs at speed — this is purely a CI-throughput cap.
//   2. The render + download is driven through the DEV SEAM (the real action,
//      __basher_render_animation), so a programmatic download event fires
//      without the OS chooser. A separate test covers the File-menu wiring.

import { test, expect } from './_fixtures';
import { unzipSync } from 'fflate';

type RenderFormat = 'mp4' | 'png-sequence';

interface W {
  __basher_time: {
    getState: () => {
      seconds: number;
      setTime: (s: number) => void;
      setDuration: (s: number) => void;
    };
  };
  __basher_render_animation: (
    format: RenderFormat,
  ) => Promise<{ ok: boolean; cancelled?: boolean; format?: RenderFormat; frameCount?: number }>;
  __basher_render_animation_store: {
    getState: () => { active: boolean; done: number; cancel: (() => void) | null };
  };
  __basher_render_png?: () => Promise<unknown>;
}

type Page = import('@playwright/test').Page;

async function waitReady(page: Page) {
  await page.goto('/');
  await page.waitForFunction(
    () =>
      Boolean((window as unknown as W).__basher_render_animation) &&
      Boolean((window as unknown as W).__basher_render_animation_store) &&
      Boolean((window as unknown as W).__basher_render_png),
  );
  await page.waitForTimeout(400); // let the first frame paint
  // Warm up the offscreen GL pipeline with one still render before the heavy
  // animation render. On the shared dev server, the very first GL readback after
  // a cold load can drop the context ("Target page closed"); doing it here makes
  // setup absorb that, not the timed assertions. Swallow its result.
  await page.evaluate(() => (window as unknown as W).__basher_render_png?.()).catch(() => {});
  await page.waitForTimeout(200);
}

/** Set a tiny duration; returns the resulting frame count (floor(d·60)+1). */
async function setTinyDuration(page: Page, seconds: number): Promise<number> {
  return page.evaluate((s) => {
    (window as unknown as W).__basher_time.getState().setDuration(s);
    return Math.floor(s * 60) + 1;
  }, seconds);
}

async function readDownload(download: import('@playwright/test').Download): Promise<Uint8Array> {
  const path = await download.path();
  const fs = await import('node:fs/promises');
  return new Uint8Array(await fs.readFile(path));
}

test.describe('#189 render animation', () => {
  test('PNG sequence downloads a .zip containing exactly frameCount PNGs', async ({ page }) => {
    await waitReady(page);
    const expectedFrames = await setTinyDuration(page, 0.05); // 4 frames

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(() => (window as unknown as W).__basher_render_animation('png-sequence')),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.zip$/);
    // Real ZIP: unzip and assert one PNG per frame (revert the loop → 1 frame).
    const entries = unzipSync(await readDownload(download));
    const names = Object.keys(entries).sort();
    expect(names.length).toBe(expectedFrames);
    expect(names.every((n) => n.endsWith('.png'))).toBe(true);
    // Each entry is a real, non-empty PNG (8-byte signature).
    const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];
    for (const n of names) {
      expect(entries[n].length).toBeGreaterThan(0);
      expect([...entries[n].slice(0, 4)]).toEqual(PNG_SIG);
    }
  });

  test('MP4 downloads a valid .mp4 (ftyp box, non-empty)', async ({ page }) => {
    await waitReady(page);
    await setTinyDuration(page, 0.05);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(() => (window as unknown as W).__basher_render_animation('mp4')),
    ]);

    // The test chromium supports WebCodecs H.264 (probed), so this is a real
    // MP4 — not the PNG-seq fallback. (Without WebCodecs the action warns +
    // downloads a .zip — the fallback path.)
    expect(download.suggestedFilename()).toMatch(/\.mp4$/);
    const bytes = await readDownload(download);
    expect(bytes.length).toBeGreaterThan(0);
    // MP4 signature: bytes 4..8 are the 'ftyp' box type.
    expect(String.fromCharCode(...bytes.slice(4, 8))).toBe('ftyp');
  });

  test('the render scrubs the playhead through the timeline, then restores it', async ({
    page,
  }) => {
    await waitReady(page);
    await setTinyDuration(page, 0.05); // frames at 0, 0.0167, 0.033, 0.05
    // Park the playhead at a non-zero, non-endpoint time so both "moved" and
    // "restored" are meaningful.
    await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(0.033));

    const done = page.evaluate(() =>
      (window as unknown as W).__basher_render_animation('png-sequence'),
    );

    // During the render the playhead leaves the parked time (the loop scrubs the
    // whole range — it is not rendering one frozen frame).
    await expect
      .poll(() => page.evaluate(() => (window as unknown as W).__basher_time.getState().seconds), {
        timeout: 15_000,
      })
      .not.toBe(0.033);

    const result = await done;
    expect(result.ok).toBe(true);
    expect(result.frameCount).toBe(4);
    // Restored to the parked time (finally), not left at the timeline end.
    const after = await page.evaluate(
      () => (window as unknown as W).__basher_time.getState().seconds,
    );
    expect(after).toBeCloseTo(0.033, 5);
  });

  test('Cancel mid-render stops cleanly and restores the playhead', async ({ page }) => {
    await waitReady(page);
    await setTinyDuration(page, 0.2); // ~13 frames — time to cancel mid-flight
    await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(0.1));

    const done = page.evaluate(() =>
      (window as unknown as W).__basher_render_animation('png-sequence'),
    );

    // Wait until the render is in flight (≥1 frame done), then cancel.
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as unknown as W).__basher_render_animation_store.getState().done,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    await page.evaluate(() =>
      (window as unknown as W).__basher_render_animation_store.getState().cancel?.(),
    );

    const result = await done;
    expect(result.cancelled).toBe(true);
    // The progress store cleared, and the playhead is restored.
    const store = await page.evaluate(() =>
      (window as unknown as W).__basher_render_animation_store.getState(),
    );
    expect(store.active).toBe(false);
    const after = await page.evaluate(
      () => (window as unknown as W).__basher_time.getState().seconds,
    );
    expect(after).toBeCloseTo(0.1, 5);
  });

  test('the File menu surfaces Render Animation ▸ MP4 / PNG sequence', async ({ page }) => {
    // No render here — a light wait is enough (avoids the heavy warmup render).
    await page.goto('/');
    await page.waitForFunction(() => Boolean((window as unknown as W).__basher_render_animation));
    await page.getByTestId('menu-file-button').click();
    // The submenu opens on hover (and on click) — hover reveals its items.
    await page.getByTestId('menu-file-render-animation').hover();
    await expect(page.getByTestId('menu-file-render-animation-mp4')).toBeVisible();
    await expect(page.getByTestId('menu-file-render-animation-png')).toBeVisible();
  });
});
