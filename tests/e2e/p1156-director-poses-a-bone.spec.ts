// #1156 — THE DIRECTOR'S ROAD INTO THE POSE LANE.
//
// `poseBone` could be reached by an agent and by nobody else: every reference to it outside
// `src/agent/` was a comment. A director could click a bone, see it highlighted and read its
// chain, and had no way to pose it. This row drives the gesture that closes that — click a
// bone in the viewport, then use the inspector.
//
// IT GOES THROUGH THE MUTATOR, and that is the property worth pinning: the panel does not
// mint a `PoseOverride` itself. One road in means the agent and the director cannot drift
// about what a hand-pose is, and the panel inherits the mutator's refusals for free.
//
// WHAT THIS ROW DOES NOT COVER: that a posed bone moves on screen. That is
// `p993-pose-lane-moves-a-bone.spec.ts`, driven through the mutator seam. This row is about
// reachability — who can ask — and says so rather than asserting both badly.
//
// The PICK is covered by `bone-selection.spec.ts`; it is setup here, not the subject.

// Clicking a bone selects it, highlights it, and names it (#973).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY A HEADED SPEC, AND WHY IT AIMS RATHER THAN GUESSES
// ─────────────────────────────────────────────────────────────────────────
// Every part of this is unit-tested — the instance arithmetic, the gate, the
// selection resolver — and none of that can say a director can click a bone.
// The path runs through R3F's raycaster, the depth order of a skinned mesh drawn
// in front of the bones, and the pick gate; the first live run of it produced
// SIX clicks that each selected a glTF mesh part while the helper's handler
// never fired once. So the consumer is the only place this can be asserted, as
// #973 says in as many words.
//
// The clicks are AIMED, not scattered. An octahedron is a sliver a few pixels
// wide at a normal framing, so clicking near a bone hits it about one time in
// eighteen — which reads as "picking is broken" and is really "the probe cannot
// hit what it is aiming at". The helper publishes every drawn bone's matrix, so
// the target is computed: the instance translation is the bone's HEAD and the
// matrix's second column is head→tail, so the midpoint is the fattest part of
// the shape. Longest bone first, because if the biggest target on screen cannot
// be clicked then the feature is broken rather than the aim.
//
// THE TRACKED PAIR ONLY. `standin-character.glb` carries the same structure as
// the vendor rig in 10 KB (#850) — a spec that needs an untracked 58 MB asset is
// a spec that skips on every runner.

import { test, expect } from './_fixtures';
import * as THREE from 'three';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GLB = 'public/fixtures/rig/standin-character.glb';
const ASSET_REF = 'fixtures/rig/standin-character.glb';

interface Win {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
    };
  };
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_importGltf?: (buffer: ArrayBuffer, assetRef: string) => Promise<unknown>;
  __basher_gltf_skin?: () => { boneCount: number; bound: boolean } | null;
  __basher_armature?: {
    bones: number;
    names: string[];
    matrices: number[][];
    highlightedBone: string | null;
  };
  __basher_bone?: { getState: () => { boneName: string | null; chain: string[] } };
  __basher_three: {
    getState: () => {
      camera: {
        position: { set: (x: number, y: number, z: number) => void };
        projectionMatrix: { elements: number[] };
        matrixWorldInverse: { elements: number[] };
      };
      controlsTarget: { set: (x: number, y: number, z: number) => void };
    };
  };
}

