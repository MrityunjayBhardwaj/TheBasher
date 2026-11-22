// #1935 — the viewport toolbar fits its space: the less-used groups live behind ⋯, and any
// everyday group the clear band cannot hold goes there too. Before this, the pill held every
// control inline (1,458 px of content) and scrolled sideways: at 1280 × 800 with the chat open
// only 814 px of it showed, and with both side panels open only 310 px.
//
// Each size runs twice: the editor's first start (panels as rails) and a returning director
// with both panels open — the narrowest band the chat column leaves.
import { expect, test } from './_fixtures';
import { clickToolbar, toolbarControl } from './_toolbar';

/** Every control the toolbar owns (armature-mode needs an armature selected, so it is not here). */
const CONTROLS = [
  'floating-toolbar-sel',
  'floating-toolbar-move',
  'floating-toolbar-rot',
  'floating-toolbar-scl',
  'top-toolbar-add',
  'floating-toolbar-shading-studio',
  'floating-toolbar-shading-wireframe',
  'floating-toolbar-shading-rendered',
  'floating-toolbar-look-through',
  'top-toolbar-assets',
  'toolbar-space-view3d',
  'toolbar-space-uv',
  'floating-toolbar-play',
  'floating-toolbar-home',
  'floating-toolbar-grid',
  'floating-toolbar-pivot',
  'floating-toolbar-orientation',
  'floating-toolbar-snap-toggle',
  'floating-toolbar-snap-step',
  'floating-toolbar-timeline',
  'top-toolbar-zoom',
  'top-toolbar-render',
  'top-toolbar-export',
  'top-toolbar-present',
];

const SIZES = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
] as const;

