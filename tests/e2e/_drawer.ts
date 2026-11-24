// #1703 — the one road a spec takes into a bottom-drawer tab: open the drawer if it is closed,
// then pick the tab. The drawer's toggle flips, so clicking it blindly would close an open drawer.
import { expect, type Page } from '@playwright/test';

export type DrawerTab =
  | 'shots'
  | 'dopesheet'
  | 'nla'
  | 'curve'
  | 'nodes'
  | 'library'
  | 'controllers';

export async function openDrawerTab(page: Page, tab: DrawerTab): Promise<void> {
  const drawer = page.getByTestId('timeline-drawer');
  if ((await drawer.getAttribute('data-open')) !== 'true') {
    await page.getByTestId('timeline-drawer-toggle').click();
    await expect(drawer).toHaveAttribute('data-open', 'true');
  }
  const button = page.getByTestId(`timeline-tab-${tab}`);
  await button.click();
  await expect(button).toHaveAttribute('aria-selected', 'true');
}
