// #1613 — the depth pass draws a posed character where the other passes do.
//
// The depth pass replaces every material with its own shader. That shader placed a vertex from the
// mesh's stored position alone, which for a skinned mesh is the bind pose: the depth image showed a
// T-pose while the beauty and normal passes of the same frame showed the pose. So: bend the skinned
// bar a quarter turn at its upper bone, render depth and normal, and compare the two silhouettes.
// The normal pass (three's own material, which skins) is the reference.
//
// Falsifiable two ways: the bent silhouette is first shown to DIFFER from the rest one (the pose
// reaches the picture at all), and removing the skinning step from the depth shader reds the match.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';

type RenderPass = 'beauty' | 'depth' | 'normal';
interface Node {
  type: string;
  params: Record<string, unknown>;
  inputs: Record<string, unknown>;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } }; nodes: Record<string, Node> };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_render_png?: (
    pass?: RenderPass,
  ) => Promise<{ width: number; height: number; dataUrl: string } | null>;
  __basher_gltf_skin?: () => unknown;
}

/** Which pixels of a pass are the character: anything that is not the pass's empty black. A quarter
 *  of the pixels are read, which is plenty for a silhouette. */
async function silhouette(page: Page, pass: RenderPass): Promise<boolean[]> {
  return page.evaluate(async (p) => {
    const out = await (window as unknown as W).__basher_render_png!(p);
    if (!out) throw new Error(`no ${p} render`);
    const img = await createImageBitmap(await (await fetch(out.dataUrl)).blob());
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const mask: boolean[] = [];
    for (let y = 0; y < c.height; y += 2) {
      for (let x = 0; x < c.width; x += 2) {
        const i = (y * c.width + x) * 4;
        mask.push(d[i] + d[i + 1] + d[i + 2] > 24);
      }
    }
    return mask;
  }, pass);
}

/** Shared pixels over the union: 1 when two silhouettes are the same shape in the same place. */
function agreement(a: boolean[], b: boolean[]): { shared: number; union: number; ratio: number } {
  let shared = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) shared++;
    if (a[i] || b[i]) union++;
  }
  return { shared, union, ratio: union === 0 ? 0 : shared / union };
}

test('#1613 — a posed skinned mesh has the same silhouette in the depth pass as in the normal pass', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_dag?.getState().state.outputs.scene && w.__basher_render_png);
  });
  const armature = await page.evaluate(async () => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const d = await import('/src/app/animate/dispatchMutator.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1613/skinned-bar.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const nodes = w.__basher_dag.getState().state.nodes;
    const modifier = Object.entries(nodes).find(([, n]) => n.type === 'ArmatureModifier')![0];
    const id = (nodes[modifier].inputs.armature as { node: string }).node;
    // The starter cube stands where the bar does and would be most of both silhouettes.
    const r = d.dispatchMutatorFromUI(
      'mutator.setHidden',
      { targetSelectors: ['n_box'], hidden: true },
      'hide',
    );
    if (!r.ok) throw new Error(JSON.stringify(r));
    return id;
  });
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as W).__basher_gltf_skin?.())), {
      message: 'the bar is drawn skinned',
      timeout: 15_000,
    })
    .toBe(true);

  const pose = (z: number) =>
    page.evaluate(
      async ({ object, z }) => {
        const d = await import('/src/app/animate/dispatchMutator.ts');
        const r = d.dispatchMutatorFromUI(
          'mutator.animate.poseBone',
          { object, bone: 'Bone1', rotation: [0, 0, z] },
          'pose',
        );
        if (!r.ok) throw new Error(JSON.stringify(r));
        await new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
      },
      { object: armature, z },
    );

  // Straight, then bent: the pose must reach the picture, or the match below proves nothing.
  await pose(0);
  const straight = await silhouette(page, 'normal');
  await pose(90);
  const bent = await silhouette(page, 'normal');
  expect(bent.filter(Boolean).length, 'the bar is in frame').toBeGreaterThan(500);
  expect(agreement(straight, bent).ratio, 'bending the bar changes its silhouette').toBeLessThan(
    0.8,
  );

  const depth = await silhouette(page, 'depth');
  const match = agreement(depth, bent);
  console.log(
    `[p1613] depth vs normal silhouette: ${match.shared} shared of ${match.union} ` +
      `(${(match.ratio * 100).toFixed(1)}%); straight vs bent ` +
      `${(agreement(straight, bent).ratio * 100).toFixed(1)}%`,
  );
  // Edge pixels differ by anti-aliasing alone; a bind-pose depth pass is nowhere near this.
  expect(match.ratio).toBeGreaterThan(0.97);
});
