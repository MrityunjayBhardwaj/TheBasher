// #645 P6 — THE DIRECTOR RE-POINTS A SLOT FROM THE INSPECTOR, AND THE SCREEN FOLLOWS.
//
// ── WHY THIS SPEC EXISTS, GIVEN P5 ALREADY OBSERVED THE PIXELS ───────────────────────
//
// `p645-object-slot-override-draws.spec.ts` proved the MECHANISM reaches the screen: write
// `slotOverrides.0` and one object of two diverges. It writes that param by dispatch, the
// way the agent road does. So it says nothing about whether a director can get there.
//
// This spec drives the panel. Every act below is a click or a keystroke on a real control,
// and the assertion is on pixels — because the phase before this one shipped a derivation
// that was called from the right place, with the right arguments, and never reached the
// output. A control that writes the param proves nothing about the screen; only the screen
// does.
//
// ── THE LOAD-BEARING CLAUSE IS A RELATION, FOR THE SAME REASON P5's IS ───────────────
//
// "It drew green after I clicked" is equally satisfied by a panel that wrote the SHARED
// DATA — which is the whole defect, since the mechanism exists so the shared data is never
// written. So the discriminating clause is that the OTHER object still wears the source
// material afterwards:
//
//   grey BEFORE  — both objects wear the data's material
//   green AFTER  — the overridden one moved
//   grey AFTER   — strictly less than before, and still above the floor (its twin survives)
//
// A panel that edited the data node drives grey to the floor and passes every "did it draw
// green?" check. The floor under grey AFTER is what refuses it.
//
// ── AND THE ROW NOTHING HAS EVER OBSERVED: HANDING THE SLOT BACK ────────────────────
//
// Removing the last override leaves `{}` in params, which `ObjectNode.evaluate` normalises
// to an absent field. That normalisation has unit rows; what it has never had is a pixel.
// Clause (d) clicks Revert and watches the green leave and the grey return — the round trip
// closing where it started, which is the only form of the claim that cannot be satisfied by
// a write that half-lands.
//
// REF: src/app/objectSlotAuthoring.ts (the ops these controls dispatch);
//      src/app/materialAssignment.ts (`objectSlotsOf` — the ONE derivation);
//      tests/e2e/p645-object-slot-override-draws.spec.ts (the agent road's pixels);
//      src/nodes/objectSlotTable.gate.test.ts (the fuse chain). Issues #645, #638.

import { expect, test, type Page } from './_fixtures';
import type { Op } from '../../src/core/dag/types';

interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: Record<string, { node: string }>; nodes: Record<string, unknown> };
      dispatchAtomic: (ops: Op[], label: string, desc: string) => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_three: { getState: () => { scene: unknown } };
  __basher_render_png?: () => Promise<{ width: number; height: number; dataUrl: string } | null>;
}

/** The seed scene's data node, and the SECOND object this spec puts beside it. The seed's own
 *  object is the CONTROL — what matters about it is only that its pixels survive. */
const DATA = 'n_box_data';
const RIGHT = 'n_box_right';

/** Unmistakable against the seed cube's standard grey, which carries no green. */
const GREEN = '#00ff00';

/** A floor every "greater than" clause sits on, so nothing here is satisfied by an empty
 *  frame. Small enough that framing is not brittle, large enough to outrun antialiasing. */
const DRAWS_AT_ALL = 200;

async function dispatch(page: Page, ops: Op[], label: string): Promise<void> {
  await page.evaluate(
    ([o, l]) => {
      (window as unknown as W).__basher_dag.getState().dispatchAtomic(o, l, l);
    },
    [ops, label] as [Op[], string],
  );
}

/** A SECOND Object reading the SAME data node — the premise the whole mechanism is about. */
async function addSecondObject(page: Page): Promise<void> {
  const sceneId = await page.evaluate(
    () => (window as unknown as W).__basher_dag.getState().state.outputs.scene.node,
  );
  await dispatch(
    page,
    [
      {
        type: 'addNode',
        nodeId: RIGHT,
        nodeType: 'Object',
        params: { position: [2.2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      { type: 'connect', from: { node: DATA, socket: 'out' }, to: { node: RIGHT, socket: 'data' } },
      {
        type: 'connect',
        from: { node: RIGHT, socket: 'out' },
        to: { node: sceneId, socket: 'children' },
      },
    ] as Op[],
    'second object',
  );
}

/** Count the override's green and the data material's grey in a REAL render. */
async function pixels(
  page: Page,
): Promise<{ green: number; grey: number; greenX: number; greyX: number } | null> {
  return page.evaluate(async () => {
    const out = await (window as unknown as W).__basher_render_png!();
    if (!out) return null;
    const img = new Image();
    await new Promise((r) => {
      img.onload = r;
      img.src = out.dataUrl;
    });
    const cv = document.createElement('canvas');
    cv.width = out.width;
    cv.height = out.height;
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, out.width, out.height).data;
    let green = 0;
    let grey = 0;
    // 🔴 AND WHERE EACH POPULATION SITS. A count alone cannot tell "the object I overrode
    // turned green" from "the OTHER one did" — both give the same green and the same grey.
    // That is not hypothetical: it is what a perturbation of this very spec produced, with
    // the two numbers merely swapped, while every count-based clause stayed green.
    let greenSumX = 0;
    let greySumX = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      const x = (i / 4) % out.width;
      if (g > r + 30 && g > b + 30) {
        green++;
        greenSumX += x;
      } else if (
        r >= 48 &&
        Math.abs(r - g) <= 12 &&
        Math.abs(g - b) <= 12 &&
        Math.abs(r - b) <= 12
      ) {
        grey++;
        greySumX += x;
      }
    }
    return {
      green,
      grey,
      greenX: green > 0 ? greenSumX / green : 0,
      greyX: grey > 0 ? greySumX / grey : 0,
    };
  });
}

/** Select a node the way the scene tree does, so the inspector draws it. */
async function select(page: Page, id: string): Promise<void> {
  await page.evaluate((n) => {
    (window as unknown as W).__basher_selection.getState().select(n);
  }, id);
}

/** Open the Material Slots card — non-primary sections start collapsed (§5.8). */
async function openSlotsSection(page: Page): Promise<void> {
  const section = page.getByTestId('inspector-section-slots');
  await expect(section).toBeVisible({ timeout: 10_000 });
  if ((await section.getAttribute('data-collapsed')) === 'true') {
    await page.getByTestId('inspector-section-toggle-slots').click();
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(
      w.__basher_dag &&
      w.__basher_three &&
      w.__basher_selection &&
      w.__basher_three.getState().scene &&
      w.__basher_dag.getState().state.outputs.scene,
    );
  });
});

