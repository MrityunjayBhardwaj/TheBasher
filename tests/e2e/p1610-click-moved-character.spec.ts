// #1610 — a character that has moved away from where it was imported is still under the pointer.
//
// three tests a click against a mesh's bounds before any triangle, and measures those bounds only
// once. So: click the character where it stands (the bounds are measured there), carry it 3 units
// away by its root bone, and click it again where it is now drawn. Before the fix the second click
// passed through the body and cleared the selection.
//
// Both ways a skinned mesh is drawn are covered: skinned on the GPU (`skinned-bar.glb`), and drawn
// from the deform when a point has more than four bones (`skinned-many-influences.glb`, #1430).

import type { Page } from '@playwright/test';
import * as THREE from 'three';
import { test, expect, settleViewFit } from './_fixtures';

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
  __basher_selection: {
    getState: () => { primaryNodeId: string | null; select: (id: string) => void };
  };
  __basher_gltf_skin?: () => {
    count: number;
    vertex: (i: number) => [number, number, number];
  } | null;
  __basher_three: {
    getState: () => {
      camera: {
        position: { set: (x: number, y: number, z: number) => void };
        projectionMatrix: { elements: number[] };
        matrixWorldInverse: { elements: number[] };
      };
      controlsTarget: { set: (x: number, y: number, z: number) => void } | null;
    };
  };
}

const CARRY = 3;

const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

/** The middle of the mesh as it is drawn now. */
const drawnCentre = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as W).__basher_gltf_skin!()!;
    const c = [0, 0, 0];
    for (let i = 0; i < s.count; i++) s.vertex(i).forEach((v, k) => (c[k] += v / s.count));
    return c as [number, number, number];
  });

async function clickWorld(page: Page, at: [number, number, number]) {
  const box = (await page.locator('canvas').first().boundingBox())!;
  const d = await page.evaluate(() => {
    const cam = (window as unknown as W).__basher_three.getState().camera;
    return { proj: [...cam.projectionMatrix.elements], view: [...cam.matrixWorldInverse.elements] };
  });
  const ndc = new THREE.Vector3(...at).applyMatrix4(
    new THREE.Matrix4().multiplyMatrices(
      new THREE.Matrix4().fromArray(d.proj),
      new THREE.Matrix4().fromArray(d.view),
    ),
  );
  await page.mouse.click(
    box.x + ((ndc.x + 1) / 2) * box.width,
    box.y + ((1 - ndc.y) / 2) * box.height,
  );
}

const selected = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_selection.getState().primaryNodeId);

for (const asset of ['skinned-bar.glb', 'skinned-many-influences.glb']) {
  test(`#1610 — ${asset}: carried away by its root bone, the character is still picked by a click`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
    // This spec writes the camera by hand: wait out the boot view fit, which would land after.
    await settleViewFit(page);
    await page.waitForFunction(() =>
      Boolean((window as unknown as W).__basher_three?.getState().controlsTarget),
    );
    const rig = await page.evaluate(async (file) => {
      const w = window as unknown as W;
      const native = await import('/src/core/import/nativeGltfImport.ts');
      const d = await import('/src/app/animate/dispatchMutator.ts');
      const buffer = await fetch(`/assets/${file}`).then((r) => r.arrayBuffer());
      const dag = w.__basher_dag.getState();
      const result = await native.buildNativeGltfImportOps({
        buffer,
        assetRef: `user-imports/p1610/${file}`,
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
      const root = (bones.find(
        (b) => b.parent === undefined || b.parent === null || b.parent < 0,
      ) ?? bones[0])!.name;
      // The bones are drawn through the body and pick in front of it; this is about the skin, and
      // the starter cube stands where the character does.
      for (const id of [armature, 'n_box']) {
        const r = d.dispatchMutatorFromUI(
          'mutator.setHidden',
          { targetSelectors: [id], hidden: true },
          'hide',
        );
        if (!r.ok) throw new Error(JSON.stringify(r));
      }
      return { armature, root };
    }, asset);

    await expect
      .poll(() => page.evaluate(() => Boolean((window as unknown as W).__basher_gltf_skin?.())), {
        message: 'the character is drawn skinned',
        timeout: 15_000,
      })
      .toBe(true);
    await frames(page);
    const rest = await drawnCentre(page);

    // Framed on the span between where it stands and where it will be carried, well above the
    // panels docked along the bottom.
    await expect
      .poll(async () => {
        await page.evaluate(
          ([x, y]) => {
            const t = (window as unknown as W).__basher_three.getState();
            t.controlsTarget!.set(x, y - 2, 0);
            t.camera.position.set(x, y - 2, 12);
          },
          [rest[0] + CARRY / 2, rest[1]],
        );
        await page.waitForTimeout(250);
        return page.evaluate(() => {
          const e = (window as unknown as W).__basher_three.getState().camera.matrixWorldInverse
            .elements;
          return Math.round(e[14] * 100) / 100;
        });
      })
      .toBe(-12);

    // The first click measures the bounds around the character where it stands.
    await clickWorld(page, rest);
    await expect.poll(() => selected(page)).not.toBeNull();
    const character = (await selected(page))!;
    expect(character, 'the click picked the skin, not the armature').not.toBe(rig.armature);

    // Carry it away by its root bone: the Object stays, the drawn skin goes.
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
    await expect
      .poll(async () => {
        await frames(page);
        const c = await drawnCentre(page);
        return Math.hypot(c[0] - rest[0], c[1] - rest[1], c[2] - rest[2]);
      })
      .toBeGreaterThan(2);
    const moved = await drawnCentre(page);

    // Nothing of the character is selected, then a click where it is drawn now.
    await page.evaluate(() =>
      (window as unknown as W).__basher_selection.getState().select('n_camera'),
    );
    await clickWorld(page, moved);
    await expect.poll(() => selected(page)).toBe(character);
  });
}
