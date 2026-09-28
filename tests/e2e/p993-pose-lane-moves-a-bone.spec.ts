// #993 — THE POSE LANE, DRIVEN END TO END AND WATCHED.
//
// `PoseOverride` shipped complete — registered, typed, evaluated, consumed by the band — and for
// a while nothing could create one. `poseBone` is the author that closed that half. What was
// still missing is the half this row is: the lane had unit coverage and NOBODY HAD EVER SEEN A
// BONE MOVE. The issue says so in as many words — "the current evidence stops at the resolver".
//
// A lane that is green in units and unobserved in the app is exactly where this project keeps
// finding defects, so the evidence this row carries is deliberately the drawn bones: the matrices
// the armature band draws, not the DAG params the mutator wrote. Params say what was asked for;
// the matrices say what happened.
//
// It drives the real five-gate mutator road (`__basher_dispatchMutator`), the same entry an agent
// and the inspector's "pose this bone" use.
//
// 🔴 WHICH ROAD TO FALSIFY THIS AGAINST (measured 2026-09-26, #1205): the hand-pose layer's write
// (`handPoseOps` in `poseBone.ts`). Writing the member's rotation as zero there reds this row; the
// clone road's params-side band (`poseBandForAsset`) is no longer on this road at all.
//
// THE ROAD (#1205): the character comes in through the product's import, so it is a native
// character — a skeleton Object posed through its pose layers — and the pose is anchored on that
// armature Object (`poseBone {object}`), the verb the inspector's "pose this bone" calls.
//
// WHAT MAKES IT DISCRIMINATING: a rotation on one bone must carry its DESCENDANTS and nothing
// else. Asserting only "the posed bone moved" would pass on an override that moved the whole rig,
// which is the failure a scoped override exists to prevent.

import { test, expect } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<
          string,
          { type: string; inputs: Record<string, unknown>; params?: Record<string, unknown> }
        >;
      };
    };
  };
  __basher_dispatchMutator?: (
    name: string,
    spec: unknown,
    intent: string,
  ) => { ok: true } | { ok: false; reason: string };
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_gltf_skin?: () => unknown;
  __basher_ingestBvhFile?: (bytes: Uint8Array, name: string) => Promise<string>;
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_armature?: { bones: number; names: string[]; matrices: number[][] };
}

test('#993 — a hand-posed bone moves on screen, and takes its chain and nothing else', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* absent */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const w = window as unknown as W;
      return Boolean(
        w.__basher_dag &&
        w.__basher_ingestBvhFile &&
        w.__basher_ingestGltfFolder &&
        w.__basher_dispatchMutator,
      );
    },
    undefined,
    { timeout: 60_000 },
  );

  await page.evaluate(async () => {
    const w = window as unknown as W;
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
      const w = window as unknown as W;
      return Boolean(w.__basher_gltf_skin && w.__basher_gltf_skin() !== null);
    },
    undefined,
    { timeout: 120_000 },
  );

  await page.evaluate(async () => {
    const w = window as unknown as W;
    w.__basher_time.getState().setTime(0.5);
    const bytes = new Uint8Array(await (await fetch('/fixtures/anim/soma-walk.bvh')).arrayBuffer());
    await w.__basher_ingestBvhFile!(bytes, 'soma-walk');
  });

  // The character: the armature Object its mesh's Armature modifier deforms by — poseBone's anchor.
  const character = await page.evaluate(() => {
    const { nodes } = (window as unknown as W).__basher_dag.getState().state;
    const mod = Object.values(nodes).find((n) => n.type === 'ArmatureModifier');
    return (mod?.inputs.armature as { node?: string } | undefined)?.node ?? null;
  });
  expect(character, 'no Armature modifier — the character is not native').not.toBeNull();
  expect(
    await page.evaluate(() =>
      Object.values((window as unknown as W).__basher_dag.getState().state.nodes).some(
        (n) => n.type === 'RetargetClip',
      ),
    ),
    'the bind stood no RetargetClip — the walk is not on the character',
  ).toBe(true);

  const before = await page.evaluate(() => {
    const a = (window as unknown as W).__basher_armature;
    return a
      ? { bones: a.bones, names: a.names.slice(), matrices: a.matrices.map((m) => [...m]) }
      : null;
  });
  const boneName = before!.names.find((n) => /leftarm/i.test(n)) ?? before!.names[3];

  const res = await page.evaluate(
    ([id, bone]) =>
      (window as unknown as W).__basher_dispatchMutator!(
        'mutator.animate.poseBone',
        { object: id, bone, rotation: [0, 0, 75] },
        'observe: hand-pose one bone',
      ),
    [character, boneName] as [string, string],
  );
  expect(res.ok, res.ok ? '' : `poseBone refused: ${res.reason}`).toBe(true);

  await page.waitForTimeout(600);
  const after = await page.evaluate(() => {
    const a = (window as unknown as W).__basher_armature;
    return a
      ? { bones: a.bones, names: a.names.slice(), matrices: a.matrices.map((m) => [...m]) }
      : null;
  });

  // WHICH DRAWN BONES MOVED. Read off the matrices the band draws, compared component-wise.
  const moved: string[] = [];
  for (let i = 0; i < Math.min(before!.matrices.length, after!.matrices.length); i++) {
    const d = Math.max(...before!.matrices[i].map((v, k) => Math.abs(v - after!.matrices[i][k])));
    if (d > 1e-4) moved.push(before!.names[i]);
  }

  // The posed bone AND its chain, and nothing else. The forearm and hand are not incidental —
  // they are what says the override rode the hierarchy instead of nudging one matrix; and every
  // other bone holding still is what says it stayed scoped to the bone that was asked for.
  expect(
    moved.slice().sort(),
    `expected the posed arm chain to move and nothing else; moved: ${moved.join(', ')}`,
  ).toEqual(['mixamorig_LeftArm', 'mixamorig_LeftForeArm', 'mixamorig_LeftHand']);

  // And the pose is on the graph where the native verb writes it: the rotation, in the rig's own
  // bone name, in the hand-pose layer feeding the character's armature Object.
  const posed = await page.evaluate(async (id) => {
    const { nodes } = (window as unknown as W).__basher_dag.getState().state;
    const { handPoseLayerOf } = await import('/src/app/animate/poseChain.ts');
    const layer = handPoseLayerOf(nodes as never, id);
    return layer === null ? null : JSON.stringify(nodes[layer].params);
  }, character!);
  expect(
    posed,
    'the mutator reported ok but no hand-pose layer feeds the character',
  ).not.toBeNull();
  expect(posed).toContain('mixamorig_LeftArm');
  expect(posed).toContain('75');
});
