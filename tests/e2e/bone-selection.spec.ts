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
  __basher_dag: { getState: () => { state: { nodes: Record<string, { type: string }> } } };
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

test('clicking a bone selects it, highlights it, and names it in the inspector', async ({
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
    {
      timeout: 120_000,
    },
  );

  // Frame the character head-on. Aimed through the store's own handle: it
  // exposes `controlsTarget`, never `controls`, and optional-chaining the
  // difference away turns a missing seam into a silent no-op.
  await page.evaluate(() => {
    const t = (window as unknown as Win).__basher_three.getState();
    t.controlsTarget.set(0, 0.9, 0);
    t.camera.position.set(0, 0.9, 3.0);
  });
  await page.waitForTimeout(900);

  const box = await page.locator('canvas').first().boundingBox();
  expect(box, 'no canvas to click').not.toBeNull();

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
  expect(drawn.names.length, 'the helper drew no bones — nothing to click').toBeGreaterThan(10);

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
    // The transport node is excluded: it is a connector from the world origin
    // to the pelvis rather than anatomy, so its midpoint is usually off the
    // character entirely — an aim that misses is indistinguishable here from a
    // pick that does not work.
    .filter((t) => t.onScreen && t.name !== 'Root')
    .sort((a, b) => b.length - a.length);
  expect(targets.length, 'no bone is on screen at this framing').toBeGreaterThan(5);

  // THE GATE. Bones are pickable only once the character is the thing being
  // worked on — Blender's rule, where a click reaches a bone only after its
  // armature is the active object. So the first click selects the character and
  // must NOT select a bone; that ordering is the assertion, not a preamble.
  // The character is selected from the OUTLINER, not by clicking the viewport.
  // Clicking pixels to select it is what the gate is about, and using it here
  // would make the setup depend on the thing under test; it is also unreliable
  // on this fixture, whose stand-in mesh is small and sits inside the default
  // cube — the first version of this spec clicked the canvas centre, selected
  // `n_box`, and read as "picking does not work".
  const groupId = await page.evaluate(() => {
    const nodes = (window as unknown as Win).__basher_dag.getState().state.nodes;
    return Object.entries(nodes).find(([, n]) => n.type === 'Group')?.[0] ?? null;
  });
  expect(groupId, 'the import minted no Group to select').not.toBeNull();
  await page.getByTestId(`scene-tree-row-${groupId}`).click();
  await page.waitForTimeout(300);
  const beforeGate = await page.evaluate(
    () => (window as unknown as Win).__basher_bone?.getState().boneName ?? null,
  );
  expect(
    beforeGate,
    'a bone was selected before the character was — the pick gate is open when nothing is selected, ' +
      'so a click anywhere over a rigged character now takes the bone instead of the object',
  ).toBeNull();

  let picked: { name: string | null; chain: string[] } = { name: null, chain: [] };
  for (const t of targets.slice(0, 8)) {
    await page.mouse.click(t.x, t.y);
    await page.waitForTimeout(250);
    picked = await page.evaluate(() => {
      const s = (window as unknown as Win).__basher_bone?.getState();
      return { name: s?.boneName ?? null, chain: s?.chain ?? [] };
    });
    if (picked.name) break;
  }

  expect(
    picked.name,
    `eight aimed clicks selected no bone. Targets tried: ${targets
      .slice(0, 8)
      .map((t) => t.name)
      .join(', ')}`,
  ).not.toBeNull();

  // The CHAIN is what makes a bone name mean anything, and it is also the part
  // that a wrong instance→bone mapping would get wrong while still returning a
  // real name.
  expect(
    picked.chain.length,
    'a bone with no ancestry says nothing about where it is',
  ).toBeGreaterThan(1);
  expect(picked.chain[picked.chain.length - 1]).toBe(picked.name);

  // THE HIGHLIGHT, read from the helper rather than from the picture: a colour
  // buffer written for the wrong instance is invisible to every other assertion
  // here, and it is the one thing a director actually looks at.
  const highlighted = await page.evaluate(
    () => (window as unknown as Win).__basher_armature?.highlightedBone ?? null,
  );
  expect(
    highlighted,
    `the inspector names ${picked.name} and the helper is painting ${highlighted} — the highlight ` +
      `and the panel are answering the same question differently`,
  ).toBe(picked.name);

  // ...and the inspector, which is where the answer is read.
  await expect(page.getByTestId('inspector-selected-bone')).toBeVisible();
  await expect(page.getByTestId('inspector-selected-bone-name')).toHaveText(picked.name as string);

  // Selecting something ELSE must retire the bone selection rather than leave a
  // highlight on a rig the director has navigated away from. Done through the
  // outliner, because "click empty space" is not deselection here — the first
  // version of this row assumed it was and failed on an assumption about the
  // app rather than on the behaviour under test.
  // Whichever other row the outliner is actually showing — the node's TYPE is
  // not the point, "not this character" is, and asking the DAG for a type that
  // has no row is how this row first hung.
  const rows = page.locator('[data-testid^="scene-tree-row-"]');
  const ids = await rows.evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-testid') ?? ''),
  );
  const other = ids.find((id) => id !== `scene-tree-row-${groupId}` && !id.includes('n_gltf'));
  expect(other, 'the outliner shows nothing but this character').toBeTruthy();
  await page.getByTestId(other as string).click();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('inspector-selected-bone')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as Win).__basher_armature?.highlightedBone ?? null,
    ),
    'the helper is still painting a bone of a rig that is no longer selected',
  ).toBeNull();
});
