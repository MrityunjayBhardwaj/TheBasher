// #163 — the curve editor falls back to the SELECTED object's channel when no
// channel row is explicitly active, so it isn't empty after keying. Grounded in
// Blender's Graph Editor / Houdini's Animation Editor (selected object's curves
// show automatically). Read-only fallback — no store write.
import { test, expect } from '@playwright/test';

interface W {
  __basher_dag?: { getState: () => { state: { nodes: Record<string, { type: string }> } } };
  __basher_time?: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_autokey?: { getState: () => { enabled: boolean; toggle: () => void } };
  __basher_viewport?: { getState: () => { setTimelineDrawerOpen: (o: boolean) => void } };
  __basher_timeline_dock?: { getState: () => { setActiveTab: (t: string) => void } };
  __basher_timeline_selection?: { getState: () => { activeChannelId: string | null } };
}

test('keyed object → curve editor shows its curve without picking a Dopesheet row', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(
      w.__basher_dag &&
      w.__basher_selection &&
      w.__basher_time &&
      w.__basher_viewport &&
      w.__basher_timeline_dock,
    );
  });

  // Select cube at frame 0, Auto-Key OFF, key POSITION via the real diamond.
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__basher_time!.getState().pause();
    w.__basher_time!.getState().setTime(0);
    w.__basher_selection!.getState().select('n_box');
    const ak = w.__basher_autokey!.getState();
    if (ak.enabled) ak.toggle();
  });
  await expect(page.getByTestId('inspector')).toBeVisible();
  await page
    .getByTestId('inspector-section-toggle-transform')
    .click()
    .catch(() => {});
  await page.getByTestId('inspector-diamond-n_box-position').click();
  await page.waitForTimeout(100);

  // Open the timeline drawer on the Curve tab — WITHOUT clicking any channel row.
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__basher_viewport!.getState().setTimelineDrawerOpen(true);
    w.__basher_timeline_dock!.getState().setActiveTab('curve');
    // ensure the cube (the keyed object) is the selection driving the fallback
    w.__basher_selection!.getState().select('n_box');
  });
  await page.waitForTimeout(150);

  // No channel was explicitly activated — the fallback must kick in.
  const active = await page.evaluate(
    () => (window as unknown as W).__basher_timeline_selection!.getState().activeChannelId,
  );
  expect(active, 'fallback must NOT mutate the store (read-only)').toBeNull();

  // The curve editor renders the position channel's curve (track lines present),
  // NOT the empty message.
  const curveEditor = page.getByTestId('curve-editor');
  await expect(curveEditor).toHaveCount(1);
  const trackCount = await page.getByTestId('curve-track-0').count();
  const text = await curveEditor.innerText();
  expect(trackCount, `expected a rendered curve track; editor text was: ${text}`).toBeGreaterThan(
    0,
  );
});