test('#1156 — a director poses the bone they clicked, through the same road the agent uses', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => Boolean((window as unknown as Win).__basher_importGltf), null, {
    timeout: 60_000,
  });

  const glb = fs.readFileSync(path.join(ROOT, GLB));
  await page.evaluate(
    async ([bytes, ref]) => {
      const w = window as unknown as Win;
      const arr = new Uint8Array(bytes as number[]);
      await w.__basher_writeOpfsBytes!(ref as string, arr);
      await w.__basher_importGltf!(arr.buffer as ArrayBuffer, ref as string);
    },
    [Array.from(glb), ASSET_REF] as [number[], string],
  );
  await page.waitForFunction(
    () => Boolean((window as unknown as Win).__basher_gltf_skin?.()),
    null,
    { timeout: 120_000 },
  );

  // A walk bound to the character: without a RetargetClip there is no pose chain, and the
  // control is right to offer nothing.
  await page.evaluate(async () => {
    const w = window as unknown as Win & {
      __basher_ingestBvhFile?: (b: Uint8Array, n: string) => Promise<string>;
    };
    const bytes = new Uint8Array(await (await fetch('/fixtures/anim/soma-walk.bvh')).arrayBuffer());
    await w.__basher_ingestBvhFile!(bytes, 'soma-walk');
  });
  await page.waitForTimeout(800);

  await page.evaluate(() => {
    const t = (window as unknown as Win).__basher_three.getState();
    t.controlsTarget.set(0, 0.9, 0);
    t.camera.position.set(0, 0.9, 3.0);
  });
  await page.waitForTimeout(900);

  const box = await page.locator('canvas').first().boundingBox();
  const drawn = await page.evaluate(() => {
    const w = window as unknown as Win;
    const a = w.__basher_armature;
    const cam = w.__basher_three.getState().camera;
    return {
      names: a?.names ?? [],
      matrices: a?.matrices ?? [],
      proj: [...cam.projectionMatrix.elements],
      view: [...cam.matrixWorldInverse.elements],
    };
  });
  const viewProj = new THREE.Matrix4().multiplyMatrices(
    new THREE.Matrix4().fromArray(drawn.proj),
    new THREE.Matrix4().fromArray(drawn.view),
  );
  const targets = drawn.names
    .map((name, i) => {
      const e = drawn.matrices[i];
      const head = new THREE.Vector3(e[12], e[13], e[14]);
      const axis = new THREE.Vector3(e[4], e[5], e[6]);
      const ndc = head.clone().add(axis.clone().multiplyScalar(0.5)).applyMatrix4(viewProj);
      return {
        name,
        length: axis.length(),
        onScreen: Math.abs(ndc.x) < 0.95 && Math.abs(ndc.y) < 0.95,
        x: box!.x + ((ndc.x + 1) / 2) * box!.width,
        y: box!.y + ((1 - ndc.y) / 2) * box!.height,
      };
    })
    .filter((t) => t.onScreen && t.name !== 'Root')
    .sort((a, b) => b.length - a.length);

  const groupId = await page.evaluate(() => {
    const nodes = (window as unknown as Win).__basher_dag.getState().state.nodes;
    return Object.entries(nodes).find(([, n]) => n.type === 'Group')?.[0] ?? null;
  });
  await page.getByTestId(`scene-tree-row-${groupId}`).click();
  await page.waitForTimeout(300);

  let picked: string | null = null;
  for (const t of targets.slice(0, 8)) {
    await page.mouse.click(t.x, t.y);
    await page.waitForTimeout(250);
    picked = await page.evaluate(
      () => (window as unknown as Win).__basher_bone?.getState().boneName ?? null,
    );
    if (picked) break;
  }
  expect(picked, 'no bone could be clicked — nothing below would mean anything').not.toBeNull();

  // THE OFFER. The control appears for a clicked bone on a rig a retarget drives; it is the
  // write half of a section that until now only read.
  await expect(page.getByTestId('inspector-bone-pose-add')).toBeVisible();
  await page.getByTestId('inspector-bone-pose-add').click();
  await page.waitForTimeout(400);

  const after = await page.evaluate(() => {
    const nodes = (window as unknown as Win).__basher_dag.getState().state.nodes;
    return Object.entries(nodes)
      .filter(([, n]) => n.type === 'PoseOverride')
      .map(([id, n]) => ({ id, params: n.params }));
  });
  // THE MINT, in the RIG's spelling. The click carries the live tree's name
  // (`mixamorigLeftUpLeg`); what lands is the DAG's (`mixamorig_LeftUpLeg`). Storing the
  // clicked spelling would be a bone the rig does not have, and the band would skip it
  // silently — so the spelling IS the assertion, not a detail.
  expect(after.length, 'the gesture minted no override').toBe(1);
  expect(after[0].params.bone).toBe(`mixamorig_${picked!.replace('mixamorig', '')}`);
  expect(
    (after[0].params.overridden as { rotation?: boolean }).rotation,
    'the override authors nothing, so it is inert and the band will ignore it',
  ).toBe(true);
  // Seeded at zero: asking for an override must not itself move the rig.
  expect(after[0].params.rotation).toEqual([0, 0, 0]);

  // And the offer is replaced by the thing it made — the ordinary param row, so editing a
  // pose is the same gesture as editing any other value.
  await expect(page.getByTestId('inspector-bone-pose')).toBeVisible();
  await expect(page.getByTestId('inspector-bone-pose-add')).toHaveCount(0);
});
