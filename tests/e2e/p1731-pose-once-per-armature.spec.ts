// #1731 (4.3) — each armature's pose is sampled once per frame, however many things read it.
//
// An armature's pose is read every frame by the mesh it deforms, by an Object parented to one of
// its bones, and by the armature helper that draws it. Each used to call the pose's sampler
// itself, running the character's whole layer stack once per reader per frame. They now share
// one sample per pose value per time (`src/nodes/poseSample.ts`).
//
// Fixture: the native-character file p1205 uses (`skinned-bar.glb`, skinned and keyed), ingested
// twice — two armatures — and a sphere parented to the first armature's last bone (the one the file animates). Read over
// FRAMES frames of playback: how often a pose was asked for (what the readers sampled before) and
// how often the sampler ran (what they sample now), from the module's own counters.

import { readFileSync } from 'node:fs';
import { test, expect } from './_fixtures';

const FRAMES = 60;

interface Node {
  type: string;
  params: Record<string, unknown>;
  inputs?: Record<string, { node: string } | { node: string }[] | undefined>;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, Node> };
      dispatchAtomic: (ops: unknown[], source?: string, description?: string) => unknown;
    };
  };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_time: {
    getState: () => { play: () => void; pause: () => void; setTime: (s: number) => void };
  };
  __basher_mesh_world_position: (id: string) => [number, number, number] | null;
}

test('#1731 an armature is posed once per frame, whoever reads it', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(w.__basher_ingestGltfFolder && w.__basher_time && w.__basher_dag);
  });
  const bytes = [...readFileSync('public/assets/skinned-bar.glb')];
  for (const folder of ['p1731-a', 'p1731-b']) {
    await page.evaluate(
      ({ b, folder }) =>
        (window as unknown as W).__basher_ingestGltfFolder(
          [{ relativePath: 'skinned-bar.glb', bytes: new Uint8Array(b) }],
          folder,
        ),
      { b: bytes, folder },
    );
  }
  const armatures = await page.waitForFunction(() => {
    const { nodes } = (window as unknown as W).__basher_dag.getState().state;
    const ids = Object.keys(nodes).filter((id) => nodes[id].type === 'ArmatureModifier');
    const arms = ids
      .map((id) => (nodes[id].inputs?.armature as { node: string } | undefined)?.node)
      .filter((x): x is string => typeof x === 'string');
    return arms.length === 2 ? arms : null;
  });
  const [armA] = (await armatures.jsonValue()) as string[];

  // A sphere parented to armature A's last bone.
  const bone = await page.evaluate((armA) => {
    const w = window as unknown as W;
    const { nodes } = w.__basher_dag.getState().state;
    const skel = (nodes[armA].inputs?.data as { node: string } | undefined)?.node;
    const bones = skel ? (nodes[skel].params.bones as { name: string }[] | undefined) : undefined;
    const name = bones?.[bones.length - 1]?.name ?? null;
    if (!name) return null;
    w.__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'p1731_prop_data',
          nodeType: 'SphereData',
          params: { radius: 0.05, widthSegments: 8, heightSegments: 8 },
        },
        {
          type: 'addNode',
          nodeId: 'p1731_prop',
          nodeType: 'Object',
          // Off the bone's head, which the bone turns about: a prop at the head would not move.
          params: {
            position: [0.3, 0.5, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            parentBone: name,
          },
        },
        {
          type: 'connect',
          from: { node: 'p1731_prop_data', socket: 'out' },
          to: { node: 'p1731_prop', socket: 'data' },
        },
        {
          type: 'connect',
          from: { node: 'p1731_prop', socket: 'out' },
          to: { node: armA, socket: 'children' },
        },
      ],
      'user',
      'p1731 prop on a bone',
    );
    return name;
  }, armA);
  expect(bone, 'armature A has a bone to parent to').not.toBeNull();
  await page.waitForFunction(
    () => (window as unknown as W).__basher_mesh_world_position('p1731_prop') !== null,
  );

  const r = await page.evaluate(async (frames) => {
    const w = window as unknown as W;
    // A path the dev server serves, not one TypeScript resolves.
    const url = '/src/nodes/poseSample.ts';
    const mod = (await import(/* @vite-ignore */ url)) as {
      poseSampleCounts: () => { asked: number; sampled: number };
    };
    const t = w.__basher_time.getState();
    t.setTime(0);
    t.play();
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const before = mod.poseSampleCounts();
    const p0 = w.__basher_mesh_world_position('p1731_prop');
    for (let i = 0; i < frames; i++)
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const after = mod.poseSampleCounts();
    const p1 = w.__basher_mesh_world_position('p1731_prop');
    t.pause();
    return {
      asked: after.asked - before.asked,
      sampled: after.sampled - before.sampled,
      moved: p0 && p1 ? Math.max(...p0.map((v, i) => Math.abs(v - p1[i]))) : -1,
    };
  }, FRAMES);
  console.log(
    `[p1731 pose] ${FRAMES} frames, 2 armatures, a prop on a bone: ` +
      `${r.asked} pose reads (${(r.asked / FRAMES).toFixed(2)}/frame, each one a sample before), ` +
      `${r.sampled} samples (${(r.sampled / FRAMES).toFixed(2)}/frame); the prop moved ${r.moved.toFixed(3)}`,
  );
  // The readers still read: more than one per armature per frame.
  expect(r.asked / FRAMES, 'readers per frame').toBeGreaterThan(2);
  // Once per armature per frame, at most (a frame the playhead did not move samples nothing).
  expect(r.sampled / FRAMES, 'samples per frame').toBeLessThanOrEqual(2);
  expect(r.sampled, 'the poses were sampled at all').toBeGreaterThan(FRAMES / 2);
  // The prop rode its bone.
  expect(r.moved, 'the prop on the bone moved with playback').toBeGreaterThan(0);
});
