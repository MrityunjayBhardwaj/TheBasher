// #993 — THE POSE LANE, DRIVEN END TO END AND WATCHED.
//
// `PoseOverride` shipped complete — registered, typed, evaluated, consumed by the band — and for
// a while nothing could create one. `poseBone` is the author that closed that half. What was
// still missing is the half this row is: the lane had unit coverage and NOBODY HAD EVER SEEN A
// BONE MOVE. The issue says so in as many words — "the current evidence stops at the resolver".
//
// A lane that is green in units and unobserved in the app is exactly where this project keeps
// finding defects, so the evidence this row carries is deliberately the drawn bones: the live
// `Bone` matrices the armature band reads, not the DAG params the mutator wrote. Params say what
// was asked for; the matrices say what happened.
//
// It drives the real five-gate mutator road (`__basher_dispatchMutator`), the same entry an agent
// uses. There is no director gesture yet — that is the remaining half of #993 — so this row
// cannot pretend to cover one.
//
// 🔴 WHICH ROAD TO FALSIFY THIS AGAINST — MEASURED THE HARD WAY. Making
// `PoseOverride.evaluate` completely inert does NOT red this row, and does not change a pixel:
// the render reads an override PARAMS-SIDE through `poseBandForAsset` (`bakedGltfChannels.ts`),
// the same way the clip band reads clips. `evaluate` is the graph-facing lane for nodes that
// consume a pose; the two agree because both read the same authored numbers, and that agreement
// is pinned separately in `poseBone.test.ts`. So a mutation aimed at `evaluate` proves nothing
// here — falsify against the band. Dropping the band's authored-rotation branch empties the
// moved set, which is what red looks like.
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
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_importGltf?: (buffer: ArrayBuffer, assetRef: string) => Promise<unknown>;
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
        w.__basher_importGltf &&
        w.__basher_writeOpfsBytes &&
        w.__basher_dispatchMutator,
      );
    },
    undefined,
    { timeout: 60_000 },
  );

  await page.evaluate(async () => {
    const w = window as unknown as W;
    const ref = 'fixtures/rig/standin-character.glb';
    const buf = await (await fetch(`/${ref}`)).arrayBuffer();
    await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
    await w.__basher_importGltf!(buf, ref);
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

  // The RetargetClip the bind created — poseBone's required node type.
  const rt = await page.evaluate(() => {
    const { nodes } = (window as unknown as W).__basher_dag.getState().state;
    return Object.keys(nodes).find((id) => nodes[id].type === 'RetargetClip') ?? null;
  });
  expect(rt, 'the bind stood no RetargetClip — nothing below would mean anything').not.toBeNull();

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
        { retarget: id, bone, rotation: [0, 0, 75] },
        'observe: hand-pose one bone',
      ),
    [rt, boneName] as [string, string],
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
  ).toEqual(['mixamorigLeftArm', 'mixamorigLeftForeArm', 'mixamorigLeftHand']);

  // And the authored override is on the graph, in the RIG's spelling rather than the live
  // scene's. The mutator is handed `mixamorigLeftArm` above and stores `mixamorig_LeftArm`;
  // those are two sanitisations of one glTF name, and storing the wrong one is a stored bone
  // nobody has.
  const poseNodes = await page.evaluate(() => {
    const { nodes } = (window as unknown as W).__basher_dag.getState().state;
    return Object.keys(nodes)
      .filter((id) => nodes[id].type === 'PoseOverride')
      .map((id) => nodes[id].params as { bone?: string; rotation?: number[] });
  });
  expect(poseNodes.length, 'the mutator reported ok but minted no PoseOverride').toBe(1);
  expect(poseNodes[0].bone).toBe('mixamorig_LeftArm');
  expect(poseNodes[0].rotation).toEqual([0, 0, 75]);
});
