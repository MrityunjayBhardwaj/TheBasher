// #1087 — a bound motion's source rig and its rig Object are two draws of one motion, ON PURPOSE.
//
// With View ▸ Show Source Rig on and the motion's rig Object unhidden, the armature band draws
// the motion twice. Measured before deciding (#1087): the overlay (`SceneFromDAG` → `sourceRigs`)
// is built from retarget pairs and reads no Object; the Object (`collectSkeletonObjects`) draws
// wherever it stands. They answer different questions. The overlay stands the source beside the
// character it drives, at the character's height, to judge the retarget by eye (#977); the
// Object is scene content, drawn where the director put it. Blender keeps a source armature and
// a character both visible the same way.
//
// So neither stands down for the other, and the two options #1087 weighed against this were
// both worse: the overlay drawing the Object would either move scene content for a view toggle
// or draw the Object somewhere its transform does not say, and the overlay stepping aside for a
// visible Object leaves "✓ Show Source Rig" drawing nothing.
//
// What makes two draws acceptable is that they can be told apart and neither follows the other.
// This row pins exactly that: both draw, in different colours, and moving the Object moves its
// bones and not the overlay.
//
// #1148 is pinned here too, and belongs here: this is the state that produces it. The Object's
// bones join the band AFTER the first frame, and until #1148 they kept the white the instance
// colour buffer is allocated with — so the band told the two draws apart with a colour that was
// not the bone colour either. Telling them apart is only worth something if each is the colour
// it claims to be.

import { test, expect } from './_fixtures';

interface DagNode {
  type: string;
  inputs: Record<string, unknown>;
  meta?: { hidden?: boolean };
}
interface Win {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, DagNode> };
      dispatch: (op: unknown) => unknown;
    };
  };
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_gltf_skin?: () => unknown;
  __basher_time: { getState: () => { setTime: (seconds: number) => void } };
  __basher_ingestBvhFile?: (bytes: Uint8Array, name: string) => Promise<string>;
  __basher_armature?: {
    armatures: number;
    bones: number;
    matrices: number[][];
    skeletonObjects: { id: string; bones: number }[];
    sourceBones: number;
    sourceMatrices: number[][];
    boneColors: string[];
    sourceColor: string | null;
  };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* OPFS entry absent on first run */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
});

/** What the band drew this frame: the rig Object's bone translations, the overlay's, and colours.
 *  Skeleton Objects are appended AFTER the live armatures (`ArmatureHelper`, `armatures`), in the
 *  order `skeletonObjects` lists them; since #1205 the character is one of them too. */
function drawn(page: import('@playwright/test').Page, rigId: string) {
  return page.evaluate((rigId) => {
    const a = (window as unknown as Win).__basher_armature;
    if (!a) return null;
    const objectBones = a.skeletonObjects.reduce((n, o) => n + o.bones, 0);
    let start = a.bones - objectBones;
    let object: number[][] = [];
    for (const o of a.skeletonObjects) {
      if (o.id === rigId)
        object = a.matrices.slice(start, start + o.bones).map((m) => [m[12], m[13], m[14]]);
      start += o.bones;
    }
    return {
      armatures: a.armatures,
      skeletonObjects: a.skeletonObjects.map((o) => o.id).sort(),
      sourceBones: a.sourceBones,
      object,
      overlay: a.sourceMatrices.map((m) => [m[12], m[13], m[14]]),
      boneColors: a.boneColors,
      sourceColor: a.sourceColor,
    };
  }, rigId);
}