test('the inspector re-points ONE object’s slot, and hands it back, on screen', async ({
  page,
}) => {
  await addSecondObject(page);
  await select(page, RIGHT);
  await openSlotsSection(page);

  // (a) THE CARD IS THERE, AND IT SAYS WHERE THE MATERIAL COMES FROM. One row (the data
  // declares one slot), reading from the data — the reference's `link == DATA`.
  await expect(page.getByTestId(`inspector-object-slots-${RIGHT}`)).toBeVisible();
  await expect(page.getByTestId(`inspector-slot-link-${RIGHT}-0`)).toHaveText('Data');
  await expect(page.getByTestId(`inspector-slot-override-${RIGHT}-0`)).toBeVisible();

  // (b) BEFORE. Two objects, one data node, no override — both wear the data's material.
  await expect
    .poll(async () => (await pixels(page))?.grey ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(DRAWS_AT_ALL);
  const before = await pixels(page);
  expect(before).not.toBeNull();

  // (c) TAKE THE SLOT OVER, THROUGH THE PANEL. The click alone must move NO pixel — the act
  // is "this slot is mine", and a seed that changed the colour would make the two
  // indistinguishable on screen. Then the colour edit is what moves it.
  await page.getByTestId(`inspector-slot-override-${RIGHT}-0`).click();
  await expect(page.getByTestId(`inspector-slot-link-${RIGHT}-0`)).toHaveText('Object');
  const seeded = await pixels(page);
  expect(seeded).not.toBeNull();
  expect(seeded!.green, 'taking a slot over is not a colour change').toBeLessThan(DRAWS_AT_ALL);

  const hex = page.getByTestId(`inspector-slot-colorhex-${RIGHT}-0`);
  await hex.fill(GREEN);
  await hex.press('Enter');

  await expect
    .poll(async () => (await pixels(page))?.green ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(DRAWS_AT_ALL);
  const after = await pixels(page);
  expect(after).not.toBeNull();

  // 🔴 THE CLAUSE THAT DISCRIMINATES, AND IT IS AN IDENTITY, NOT A COUNT.
  //
  // The counts alone do not earn their comments. Measured on a perturbation of this spec
  // that turned the WRONG cube green: green 132869 / grey 268786, against 268964 / 132746
  // for the right one — the same two numbers, swapped. "Grey fell" and "grey stayed above a
  // floor" are both true either way, so neither can say which object diverged.
  //
  // What says it is WHERE the green is. `RIGHT` sits at x = +2.2 and its twin at the origin,
  // so the overridden object's pixels must be to the RIGHT of the pixels still wearing the
  // data's material. A panel that wrote the shared data, or that applied the override to the
  // wrong object, puts them the other way round and reds here.
  expect(after!.grey, 'the overridden object left the grey population').toBeLessThan(before!.grey);
  expect(after!.grey, 'its twin still wears the data’s material').toBeGreaterThan(DRAWS_AT_ALL);
  expect(
    after!.greenX,
    'the object that diverged is the one the panel overrode (the RIGHT one)',
  ).toBeGreaterThan(after!.greyX);

  // (d) HAND IT BACK. The round trip: the green leaves, and the grey returns to where it
  // started. Nothing has ever observed the removal road at the screen — the unit rows stop
  // at `{}` in params.
  await page.getByTestId(`inspector-slot-revert-${RIGHT}-0`).click();
  await expect(page.getByTestId(`inspector-slot-link-${RIGHT}-0`)).toHaveText('Data');
  await expect
    .poll(async () => (await pixels(page))?.grey ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(after!.grey);
  const reverted = await pixels(page);
  expect(reverted).not.toBeNull();
  expect(reverted!.green, 'the override’s colour is gone from the frame').toBeLessThan(
    DRAWS_AT_ALL,
  );
  // Back where it started, within the tolerance a re-render's antialiasing can move it.
  expect(Math.abs(reverted!.grey - before!.grey)).toBeLessThan(before!.grey * 0.05);
});
