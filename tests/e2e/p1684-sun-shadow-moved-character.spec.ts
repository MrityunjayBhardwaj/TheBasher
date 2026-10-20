// #1684 — a character carried away by its bones still casts a shadow from the sun.
//
// The sun's shadow camera is fitted to the content's box every time the shadow map redraws. That
// box used to be read off each mesh's stored geometry, which for a skinned character is its bind
// pose at the import origin, so a character carried 20 m by its root bone stood outside the
// shadow camera and cast nothing. Here every vertex as drawn (`__basher_gltf_skin`) must lie
// inside the live sun's shadow camera after the carry. Falsifiable: fit the sun to the stored box
// again and the carried character is outside it.

import * as THREE from 'three';
import { test, expect } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<
          string,
          { type: string; params: Record<string, unknown>; inputs: Record<string, unknown> }
        >;
      };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_gltf_skin?: () => {
    count: number;
    vertex: (i: number) => [number, number, number];
  } | null;
  __basher_three: { getState: () => { scene: THREE.Scene | null } };
}

const CARRY = 20;

test('#1684 — carried 20 m by its root bone, the character is inside the sun’s shadow camera', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  const rig = await page.evaluate(async () => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1684/skinned-bar.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const nodes = w.__basher_dag.getState().state.nodes;
    const modifier = Object.entries(nodes).find(([, n]) => n.type === 'ArmatureModifier')![0];
    const armature = (nodes[modifier].inputs.armature as { node: string }).node;
    const skeleton = Object.values(nodes).find((n) => n.type === 'Skeleton')!;
    const bones = skeleton.params.bones as { name: string; parent?: number | null }[];
    const root = (bones.find((b) => b.parent === undefined || b.parent === null || b.parent < 0) ??
      bones[0])!.name;
    return { armature, root };
  });
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as W).__basher_gltf_skin?.())), {
      timeout: 15_000,
    })
    .toBe(true);

  await page.evaluate(
    async ({ object, bone, carry }) => {
      const d = await import('/src/app/animate/dispatchMutator.ts');
      const r = d.dispatchMutatorFromUI(
        'mutator.animate.poseBone',
        { object, bone, position: [carry, 0, 0] },
        'carry',
      );
      if (!r.ok) throw new Error(JSON.stringify(r));
    },
    { object: rig.armature, bone: rig.root, carry: CARRY },
  );

  /** How many of the drawn vertices lie outside the sun's shadow camera, out of how many. */
  const outsideSun = () =>
    page.evaluate(() => {
      const w = window as unknown as W;
      const skin = w.__basher_gltf_skin!()!;
      let sun: THREE.DirectionalLight | null = null;
      w.__basher_three.getState().scene!.traverse((o) => {
        if ((o as THREE.DirectionalLight).isDirectionalLight && (o as THREE.Light).castShadow) {
          sun = o as THREE.DirectionalLight;
        }
      });
      if (!sun) return { outside: -1, count: skin.count, minX: NaN };
      const cam = (sun as THREE.DirectionalLight).shadow.camera;
      // Into the shadow camera's space by its own matrix (column-major, an orthographic camera
      // has no perspective row).
      const e = cam.matrixWorldInverse.elements;
      let outside = 0;
      let minX = Infinity;
      for (let i = 0; i < skin.count; i++) {
        const [x, y, z] = skin.vertex(i);
        minX = Math.min(minX, x);
        const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
        const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
        const cz = e[2] * x + e[6] * y + e[10] * z + e[14];
        const inside =
          cx >= cam.left &&
          cx <= cam.right &&
          cy >= cam.bottom &&
          cy <= cam.top &&
          -cz >= cam.near &&
          -cz <= cam.far;
        if (!inside) outside++;
      }
      return { outside, count: skin.count, minX };
    });

  // The carry has reached the draw, and the shadow map has been redrawn for it.
  await expect
    .poll(async () => (await outsideSun()).minX, { timeout: 15_000 })
    .toBeGreaterThan(CARRY / 2);
  const seen = await outsideSun();
  expect(seen.count).toBeGreaterThan(0);
  expect(seen.outside, `${seen.outside} of ${seen.count} vertices outside the sun’s shadow`).toBe(
    0,
  );
});
