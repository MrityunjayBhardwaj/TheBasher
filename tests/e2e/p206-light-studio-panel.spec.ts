// #206 — the 2D Light-Studio panel (epic #201). Observes the read-only surface on
// the LIVE app (Lokayata): a studio light (an AreaLight aimed by a Track-To) shows
// as a puck on the third timeline tab, and the puck lands EXACTLY where the pure
// placement resolver says it should.
//
// BOUNDARY-PAIR (panel == resolver, V37): the puck's measured fractional position
// within the canvas rect equals `panelXYToFraction(studioLightPanelXY(pos, target))`
// — the SAME pure functions the component renders through, observed from the
// opposite (rendered-DOM) side. Import the pure cores directly (no three/DOM deps).
//
// FALSIFICATION (guards a vacuous pass): a free AreaLight (NO Track-To) is NOT on
// the rig → no puck for it; the empty panel shows the "add a rig light" hint.
//
// REF: src/timeline/LightStudioPanel.tsx; src/app/resolveStudioLightTransform.ts;
//      src/timeline/studioPanelGeometry.ts; vyapti V60/V37; hetvabhasa H95.

import { expect, test } from './_fixtures';
import { studioLightPanelXY } from '../../src/app/resolveStudioLightTransform';
import { panelXYToFraction } from '../../src/timeline/studioPanelGeometry';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface PanelWindow {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
}

/** Add an AreaLight at `pos` wired into scene.lights; when `aimPoint` is given,
 *  add a Track-To aiming it there (making it a RIG light the panel draws). */
async function addAreaLight(
  page: import('@playwright/test').Page,
  id: string,
  pos: [number, number, number],
  aimPoint: [number, number, number] | null,
): Promise<void> {
  await page.evaluate(
    ({ id, pos, aimPoint }) => {
      const w = window as unknown as PanelWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      const ops: Op[] = [
        {
          type: 'addNode',
          nodeId: id,
          nodeType: 'AreaLight',
          params: { intensity: 5, position: pos, color: '#ffffff', width: 2, height: 2, lookAt: aimPoint ?? [0, 0, 0] },
        },
        { type: 'connect', from: { node: id, socket: 'out' }, to: { node: sceneId, socket: 'lights' } },
      ];
      if (aimPoint) {
        ops.push({
          type: 'addNode',
          nodeId: `${id}_tt`,
          nodeType: 'TrackTo',
          params: { target: id, aimNode: '', aimPoint, up: [0, 1, 0], mute: false },
        });
      }
      dag.dispatchAtomic(ops, 'e2e', 'add area light');
    },
    { id, pos, aimPoint },
  );
}

/** Open the timeline drawer (if collapsed) and switch to the Light Studio tab. */
async function openLightStudio(page: import('@playwright/test').Page): Promise<void> {
  const toggle = page.getByTestId('timeline-drawer-toggle');
  const drawer = page.getByTestId('timeline-drawer');
  if ((await drawer.getAttribute('data-open')) !== 'true') await toggle.click();
  await page.getByTestId('timeline-tab-lightStudio').click();
  await expect(page.getByTestId('light-studio-panel')).toBeVisible();
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
    const w = window as unknown as PanelWindow;
    return Boolean(w.__basher_dag && w.__basher_dag.getState().state.outputs.scene);
  });
});

test('#206 — a rig light shows as a puck at the resolver-projected canvas spot (panel == resolver)', async ({
  page,
}) => {
  const pos: [number, number, number] = [3, 4, 3];
  const target: [number, number, number] = [0, 0, 0];
  await addAreaLight(page, 'rig_light_e2e', pos, target);
  await openLightStudio(page);

  const puck = page.getByTestId('light-studio-puck-rig_light_e2e');
  await expect(puck).toBeVisible();

  // BOUNDARY-PAIR: measured puck centre fraction == resolver-predicted fraction.
  const { panelXY } = studioLightPanelXY(pos, target);
  const expected = panelXYToFraction(panelXY);

  const canvasBox = await page.getByTestId('light-studio-canvas').boundingBox();
  const puckBox = await puck.boundingBox();
  expect(canvasBox).not.toBeNull();
  expect(puckBox).not.toBeNull();
  const measuredLeft = (puckBox!.x + puckBox!.width / 2 - canvasBox!.x) / canvasBox!.width;
  const measuredTop = (puckBox!.y + puckBox!.height / 2 - canvasBox!.y) / canvasBox!.height;

  // Within 2% of the canvas — sub-pixel rounding + the puck's border box.
  expect(Math.abs(measuredLeft - expected.leftFrac)).toBeLessThan(0.02);
  expect(Math.abs(measuredTop - expected.topFrac)).toBeLessThan(0.02);
});

test('#206 — a free (un-aimed) area light is NOT on the rig; the empty panel shows the hint', async ({
  page,
}) => {
  // A free area light (no Track-To) must not appear as a puck.
  await addAreaLight(page, 'free_light_e2e', [2, 0, 0], null);
  await openLightStudio(page);

  await expect(page.getByTestId('light-studio-puck-free_light_e2e')).toHaveCount(0);
  await expect(page.getByTestId('light-studio-empty')).toBeVisible();
});