for (const size of SIZES) {
  for (const sidePanels of ['rails', 'open'] as const) {
    test.describe(`#1935 toolbar at ${size.width}×${size.height}, panels ${sidePanels}`, () => {
      test.use({ viewport: size, sidePanels });

      test('the pill fits its box, and every control is inline or in ⋯', async ({ page }) => {
        await page.goto('/');
        const pill = page.getByTestId('floating-viewport-toolbar');
        await expect(pill).toBeVisible();
        // The chat column is open (the default) — the condition the issue is about.
        await expect(page.getByTestId('chat-column')).toBeVisible();

        const fit = await pill.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const band = el.closest('[data-testid="floating-toolbar-band"]')!.getBoundingClientRect();
          // Every inline child lies inside the pill's visible box.
          const clipped = [...el.querySelectorAll<HTMLElement>('[data-testid]')]
            .filter((k) => {
              const r = k.getBoundingClientRect();
              return r.left < box.left - 0.5 || r.right > box.right + 0.5;
            })
            .map((k) => k.dataset.testid);
          return {
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            pillRight: box.right,
            bandLeft: band.left,
            bandRight: band.right,
            pillLeft: box.left,
            clipped,
          };
        });
        expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth);
        expect(fit.clipped).toEqual([]);
        // The pill stays inside the clear band between the islands.
        expect(fit.pillLeft).toBeGreaterThanOrEqual(fit.bandLeft - 0.5);
        expect(fit.pillRight).toBeLessThanOrEqual(fit.bandRight + 0.5);

        // The everyday groups' order: tools first; ⋯ always last.
        const inline = await pill
          .locator('[data-toolbar-group]')
          .evaluateAll((els) => els.map((e) => e.getAttribute('data-toolbar-group')));
        const overflow = (await pill.getAttribute('data-overflow')) ?? '';
        console.log(`${size.width} ${sidePanels}: inline=[${inline.join(',')}] ⋯+=[${overflow}]`);
        await expect(pill.locator('> *').last()).toContainText('⋯');

        // Every control: visible inline, or (absent from the pill and) visible once ⋯ opens.
        const inPill: string[] = [];
        for (const id of CONTROLS) {
          if (await pill.getByTestId(id).isVisible()) inPill.push(id);
        }
        await page.getByTestId('floating-toolbar-more').click();
        const menu = page.getByTestId('floating-toolbar-more-menu');
        await expect(menu).toBeVisible();
        const inMenu: string[] = [];
        for (const id of CONTROLS) {
          if (await menu.getByTestId(id).isVisible()) inMenu.push(id);
        }
        const missing = CONTROLS.filter((id) => !inPill.includes(id) && !inMenu.includes(id));
        const twice = inPill.filter((id) => inMenu.includes(id));
        expect(missing).toEqual([]);
        expect(twice).toEqual([]);
        // The less-used groups always live behind ⋯.
        for (const id of ['top-toolbar-assets', 'floating-toolbar-pivot', 'top-toolbar-present']) {
          expect(inMenu).toContain(id);
        }
        // The menu itself is on screen, above the bottom drawer row (it would be clipped there).
        const menuBox = (await menu.boundingBox())!;
        expect(menuBox.x).toBeGreaterThanOrEqual(0);
        expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(size.width);
        const drawerTop = (await page.getByTestId('timeline-drawer').boundingBox())!.y;
        expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(drawerTop);
        // ⋯ toggles the menu shut again.
        await page.getByTestId('floating-toolbar-more').click();
        await expect(menu).toHaveCount(0);
      });

      test('a control moved into ⋯ still works from there', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByTestId('floating-viewport-toolbar')).toBeVisible();
        const drawer = page.getByTestId('timeline-drawer');
        const before = await drawer.getAttribute('data-open');
        // Timeline lives behind ⋯ at every size.
        await expect(
          page.getByTestId('floating-viewport-toolbar').getByTestId('floating-toolbar-timeline'),
        ).toHaveCount(0);
        await clickToolbar(page, 'floating-toolbar-timeline');
        await expect(drawer).not.toHaveAttribute('data-open', before ?? 'false');
        // An action closes the menu.
        await expect(page.getByTestId('floating-toolbar-more-menu')).toHaveCount(0);

        // A setting keeps the menu open for the next edit: snap on, then its Affect row appears.
        const snap = await toolbarControl(page, 'floating-toolbar-snap-toggle');
        await snap.click();
        await expect(snap).toHaveAttribute('data-active', 'true');
        await expect(
          page
            .getByTestId('floating-toolbar-more-menu')
            .getByTestId('floating-toolbar-snap-affect-rotate'),
        ).toBeVisible();

        // An everyday group that overflowed works from ⋯ as well (only when one did).
        const overflow =
          (await page.getByTestId('floating-viewport-toolbar').getAttribute('data-overflow')) ?? '';
        if (overflow.split(',').includes('shading')) {
          await clickToolbar(page, 'floating-toolbar-shading-wireframe');
          await expect(
            await toolbarControl(page, 'floating-toolbar-shading-wireframe'),
          ).toHaveAttribute('data-active', 'true');
        }
        // A press outside closes the menu.
        await page.getByTestId('chat-column').click({ position: { x: 40, y: 20 } });
        await expect(page.getByTestId('floating-toolbar-more-menu')).toHaveCount(0);
      });
    });
  }
}

test.describe('#1935 the fit follows the band without a reload', () => {
  test.use({ viewport: { width: 1440, height: 900 }, sidePanels: 'open' });
  test('a narrower window moves more groups into ⋯; widening brings them back', async ({
    page,
  }) => {
    await page.goto('/');
    const pill = page.getByTestId('floating-viewport-toolbar');
    await expect(pill).toBeVisible();
    const overflowCount = async () =>
      ((await pill.getAttribute('data-overflow')) ?? '').split(',').filter(Boolean).length;
    const wide = await overflowCount();
    // 1100 px is still the desktop layout (narrow starts at 1024), so the islands keep their
    // share and the band shrinks by the whole 340 px.
    await page.setViewportSize({ width: 1100, height: 900 });
    await expect.poll(overflowCount).toBeGreaterThan(wide);
    expect(await pill.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(overflowCount).toBe(wide);
    expect(await pill.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
});
