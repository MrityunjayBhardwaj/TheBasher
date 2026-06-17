// #188 (v0.7 Phase 3, authoring) — clicking the inspector keyframe diamond on a
// glTF material lobe field creates a FREE-FLOATING KeyframeChannel targeting the
// GltfChild dagId directly — NO AnimationLayer (the glTF direct-channel road, V57;
// the H104 fix: a custom inspector control — GltfMaterialEditor — must re-wire the
// diamond + autoKey spine itself, the #190 CameraLensControls template).
//
// THE PROOF (falsifiable): import cube-draco → select its GltfChild → expand the
// MATERIAL section → click the metalness diamond. A KeyframeChannelNumber appears
// with target=childId, paramPath='materials.0.base.metalness', and ZERO
// AnimationLayer nodes were created (a GltfChild is not a scene producer — wrapping
// it in a layer would be the H104-adjacent break). The diamond then reads 'on-key'.

import { test, expect } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { id: string; type: string; params: Record<string, unknown> }>;
      };
    };
  };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

type Page = import('@playwright/test').Page;

function cubeChildId(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as W;
    const c = Object.values(w.__basher_dag.getState().state.nodes).find(
      (n) => n.type === 'GltfChild' && n.params.childName === 'cube',
    );
    return c?.id ?? null;
  });
}

function nodesOfType(page: Page, type: string) {
  return page.evaluate((t) => {
    const w = window as unknown as W;
    return Object.values(w.__basher_dag.getState().state.nodes)
      .filter((n) => n.type === t)
      .map((n) => ({ id: n.id, params: n.params }));
  }, type);
}

test.describe('#188 — glTF material keyframe authoring (H104, free-floating channel)', () => {
  test('clicking the metalness diamond creates a free-floating channel — no AnimationLayer', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(
      () =>
        typeof (window as unknown as W).__basher_ingestGltfFolder === 'function' &&
        !!(window as unknown as W).__basher_dag &&
        !!(window as unknown as W).__basher_selection,
    );
    await page.evaluate(async () => {
      const w = window as unknown as W;
      const bytes = new Uint8Array(
        await fetch('/assets/cube-draco.glb').then((r) => r.arrayBuffer()),
      );
      await w.__basher_ingestGltfFolder([{ relativePath: 'cube-draco.glb', bytes }], 'matauthor');
    });
    await expect.poll(() => cubeChildId(page)).not.toBeNull();
    const childId = await cubeChildId(page);

    await page.evaluate((id) => {
      (window as unknown as W).__basher_selection.getState().select(id);
    }, childId);
    await page.getByTestId('inspector-section-toggle-material').click();

    // The diamond exists on the metalness field (H104 — a custom control that wired
    // the affordance). Pre-click it is hollow (un-animated).
    const diamond = page.getByTestId(`inspector-diamond-${childId}-materials.0.base.metalness`);
    await expect(diamond).toBeVisible();
    await expect(diamond).toHaveAttribute('data-anim-state', 'none');

    await diamond.click();

    // A free-floating KeyframeChannelNumber now targets the child at the lobe path.
    await expect
      .poll(async () => {
        const chans = await nodesOfType(page, 'KeyframeChannelNumber');
        return chans.find(
          (c) => c.params.target === childId && c.params.paramPath === 'materials.0.base.metalness',
        )
          ? 'found'
          : 'missing';
      })
      .toBe('found');

    // ZERO AnimationLayer nodes — a GltfChild is not a scene producer, so the
    // first-key must NOT wrap it in a layer (the direct-channel road, V57).
    expect((await nodesOfType(page, 'AnimationLayer')).length).toBe(0);

    // The diamond now reads on-key (a keyframe at the current playhead).
    await expect.poll(() => diamond.getAttribute('data-anim-state')).toBe('on-key');
  });
});
