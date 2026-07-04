// #263 — per-channel mute in the dopesheet (restored after the AnimationLayer
// retirement, V57/#199) + #264 — clicking a channel row selects it (the gate
// that arms Key/Simplify/Clear/Mute, dropped in the P6 W9 SVG→canvas rewrite).
//
// Real-environment e2e by necessity: the row-select + mute-dim live on the
// canvas 2D surface whose geometry only resolves in a real browser (happy-dom
// has no layout). The paint-dim draw contract is unit-tested separately
// (TimelineCanvas.test.tsx); this spec proves the end-to-end USER path —
// author → select the row → mute → the render actually stops following.
//
// REF: src/timeline/TimelineDrawer.tsx (Mute toolbar toggle),
//      src/timeline/TimelineCanvas.tsx onPointerDown (row-select #264),
//      src/nodes/overlayChannels.ts (the resolver's mute gate), V57/#199.
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
  __basher_timeline_selection?: { getState: () => { activeChannelId: string | null } };
  __basher_mesh_world_position?: (id: string) => [number, number, number] | null;
}

const setTime = (page: Page, s: number) =>
  page.evaluate((sec) => (window as unknown as W).__basher_time!.getState().setTime(sec), s);
const activeCh = (page: Page) =>
  page.evaluate(
    () => (window as unknown as W).__basher_timeline_selection!.getState().activeChannelId,
  );
const boxX = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_mesh_world_position!('n_box')?.[0] ?? null);
const channelMute = (page: Page) =>
  page.evaluate(() => {
    const nodes = (window as unknown as W).__basher_dag!.getState().state.nodes;
    const ch = Object.values(nodes).find((n) => n.type.startsWith('KeyframeChannel'));
    return (ch?.params as { mute?: boolean } | undefined)?.mute === true;
  });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_dag && w.__basher_time && w.__basher_mesh_world_position?.('n_box'));
  });
});

test('a dopesheet row click arms the toolbar; Mute silences the channel in the render', async ({
  page,
}) => {
  // ── Author a position channel that displaces the box to x=4 at t=2 ──────
  await page.evaluate(() =>
    (window as unknown as W).__basher_selection!.getState().select('n_box'),
  );
  await expect(page.getByTestId('inspector')).toBeVisible();
  await page.getByTestId('inspector-section-toggle-transform').click();
  await setTime(page, 0);
  await page.getByTestId('inspector-diamond-n_box-position').click();
  await page.getByTestId('autokey-toggle').click();
  await setTime(page, 2);
  const xin = page.getByTestId('inspector-vec-n_box-position-x');
  await xin.fill('4');
  await xin.press('Tab');
  expect(await boxX(page)).toBeCloseTo(4, 1);

  // ── Open the dopesheet and select the channel by CLICKING ITS ROW (#264) ─
  const open = await page
    .getByTestId('timeline-canvas')
    .isVisible()
    .catch(() => false);
  if (!open) await page.getByTestId('timeline-drawer-toggle').click();
  await expect(page.getByTestId('timeline-canvas')).toBeVisible();

  expect(await activeCh(page)).toBeNull();
  const muteBtn = page.getByTestId('timeline-toolbar-mute');
  await expect(muteBtn).toHaveAttribute('data-disabled', 'true'); // no channel yet

  // Row 0 sits just below the 17px ruler → y≈29; mid-track x avoids diamonds.
  await page.getByTestId('timeline-canvas').click({ position: { x: 300, y: 29 } });
  expect(await activeCh(page)).not.toBeNull(); // row click armed the channel

  // ── Mute → the render stops following (box returns to base) ─────────────
  await expect(muteBtn).toHaveAttribute('data-disabled', 'false');
  await muteBtn.click();
  expect(await channelMute(page)).toBe(true);
  await expect(muteBtn).toHaveAttribute('data-active', 'true');
  expect(await boxX(page)).toBeCloseTo(0, 1); // muted → base pose, not x=4

  // ── Unmute → the render follows again ───────────────────────────────────
  await muteBtn.click();
  expect(await channelMute(page)).toBe(false);
  expect(await boxX(page)).toBeCloseTo(4, 1);
});
