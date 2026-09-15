// #1064 — a picker over live options, observed in the running app.
//
// What these read is the DOM a director sees: the select's `value`, which option is selected,
// and that option's text. A native <select> whose stored value matches no option shows its
// FIRST option while the JSX reads `value={stored}`, so only the DOM can show whether the fix
// holds. Measured before the change on both pickers here: the Track-To aim picker read
// "— none —" for a deleted target.

import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState(): {
      state: {
        nodes: Record<
          string,
          { type: string; params: Record<string, unknown>; inputs: Record<string, unknown> }
        >;
      };
      dispatch: (op: unknown, src: string, d: string) => void;
    };
  };
  __basher_selection: { getState(): { select: (id: string) => void } };
}

async function boot(page: Page) {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_selection));
}

/** What a native <select> shows, read off the element. */
function shown(page: Page, testid: string) {
  return page.getByTestId(testid).evaluate((el) => {
    const s = el as HTMLSelectElement;
    return {
      value: s.value,
      selectedIndex: s.selectedIndex,
      selectedText: s.selectedIndex >= 0 ? s.options[s.selectedIndex].text : null,
      stale: s.dataset.stale ?? null,
      options: [...s.options].map((o) => ({ value: o.value, disabled: o.disabled })),
    };
  });
}

function setParam(page: Page, nodeId: string, path: string, value: unknown) {
  return page.evaluate(
    ([id, p, v]) =>
      (window as unknown as W).__basher_dag
        .getState()
        .dispatch({ type: 'setParam', nodeId: id, paramPath: p, value: v }, 'user', 'e2e'),
    [nodeId, path, value] as [string, string, unknown],
  );
}

function paramOf(page: Page, nodeId: string, path: string) {
  return page.evaluate(
    ([id, p]) => (window as unknown as W).__basher_dag.getState().state.nodes[id]?.params[p],
    [nodeId, path] as [string, string],
  );
}

test('the profile picker offers the wired rigs, switches the live one, and shows a renamed one as not found', async ({
  page,
}) => {
  await boot(page);

  // Two profiles, through the product's own "+ Profile".
  const drawer = page.getByTestId('timeline-drawer');
  if ((await drawer.getAttribute('data-open')) !== 'true') {
    await page.getByTestId('timeline-drawer-toggle').click();
  }
  await page.getByTestId('timeline-tab-lightStudio').click();
  await expect(page.getByTestId('light-studio-panel')).toBeVisible();
  await page.getByTestId('light-studio-profile-add').click();
  await page.getByTestId('light-studio-profile-add').click();

  const wired = await page.evaluate(() => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    const [selId, sel] = Object.entries(nodes).find(([, n]) => n.type === 'LightProfileSelect')!;
    const refs = sel.inputs.rigs as { node: string }[];
    return {
      selId,
      rigs: refs.map((r) => ({ id: r.node, name: nodes[r.node].params.name as string })),
    };
  });
  expect(wired.rigs).toHaveLength(2);
  const [first, second] = wired.rigs;

  await page.evaluate(
    (id) => (window as unknown as W).__basher_selection.getState().select(id),
    wired.selId,
  );
  const testid = `inspector-options-${wired.selId}-selectedProfile`;
  const picker = page.getByTestId(testid);
  await expect(picker).toBeVisible();

  // Offers none plus exactly the wired rigs, and shows the live one ("+ Profile" activates the
  // newest).
  const opened = await shown(page, testid);
  expect(opened).toMatchObject({
    value: second.name,
    selectedText: second.name,
    stale: null,
    options: [
      { value: '', disabled: false },
      { value: first.name, disabled: false },
      { value: second.name, disabled: false },
    ],
  });

  // Choosing in the real <select> switches the live profile — read back through Light Studio's
  // own switcher, a different reader of the same param.
  await picker.selectOption(first.name);
  await expect.poll(() => paramOf(page, wired.selId, 'selectedProfile')).toBe(first.name);
  await expect
    .poll(() => shown(page, 'light-studio-profile-select').then((s) => s.value))
    .toBe(first.name);

  // Rename the live rig. The stored name now selects nothing, and the picker must say so —
  // not show "— no profile —" or the other rig in its place.
  await setParam(page, first.id, 'name', 'Renamed');
  await expect
    .poll(() => shown(page, testid))
    .toMatchObject({
      value: first.name,
      selectedIndex: 0,
      selectedText: `${first.name} — not found`,
      stale: 'true',
    });
  // The renamed rig is offered under its new name, so the director can re-pick it.
  expect((await shown(page, testid)).options.map((o) => o.value)).toContain('Renamed');
});

test('the node-reference picker shows a dangling target as not found, and an invalid one as invalid', async ({
  page,
}) => {
  await boot(page);
  await page.evaluate(() => (window as unknown as W).__basher_selection.getState().select('n_box'));
  await page.getByTestId('inspector-section-toggle-constraint').click();
  const stack = page.getByTestId('constraint-stack');
  await expect(stack).toBeVisible();
  await page.getByTestId('constraint-add-TrackTo').click();
  const rows = stack.locator('[data-testid^="constraint-row-"]');
  await expect(rows).toHaveCount(1);
  const ttId = (await rows.first().getAttribute('data-testid'))!.replace('constraint-row-', '');
  await rows.first().locator('button').first().click();
  const testid = `inspector-noderef-${ttId}-aimNode`;
  await expect(page.getByTestId(testid)).toBeVisible();

  // A target that exists nowhere — the case that used to read "— none —".
  await setParam(page, ttId, 'aimNode', 'ghost_node');
  await expect
    .poll(() => shown(page, testid))
    .toMatchObject({
      value: 'ghost_node',
      selectedIndex: 0,
      selectedText: 'ghost_node — not found',
      stale: 'true',
    });

  // A node that exists but is not a candidate (the constraint itself) is not "not found".
  await setParam(page, ttId, 'aimNode', ttId);
  await expect
    .poll(() => shown(page, testid))
    .toMatchObject({ value: ttId, selectedIndex: 0, stale: 'true' });
  expect((await shown(page, testid)).selectedText).toMatch(/ — not a valid target$/);

  // Choosing none through the real <select> recovers: the param clears and nothing is stale.
  await page.getByTestId(testid).selectOption('');
  await expect.poll(() => paramOf(page, ttId, 'aimNode')).toBe('');
  await expect
    .poll(() => shown(page, testid))
    .toMatchObject({ value: '', selectedText: '— none —', stale: null });
});