test('#1087 — the source rig and the unhidden rig Object both draw, told apart, neither following the other', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.waitForFunction(
    () => {
      const w = window as unknown as Win;
      return Boolean(w.__basher_dag && w.__basher_ingestBvhFile && w.__basher_ingestGltfFolder);
    },
    undefined,
    { timeout: 60_000 },
  );
  // A character through the product's import (a native character since #1205: a skeleton Object
  // and a mesh deformed by it), then a walk dropped onto it: the bind hides the walk's rig Object.
  await page.evaluate(async () => {
    const w = window as unknown as Win;
    const bytes = new Uint8Array(
      await (await fetch('/fixtures/rig/standin-character.glb')).arrayBuffer(),
    );
    await w.__basher_ingestGltfFolder!(
      [{ relativePath: 'standin-character.glb', bytes }],
      'standin-character',
    );
  });
  await page.waitForFunction(
    () => {
      const w = window as unknown as Win;
      return Boolean(w.__basher_gltf_skin && w.__basher_gltf_skin() !== null);
    },
    undefined,
    { timeout: 120_000 },
  );
  const ids = await page.evaluate(async () => {
    const w = window as unknown as Win;
    // A fixed playhead: the overlay and the Object are both posed from it, so a pose change
    // cannot pass for a placement change below.
    w.__basher_time.getState().setTime(0.5);
    const bytes = new Uint8Array(await (await fetch('/fixtures/anim/soma-walk.bvh')).arrayBuffer());
    await w.__basher_ingestBvhFile!(bytes, 'soma-walk');
    const { nodes } = w.__basher_dag.getState().state;
    const ref = (v: unknown) => (v as { node?: string } | undefined)?.node ?? '';
    // The character is the armature Object its mesh's Armature modifier deforms by; the walk's rig
    // Object is the other Object standing a Skeleton.
    const character = ref(
      Object.values(nodes).find((n) => n.type === 'ArmatureModifier')?.inputs.armature,
    );
    const rig = Object.keys(nodes).find(
      (id) =>
        id !== character &&
        nodes[id].type === 'Object' &&
        nodes[ref(nodes[id].inputs.data)]?.type === 'Skeleton',
    );
    return { character, rig };
  });
  const objectId = ids.rig;
  const characterId = ids.character;
  expect(characterId, 'no Armature modifier deforms the character — it is not native').not.toBe('');
  expect(
    objectId,
    'the drop stood no rig Object — every reading below would be vacuous',
  ).toBeDefined();
  expect(
    await page.evaluate(
      (id) =>
        (window as unknown as Win).__basher_dag.getState().state.nodes[id].meta?.hidden === true,
      objectId!,
    ),
    'the bind did not hide the rig Object — not the bound shape this row is about',
  ).toBe(true);

  // The director's two gestures: the View menu toggle, and the outliner eye.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('menu-view-toggle-source-rig').click();
  await page.keyboard.press('Escape');
  await page.getByTestId(`scene-tree-eye-${objectId}`).click();

  // BOTH draw: the character plus the Object as armatures, and the overlay's own bones.
  await expect
    .poll(async () => {
      const d = await drawn(page, objectId!);
      return (
        d && { armatures: d.armatures, objects: d.skeletonObjects, overlay: d.sourceBones > 0 }
      );
    })
    .toEqual({ armatures: 2, objects: [characterId, objectId].sort(), overlay: true });

  // TOLD APART: the overlay's colour is none of the colours the armatures are drawn in.
  const before = (await drawn(page, objectId!))!;
  expect(before.sourceColor).not.toBeNull();
  expect(before.boneColors.length).toBeGreaterThan(0);
  expect(before.boneColors).not.toContain(before.sourceColor);

  // #1148 — and the armatures draw in the BONE colour, all of them. The rig Object's bones
  // were appended after the first frame, and the repaint used to run only when the highlight
  // changed, so they stayed at three's `.fill(1)` white and drew brighter than the character
  // beside them. Nothing is selected in this row, so the bone colour is the ONLY colour the
  // band may draw; an unhighlighted band showing two colours is showing one it never chose.
  expect(
    before.boneColors,
    'a rig that joined the band after the first frame was left at the white the instance ' +
      'colour buffer is allocated with, instead of the bone colour',
  ).toEqual(['#c8d4e4']);

  // NEITHER FOLLOWS THE OTHER: move the Object, and only its bones move.
  await page.evaluate(
    (id) =>
      (window as unknown as Win).__basher_dag
        .getState()
        .dispatch({ type: 'setParam', nodeId: id, paramPath: 'position', value: [5, 0, 0] }),
    objectId!,
  );
  await expect
    .poll(async () => {
      const d = (await drawn(page, objectId!))!;
      return Math.round((d.object[1][0] - before.object[1][0]) * 1000) / 1000;
    })
    .toBe(5);
  const after = (await drawn(page, objectId!))!;
  expect(after.overlay.length).toBe(before.overlay.length);
  for (let i = 0; i < before.overlay.length; i++) {
    for (let k = 0; k < 3; k++) expect(after.overlay[i][k]).toBeCloseTo(before.overlay[i][k], 6);
  }

  // And the toggle still owns the overlay alone: off, the overlay goes and the Object stays.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('menu-view-toggle-source-rig').click();
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => {
      const d = (await drawn(page, objectId!))!;
      return { overlay: d.sourceBones, objects: d.skeletonObjects };
    })
    .toEqual({ overlay: 0, objects: [characterId, objectId].sort() });
});
