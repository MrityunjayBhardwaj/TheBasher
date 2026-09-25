// #1127 — an inspector field that commits on Enter and on blur writes one undo entry per edit.
//
// Both of the inspector's buffered typed fields — the text field (here a clip's name) and the
// hex box beside a colour swatch (here the default light's colour) — commit on Enter AND when
// they lose focus. Measured on the parent with these gestures: a click in and out with nothing
// typed wrote one undo entry, and Enter followed by a blur wrote two identical ones, so the
// director's first Cmd+Z did nothing they could see.
//
// The undo stack's depth is the observation for "an entry was written"; the director-visible
// consequence is asserted too — ONE Cmd+Z after Enter-then-blur puts the old value back.

import { test, expect, type Page, type Locator } from './_fixtures';

interface Win {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      undoStack: unknown[];
    };
  };
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_ingestBvhFile?: (bytes: Uint8Array, name: string) => Promise<string>;
}

const depth = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__basher_dag.getState().undoStack.length);
const blur = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const select = (page: Page, id: string) =>
  page.evaluate((i) => (window as unknown as Win).__basher_selection.getState().select(i), id);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Win;
    return Boolean(w.__basher_dag && w.__basher_selection && w.__basher_ingestBvhFile);
  });
});

/** The gestures, with `read` observing the value the field writes. */
async function oneEntryPerEdit(
  page: Page,
  field: Locator,
  read: () => Promise<unknown>,
  edit: string,
): Promise<void> {
  await expect(field).toBeVisible({ timeout: 5_000 });
  const before = await read();
  const start = await depth(page);

  // 1. Click in, click out, nothing typed → nothing written.
  await field.click();
  await blur(page);
  await expect
    .poll(() => depth(page), { message: 'a click in and out wrote an entry' })
    .toBe(start);
  // Step 2 is this step's positive control: the field does commit when the value moves.

  // 2. Type and press Enter → exactly one entry, and the value moved.
  await field.fill(edit);
  await field.press('Enter');
  await expect.poll(() => depth(page)).toBe(start + 1);
  expect(await read()).toBe(edit);

  // 3. Then focus leaves → still one entry.
  await blur(page);
  await page.waitForTimeout(150);
  expect(await depth(page), 'the blur after Enter wrote a second entry').toBe(start + 1);

  // 4. One Cmd+Z undoes the edit.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(read).toBe(before);
  expect(await depth(page)).toBe(start);
}

test('the inspector text field writes one undo entry per edit, and none for no edit', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch('/fixtures/anim/soma-walk.bvh')).arrayBuffer());
    await (window as unknown as Win).__basher_ingestBvhFile!(bytes, 'soma-walk'); // appends .bvh
  });
  const clip = await page.evaluate(
    () =>
      Object.entries((window as unknown as Win).__basher_dag.getState().state.nodes).find(
        ([, n]) => n.type === 'AnimationClip',
      )?.[0],
  );
  expect(clip, 'the import made no clip — every step below would be vacuous').toBeTruthy();
  await select(page, clip!);
  await oneEntryPerEdit(
    page,
    page.getByTestId(`inspector-text-${clip}-name`),
    () =>
      page.evaluate(
        (id) => (window as unknown as Win).__basher_dag.getState().state.nodes[id].params.name,
        clip!,
      ),
    'jog',
  );
});

test('the colour hex box writes one undo entry per edit, and none for no edit', async ({
  page,
}) => {
  const id = 'n_light_data';
  const exists = await page.evaluate(
    (i) => Boolean((window as unknown as Win).__basher_dag.getState().state.nodes[i]),
    id,
  );
  expect(exists, `the default scene has no ${id}`).toBe(true);
  await select(page, id);
  await oneEntryPerEdit(
    page,
    page.getByTestId(`inspector-colorhex-${id}-color`),
    () =>
      page.evaluate(
        (i) => (window as unknown as Win).__basher_dag.getState().state.nodes[i].params.color,
        id,
      ),
    '#123456',
  );
});
