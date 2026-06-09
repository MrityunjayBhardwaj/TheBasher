// Spline Wave E — the home launcher restyled to the dark-Spline language
// (Waves A–D): the dev-tool look (monospace + flat opaque background + uppercase
// tracking-wide headers) is gone; the home sits on the SAME lit dark stage as
// the editor (the body's Wave A ambient glow reads through a transparent root),
// with elevated glass project cards.
//
// Lokayata: each test reads COMPUTED styles off the real DOM, and each is
// falsifiable — reverting the restyle makes the assertion fail (noted inline).
// Functionality (routing, open/new/delete, examples split) is the W4 spec's job
// (p6-w4-home.spec.ts) — this spec only pins the visual contract.

import { expect, test, type Page } from './_fixtures';

async function bootHome(page: Page): Promise<void> {
  // First run (no lastProjectId) routes to the home view.
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('basher.lastProjectId');
    } catch {
      /* storage disabled */
    }
  });
  await page.goto('/');
  await expect(page.getByTestId('home-view')).toBeVisible();
}

test.describe('Spline Wave E — home launcher restyle', () => {
  test('section headers are normal-case, not the dev-chip UPPERCASE', async ({ page }) => {
    await bootHome(page);
    // The "Your projects" / "Examples" captions dropped the uppercase
    // tracking-wide dev-chip styling (the same pattern Wave D killed on the
    // toolbar). Assert the rendered text-transform is not uppercase. Revert
    // (re-add `uppercase tracking-wide` on the h2) → computed textTransform is
    // 'uppercase' → this fails.
    const transform = await page
      .getByRole('heading', { name: 'Your projects' })
      .evaluate((el) => getComputedStyle(el).textTransform);
    expect(transform).not.toBe('uppercase');
  });

  test('the root is transparent so the body ambient glow reads through', async ({ page }) => {
    await bootHome(page);
    const bg = await page
      .getByTestId('home-view')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    // A transparent root paints nothing, so the fixed body glow (index.css)
    // shows through — the home shares the editor's lit dark stage. Revert
    // (re-add the opaque `bg-bg`) → backgroundColor is rgb(14, 14, 17) → fails.
    expect(bg).toBe('rgba(0, 0, 0, 0)');
  });

  test('project cards are elevated glass tiles (rounded-xl + shadow)', async ({ page }) => {
    await bootHome(page);
    const card = page.getByTestId('home-example-card').first();
    await expect(card).toBeVisible();
    const style = await card.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { radius: parseFloat(cs.borderTopLeftRadius), shadow: cs.boxShadow };
    });
    // Wave D language: rounded-xl (12px) + a real drop shadow. Revert to the old
    // rounded-lg (8px) shadow-sm → radius drops / shadow weakens → fails.
    expect(style.radius).toBeGreaterThanOrEqual(12);
    expect(style.shadow).not.toBe('none');
  });
});
