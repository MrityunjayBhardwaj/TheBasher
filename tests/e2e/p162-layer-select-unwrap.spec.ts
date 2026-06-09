// #162 — a viewport CLICK on a keyframed object must select the OBJECT, not the
// AnimationLayer wrapper, so the inspector keeps showing transform/material.
//
// Grounded: Blender (animation_data is a facet attached to the object; the object
// stays the selected entity) + Houdini (keyed parms live on the node; the node
// stays primary). The AnimationLayer is a Basher DAG implementation detail; it
// must never hijack viewport selection. The layer stays reachable via the
// SceneTree only.
//
// Drives the REAL R3F mesh click (canvas raycast → onClick), the honest
// observation of the selection boundary.
import { test, expect } from '@playwright/test';

interface W {
  __basher_dag?: { getState: () => { state: { nodes: Record<string, { type: string }> } } };
  __basher_time?: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_selection?: {
    getState: () => { select: (id: string) => void; selectedNodeId: string | null };
  };
  __basher_autokey?: { getState: () => { enabled: boolean; toggle: () => void } };
}

async function keyDefaultCube(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_dag && w.__basher_selection && w.__basher_time);
  });
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__basher_time!.getState().pause();
    w.__basher_time!.getState().setTime(0);
    w.__basher_selection!.getState().select('n_box');
    const ak = w.__basher_autokey!.getState();
    if (ak.enabled) ak.toggle();
  });
  await expect(page.getByTestId('inspector')).toBeVisible();
  await page.getByTestId('inspector-section-toggle-transform').click();
  await page.getByTestId('inspector-diamond-n_box-position').click();
  await page.waitForTimeout(100);
  // confirm the wrap happened
  const layerId = await page.evaluate(() => {
    const w = window as unknown as W;
    return (
      Object.entries(w.__basher_dag!.getState().state.nodes).find(
        ([, n]) => n.type === 'AnimationLayer',
      )?.[0] ?? null
    );
  });
  expect(layerId, 'first key wraps n_box in an AnimationLayer').not.toBeNull();
  return layerId!;
}

test.describe('#162 viewport click never selects the AnimationLayer wrapper', () => {
  test('click the keyframed cube → selects n_box (object), inspector keeps transform+material', async ({
    page,
  }) => {
    const layerId = await keyDefaultCube(page);

    // Clear selection, then REAL-click the cube at screen center.
    await page.evaluate(() => (window as unknown as W).__basher_selection!.getState().select(''));
    await page.waitForTimeout(80);
    const canvas = page.locator('canvas').first();
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(150);

    const sel = await page.evaluate(
      () => (window as unknown as W).__basher_selection!.getState().selectedNodeId,
    );
    // THE OBJECT, not the layer.
    expect(sel, `click selected ${sel}; expected the object n_box, not the layer ${layerId}`).toBe(
      'n_box',
    );

    // Inspector shows the object's sections (the #162 symptom = these vanish).
    const present: string[] = [];
    for (const s of ['transform', 'material', 'animate']) {
      if ((await page.getByTestId(`inspector-section-${s}`).count()) > 0) present.push(s);
    }
    expect(present).toContain('transform');
    expect(present).toContain('material');
  });
});
