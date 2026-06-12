// P6 W1 (v0.6 #4) — chrome consolidation acceptance.
//
// THE LIE THIS TEST KILLS
// =======================
// Before W1 the editor had FOUR top bands (ProjectTabs / MenuBar / Chrome /
// TopToolbar) plus TWO duplicate tool surfaces (ToolRail + FloatingViewportToolbar
// each rendering Select/Move/Rotate/Scale). The four tool buttons appeared in
// TWO DOM locations; three surfaces wrote to one setMode; chrome content was
// scattered. W1 collapses all of it into ONE floating pill (Spline region ②)
// + the ProjectTabs identity bar.
//
// This spec proves the consolidation is REAL, not cosmetic:
//   - the deleted bands (Chrome, TopToolbar, ToolRail) are gone from the DOM;
//   - every surviving control has EXACTLY ONE home, and that home is the pill;
//   - the folded save/identity cluster lives on the ProjectTabs bar.
//
// Falsifiable (H73): re-introduce ToolRail or TopToolbar and the moved controls
// render in TWO places (count === 2) → #2 fails; the deleted-band testids
// reappear → #1 fails.
//
// REF: .planning/phases/v06.4-director-ux/PLAN.md (W1); CONTEXT A-1.

import { expect, test } from './_fixtures';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible();
});

test('W1#1 the deleted bands + duplicate tool surface are gone from the DOM', async ({ page }) => {
  // Chrome band, TopToolbar band, and the whole ToolRail (R4) were deleted.
  await expect(page.getByTestId('chrome')).toHaveCount(0);
  await expect(page.getByTestId('top-toolbar')).toHaveCount(0);
  await expect(page.getByTestId('tool-rail')).toHaveCount(0);
  // ToolRail's per-tool testids are gone — no second tool surface remains.
  for (const id of [
    'tool-rail-select',
    'tool-rail-translate',
    'tool-rail-rotate',
    'tool-rail-scale',
  ]) {
    await expect(page.getByTestId(id)).toHaveCount(0);
  }
});

test('W1#2 every consolidated control has EXACTLY ONE home, inside the floating pill', async ({
  page,
}) => {
  const pill = page.getByTestId('floating-viewport-toolbar');
  await expect(pill).toHaveCount(1);

  // The four tools + the folded chrome controls each appear exactly once,
  // and each lives inside the one pill (was 2 DOM locations for the tools).
  const controls = [
    'floating-toolbar-sel',
    'floating-toolbar-move',
    'floating-toolbar-rot',
    'floating-toolbar-scl',
    'top-toolbar-add',
    'top-toolbar-assets',
    'toolbar-space-view3d',
    'toolbar-space-uv',
    'top-toolbar-zoom',
    'top-toolbar-export',
    'top-toolbar-present',
    'floating-toolbar-play',
    'floating-toolbar-timeline',
  ];
  for (const id of controls) {
    await expect(page.getByTestId(id), `${id} should have exactly one DOM home`).toHaveCount(1);
    // …and that home is the consolidated pill.
    const inPill = await page.evaluate((testId: string) => {
      const el = document.querySelector(`[data-testid="${testId}"]`);
      const pillEl = document.querySelector('[data-testid="floating-viewport-toolbar"]');
      return Boolean(el && pillEl && pillEl.contains(el));
    }, id);
    expect(inPill, `${id} should live inside the floating pill`).toBe(true);
  }
});

test('W1#3 the identity cluster folded onto the ProjectTabs bar', async ({ page }) => {
  // The project breadcrumb lives on R1 (ProjectTabs). The save button was
  // removed from the chrome (UX backlog #4) — Save is File ▸ Save / Cmd+S now.
  const tabs = page.getByTestId('project-tabs');
  await expect(tabs).toBeVisible();
  for (const id of ['project-name']) {
    await expect(page.getByTestId(id)).toHaveCount(1);
    const inTabs = await page.evaluate((testId: string) => {
      const el = document.querySelector(`[data-testid="${testId}"]`);
      const tabsEl = document.querySelector('[data-testid="project-tabs"]');
      return Boolean(el && tabsEl && tabsEl.contains(el));
    }, id);
    expect(inTabs, `${id} should live on the ProjectTabs identity bar`).toBe(true);
  }
});

test('W1#4 tool dispatch still flows through the single writer (V19 preserved)', async ({
  page,
}) => {
  // The one tool surface drives editorStore.setActiveTool; clicking a tool on
  // the pill flips the store (the duplicate ToolRail caller is gone).
  await page.getByTestId('floating-toolbar-rot').click();
  const tool = await page.evaluate(
    () =>
      (
        window as unknown as { __basher_editor: { getState: () => { activeTool: string } } }
      ).__basher_editor.getState().activeTool,
  );
  expect(tool).toBe('rotate');
});
