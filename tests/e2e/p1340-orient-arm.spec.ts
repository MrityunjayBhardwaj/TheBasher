// #1340 — orient the example character's left arm from the Edit-mode panel, and the drawn bones'
// axes match the rule: each joint's +Y aims at its child's head, and its +X is Y × Z with +Z the
// world +Z made perpendicular to that aim. The heads do not move.
//
// The character is the tracked stand-in (`standin-character.glb`, the vendor rig's structure in
// 10 KB), imported through the product's import. The drawn bone's +Y runs head→tail and its roll
// is the joint's own X made perpendicular to that (`boneShape.ts` placeBones), so after an orient
// the drawn +X column must equal the joint's +X.

import type { Page } from '@playwright/test';
import * as THREE from 'three';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './_fixtures';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GLB = 'public/fixtures/rig/standin-character.glb';

interface W {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { type: string; inputs?: Record<string, { node?: string }> }>;
      };
    };
  };
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_armature?: { names: string[]; matrices: number[][] };
}

const ARM = ['mixamorig_LeftArm', 'mixamorig_LeftForeArm'];

async function frames(page: Page) {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return page.evaluate(() => {
    const a = (window as unknown as W).__basher_armature!;
    return { names: a.names, matrices: a.matrices };
  });
}

test('#1340 — orienting the left arm from the panel aims each joint at its child and rolls +Z to world +Z', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(
    () => Boolean((window as unknown as W).__basher_ingestGltfFolder),
    null,
    {
      timeout: 60_000,
    },
  );
  const glb = fs.readFileSync(path.join(ROOT, GLB));
  await page.evaluate(
    async ([bytes]) => {
      await (window as unknown as W).__basher_ingestGltfFolder!(
        [{ relativePath: 'standin-character.glb', bytes: new Uint8Array(bytes as number[]) }],
        'standin-character',
      );
    },
    [Array.from(glb)] as [number[]],
  );
  await expect
    .poll(async () => (await frames(page)).names.length, { timeout: 120_000 })
    .toBeGreaterThan(10);

  const armature = await page.evaluate(() => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    return Object.values(nodes).find((n) => n.type === 'ArmatureModifier')!.inputs!.armature!.node!;
  });
  await page.getByTestId(`scene-tree-row-${armature}`).click();
  await page.getByTestId('armature-mode').selectOption('edit');
  await page.evaluate(
    async ({ id, bone }) => {
      const b = await import('/src/app/stores/boneSelectionStore.ts');
      b.useBoneSelectionStore.getState().selectBone(id, bone, [bone]);
    },
    { id: armature, bone: ARM[0] },
  );
  await expect(page.getByTestId('edit-bone')).toBeVisible();

  const before = await frames(page);
  const heads = (f: typeof before) =>
    new Map(
      f.names.map((n, i) => [
        n,
        new THREE.Vector3(f.matrices[i][12], f.matrices[i][13], f.matrices[i][14]),
      ]),
    );
  const was = heads(before);

  // The rule must not already hold, or the assertions below prove nothing.
  const aligned = (f: typeof before, name: string) => {
    const hs = heads(f);
    const i = f.names.indexOf(name);
    const m = new THREE.Matrix4().fromArray(f.matrices[i]);
    const child = name === ARM[0] ? ARM[1] : 'mixamorig_LeftHand';
    const aim = hs.get(child)!.clone().sub(hs.get(name)!).normalize();
    const z = new THREE.Vector3(0, 0, 1).sub(aim.clone().multiplyScalar(aim.z)).normalize();
    return new THREE.Vector3()
      .setFromMatrixColumn(m, 0)
      .normalize()
      .dot(new THREE.Vector3().crossVectors(aim, z));
  };
  expect(
    Math.min(...ARM.map((n) => aligned(before, n))),
    'the arm is not already oriented',
  ).toBeLessThan(0.99);

  await page.getByTestId('edit-bone-orient-up').selectOption('global+Z');
  await page.getByTestId('edit-bone-orient-chain').check();
  await page.getByTestId('edit-bone-orient').click();
  await expect(page.getByTestId('edit-bone-refusal')).toHaveCount(0);

  const after = await frames(page);
  const now = heads(after);
  for (const [name, h] of was)
    expect(h.distanceTo(now.get(name)!), `${name} head moved`).toBeLessThan(1e-4);

  for (const name of ARM) {
    const i = after.names.indexOf(name);
    const m = new THREE.Matrix4().fromArray(after.matrices[i]);
    const y = new THREE.Vector3().setFromMatrixColumn(m, 1).normalize();
    const x = new THREE.Vector3().setFromMatrixColumn(m, 0).normalize();
    // The bone's child in this arm is the next name; its head is where +Y must aim.
    const child = name === ARM[0] ? ARM[1] : 'mixamorig_LeftHand';
    const aim = now.get(child)!.clone().sub(now.get(name)!).normalize();
    expect(y.dot(aim), `${name} +Y aims at ${child}`).toBeGreaterThan(0.9999);
    const z = new THREE.Vector3(0, 0, 1).sub(aim.clone().multiplyScalar(aim.z)).normalize();
    const wantX = new THREE.Vector3().crossVectors(aim, z);
    expect(x.dot(wantX), `${name} +X is Y × Z`).toBeGreaterThan(0.9999);
  }
});
