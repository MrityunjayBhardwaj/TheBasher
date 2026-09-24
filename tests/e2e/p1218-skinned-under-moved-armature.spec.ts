// #1218 — a skinned mesh under a moved armature draws where Blender draws it. glTF places a skinned
// mesh by its joints alone, so Blender re-skins the points into the armature's space and hangs the
// mesh under the armature (`io_scene_gltf2/blender/imp/{mesh,vnode}.py`). Before the fix, a mesh
// node BELOW its armature node drew offset twice and bent about the wrong points.
//
// Through the test door, as #1197's spec, until #1205 lifts the skin refusal. Oracle: Blender 5.1.1
// (ref/probes/blender-native-character/q1218_*.py), glTF space, frame 12 = 0.5 s at 24 fps.
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface SkinSeam {
  count: number;
  rest: (i: number) => [number, number, number];
  vertex: (i: number) => [number, number, number];
}
interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_gltf_skin?: () => SkinSeam | null;
}

async function importAndPose(
  page: Page,
  file: string,
): Promise<{ rest: number[][]; posed: number[][] }> {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag?.getState().state.outputs.scene),
  );
  await page.evaluate(async (f) => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const buffer = await fetch(`/assets/${f}`).then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.__buildSkinnedNativeGltfImportOpsForTests({
      buffer,
      assetRef: `user-imports/p1218/${f}`,
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
  }, file);
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_gltf_skin?.()));
  const read = () =>
    page.evaluate(() => {
      const s = (window as unknown as W).__basher_gltf_skin!()!;
      return {
        rest: Array.from({ length: s.count }, (_, i) => s.rest(i)),
        now: Array.from({ length: s.count }, (_, i) => s.vertex(i)),
      };
    });
  const setTime = async (t: number) => {
    await page.evaluate((s) => (window as unknown as W).__basher_time.getState().setTime(s), t);
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
  };
  await setTime(0);
  const { rest } = await read();
  await setTime(0.5);
  const { now } = await read();
  return { rest, posed: now };
}

/** Each Blender corner found by its rest position (after the import Group's own offset). */
function expectCorners(
  seen: { rest: number[][]; posed: number[][] },
  blender: { rest: number[]; f12: number[] }[],
): void {
  // The import Group places the model by its pivot; its offset is read off the first corner.
  const lowest = seen.rest.reduce((a, b) =>
    b[1] < a[1] || (b[1] === a[1] && b[0] < a[0]) ? b : a,
  );
  const lowestBlender = blender.reduce((a, b) =>
    b.rest[1] < a.rest[1] || (b.rest[1] === a.rest[1] && b.rest[0] < a.rest[0]) ? b : a,
  );
  const offset = lowest.map((c, k) => c - lowestBlender.rest[k]);
  for (const corner of blender) {
    const i = seen.rest.findIndex((r) =>
      r.every((c, k) => Math.abs(c - offset[k] - corner.rest[k]) < 1e-3),
    );
    expect(i, `a drawn vertex rests at Blender's ${corner.rest}`).toBeGreaterThanOrEqual(0);
    seen.posed[i].forEach((c, k) =>
      expect(c - offset[k], `corner ${corner.rest} at 0.5 s, axis ${k}`).toBeCloseTo(
        corner.f12[k],
        3,
      ),
    );
  }
}

test('#1218 — a skinned mesh BELOW its moved armature draws and bends where Blender does', async ({
  page,
}) => {
  const seen = await importAndPose(page, 'skinned-bar-child-mesh.glb');
  expectCorners(seen, [
    { rest: [2.8, 0, 0], f12: [2.8, 0, 0] },
    { rest: [2.8, 2, 0], f12: [2.177, 1.6022, 0] },
    { rest: [3.2, 2, 0], f12: [2.4719, 1.8724, 0] },
  ]);
});

test('#1218 control — a mesh node that IS its moved armature node still matches Blender', async ({
  page,
}) => {
  const seen = await importAndPose(page, 'skinned-bar-moved-armature.glb');
  expectCorners(seen, [
    { rest: [2.8586, -0.1414, 0], f12: [2.8586, -0.1414, 0] },
    { rest: [1.7272, 1.5556, 0], f12: [1.3026, 0.9505, 0] },
    { rest: [1.4444, 1.2728, 0], f12: [1.2851, 0.5509, 0] },
  ]);
});
