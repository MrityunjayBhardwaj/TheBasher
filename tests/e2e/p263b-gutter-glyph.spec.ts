// #263 follow-up — per-row mute/solo GLYPHS in the dopesheet label gutter.
//
// The #263 mute/solo capability shipped reachable only via the toolbar, which
// acts on the ACTIVE channel (select the row first, then click Mute/Solo). This
// increment adds a direct click target in each row's gutter: an "M" and "S" glyph
// you click to toggle THAT row's channel, no active-selection dance. Pure UI over
// the same setParam the toolbar dispatches — the resolver (overlayChannels +
// channelValuesFromNodes solo scope) is untouched, so render == read holds.
//
// Real-environment e2e by necessity: the glyphs + their hit-region live on the
// canvas 2D surface, whose geometry only resolves in a real browser (happy-dom
// has no layout). The pure hit-test (gutterGlyphHit) is unit-tested in
// TimelineCanvas.test.tsx; this spec proves the end-to-end USER path — author two
// channels → click a gutter glyph → the render actually changes to match.
//
// REF: src/timeline/TimelineCanvas.tsx (paintStaticLayer glyphs + onPointerDown
//      gutterGlyphHit branch), src/app/nodeChannels.ts (per-target solo scope),
//      src/nodes/overlayChannels.ts (the mute gate), V57/#199/#263.
import { test, expect } from './_fixtures';

type Page = import('@playwright/test').Page;

interface W {
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
    };
  };
  __basher_mesh_world_position?: (id: string) => [number, number, number] | null;
  __basher_mesh_world_scale?: (id: string) => [number, number, number] | null;
}

const setTime = (page: Page, s: number) =>
  page.evaluate((sec) => (window as unknown as W).__basher_time!.getState().setTime(sec), s);
const boxX = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_mesh_world_position!('n_box')?.[0] ?? null);
const boxScaleX = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_mesh_world_scale!('n_box')?.[0] ?? null);
// Read the mute/solo flag of the channel whose paramPath matches (position | scale).
const channelFlag = (page: Page, paramPath: string, flag: 'mute' | 'solo') =>
  page.evaluate(
    ([pp, fl]) => {
      const nodes = (window as unknown as W).__basher_dag!.getState().state.nodes;
      const ch = Object.values(nodes).find(
        (n) =>
          n.type.startsWith('KeyframeChannel') &&
          (n.params as { paramPath?: string }).paramPath === pp,
      );
      return (ch?.params as Record<string, unknown> | undefined)?.[fl] === true;
    },
    [paramPath, flag] as const,
  );

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_dag && w.__basher_time && w.__basher_mesh_world_position?.('n_box'));
  });
});

test('gutter M/S glyphs toggle a row directly — render follows (mute reverts, solo isolates)', async ({
  page,
}) => {
  // ── Author TWO channels on n_box: position x→4 and scale x→2 at t=2 ──────
  // Authored position-FIRST so its channel node is created first → dopesheet
  // row 0 = position, row 1 = scale (collectChannelRows is insertion-ordered).
  await page.evaluate(() =>
    (window as unknown as W).__basher_selection!.getState().select('n_box'),
  );
  await expect(page.getByTestId('inspector')).toBeVisible();
  await page.getByTestId('inspector-section-toggle-transform').click();
  await page.getByTestId('autokey-toggle').click();

  // position: key at t=0, then x=4 at t=2.
  await setTime(page, 0);
  await page.getByTestId('inspector-diamond-n_box-position').click();
  await setTime(page, 2);
  const px = page.getByTestId('inspector-vec-n_box-position-x');
  await px.fill('4');
  await px.press('Tab');

  // scale: key at t=0 (base 1,1,1), then x=2 at t=2.
  await setTime(page, 0);
  await page.getByTestId('inspector-diamond-n_box-scale').click();
  await setTime(page, 2);
  const sx = page.getByTestId('inspector-vec-n_box-scale-x');
  await sx.fill('2');
  await sx.press('Tab');

  // Baseline at t=2: both channels drive.
  expect(await boxX(page)).toBeCloseTo(4, 1);
  expect(await boxScaleX(page)).toBeCloseTo(2, 1);

  // ── Open the dopesheet ──────────────────────────────────────────────────
  const open = await page
    .getByTestId('timeline-canvas')
    .isVisible()
    .catch(() => false);
  if (!open) await page.getByTestId('timeline-drawer-toggle').click();
  await expect(page.getByTestId('timeline-canvas')).toBeVisible();

  const canvas = page.getByTestId('timeline-canvas');
  // Gutter glyph geometry (mirrors TimelineCanvas constants): row 0 centre y≈29
  // (RULER_H 17 + ROW_HEIGHT_PX/2 12); mute glyph x-band [58,71) → 64; solo [71,84) → 77.
  const MUTE_XY = { x: 64, y: 29 };
  const SOLO_XY = { x: 77, y: 29 };

  // ── MUTE glyph on row 0 (position) → position reverts, scale still drives ─
  await canvas.click({ position: MUTE_XY });
  expect(await channelFlag(page, 'position', 'mute')).toBe(true);
  expect(await boxX(page)).toBeCloseTo(0, 1); // position muted → base x=0
  expect(await boxScaleX(page)).toBeCloseTo(2, 1); // scale untouched
  // Un-mute → position drives again.
  await canvas.click({ position: MUTE_XY });
  expect(await channelFlag(page, 'position', 'mute')).toBe(false);
  expect(await boxX(page)).toBeCloseTo(4, 1);

  // ── SOLO glyph on row 0 (position) → ONLY position drives, scale reverts ──
  await canvas.click({ position: SOLO_XY });
  expect(await channelFlag(page, 'position', 'solo')).toBe(true);
  expect(await boxX(page)).toBeCloseTo(4, 1); // solo'd position still drives
  expect(await boxScaleX(page)).toBeCloseTo(1, 1); // scale soloed-out → base scale=1
  // Un-solo → both drive again (render == read on both channels).
  await canvas.click({ position: SOLO_XY });
  expect(await channelFlag(page, 'position', 'solo')).toBe(false);
  expect(await boxScaleX(page)).toBeCloseTo(2, 1);
});
