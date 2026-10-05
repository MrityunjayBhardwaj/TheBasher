// #1513 — an armature group is offered only the Apply masks it takes. Apply on a group holding a
// skeleton carries the scale into the rig (#1511); Location and Rotation always refused there, and
// All refused once the group was moved or turned, yet the inspector and Object ▸ Apply offered all
// four. Both surfaces now ask `canApplyTransform(…, mask)`, the answer the refusal is made from.
//
// Through the product's native reader (`buildNativeGltfImportOps`), dispatched directly, as p1218.
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface W {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<
          string,
          { type: string; params?: Record<string, unknown>; inputs?: Record<string, unknown> }
        >;
      };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_selection: { getState: () => { select: (id: string) => void } };
}

/** Import the two-clip skinned bar, scale its armature group by 2, select it; its id. */
async function stageArmature(page: Page, extra: Record<string, unknown> = {}): Promise<string> {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag?.getState().state.outputs.scene),
  );
  return page.evaluate(async (params) => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const { armatureSkeletonObjectsOf } =
      await import('/src/app/animate/dispatchApplyTransform.ts');
    const buffer = await fetch('/assets/skinned-bar-two-clips.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1513/skinned-bar-two-clips.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const state = w.__basher_dag.getState().state;
    const group = Object.keys(state.nodes).find(
      (id) =>
        state.nodes[id].type === 'Group' &&
        armatureSkeletonObjectsOf(state as never, id).length > 0,
    );
    if (!group) throw new Error('the import stood no armature group');
    w.__basher_dag.getState().dispatchAtomic(
      Object.entries({ scale: [2, 2, 2], ...params }).map(([paramPath, value]) => ({
        type: 'setParam',
        nodeId: group,
        paramPath,
        value,
      })),
      'user',
      'stage armature',
    );
    w.__basher_selection.getState().select(group);
    return group;
  }, extra);
}

const groupScale = (page: Page, id: string) =>
  page.evaluate(
    (g) => (window as unknown as W).__basher_dag.getState().state.nodes[g].params?.scale,
    id,
  );

test.describe('#1513 — an armature group is offered only the Apply masks it takes', () => {
  test('inspector: Location and Rotation are not offered; Scale is, and applies', async ({
    page,
  }) => {
    const group = await stageArmature(page);
    await expect(page.getByTestId('npanel-apply-transform')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('npanel-apply-scale')).toBeEnabled();
    await expect(page.getByTestId('npanel-apply-all')).toBeEnabled();
    await expect(page.getByTestId('npanel-apply-location')).toBeDisabled();
    await expect(page.getByTestId('npanel-apply-rotation')).toBeDisabled();

    await page.getByTestId('npanel-apply-scale').click();
    await expect.poll(() => groupScale(page, group)).toEqual([1, 1, 1]);
    await expect(page.getByTestId('toast-warn')).toHaveCount(0);
  });

  test('a turned armature group is not offered All either', async ({ page }) => {
    await stageArmature(page, { rotation: [0, 30, 0] });
    await expect(page.getByTestId('npanel-apply-transform')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('npanel-apply-all')).toBeDisabled();
    await expect(page.getByTestId('npanel-apply-scale')).toBeEnabled();
  });

  test('Object ▸ Apply offers the same masks as the inspector', async ({ page }) => {
    await stageArmature(page);
    await page.getByTestId('menu-object-button').click();
    await page.getByTestId('menu-object-apply').hover();
    await expect(page.getByTestId('menu-object-apply-scale')).toBeEnabled();
    await expect(page.getByTestId('menu-object-apply-all')).toBeEnabled();
    await expect(page.getByTestId('menu-object-apply-location')).toBeDisabled();
    await expect(page.getByTestId('menu-object-apply-rotation')).toBeDisabled();
  });
});
